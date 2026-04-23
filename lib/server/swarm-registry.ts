// Filesystem-backed registry for swarm runs. Runs live under
// `.opencode_swarm/runs/<swarmRunID>/` with two files:
//
//   meta.json      - SwarmRunMeta, written once at createRun()
//   events.ndjson  - one SwarmRunEvent per line, appended by the multiplexer
//
// Design choices (see docs/ARCHITECTURE.md §Tier 2 and SWARM_PATTERNS.md
// §"Backend gap" for the why):
//
// - JSON over SQLite: zero deps, grep-able, survives server restart.
// - One directory per run: easy to tar/rm/rotate; no global index to corrupt.
// - Append-only NDJSON for events: O(1) writes, replayable, naturally ordered.
// - No locking: single Next.js process in dev; fs.appendFile is atomic enough
//   for one-writer-per-file (one multiplexer per run).
//
// This module is server-only — do not import from 'use client' code.

import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';

import { getSessionMessagesServer } from './opencode-server';
import { priceFor } from '../opencode/pricing';
import type {
  OpencodeMessage,
  OpencodeMessageInfo,
} from '../opencode/types';
import type {
  SwarmRunEvent,
  SwarmRunMeta,
  SwarmRunRequest,
  SwarmRunStatus,
} from '../swarm-run-types';

// Override via env for deployments that want runs under a different root
// (e.g. a mounted volume). Defaults to repo-root/.opencode_swarm in dev.
const ROOT =
  process.env.OPENCODE_SWARM_ROOT ??
  path.join(process.cwd(), '.opencode_swarm');

function runDir(swarmRunID: string): string {
  return path.join(ROOT, 'runs', swarmRunID);
}

function metaPath(swarmRunID: string): string {
  return path.join(runDir(swarmRunID), 'meta.json');
}

function eventsPath(swarmRunID: string): string {
  return path.join(runDir(swarmRunID), 'events.ndjson');
}

function eventsGzPath(swarmRunID: string): string {
  return path.join(runDir(swarmRunID), 'events.ndjson.gz');
}

// ---- sessionID → swarmRunID reverse index ---------------------------------
//
// The opencode proxy's cost-cap gate needs to answer "which run owns this
// session?" on every prompt POST. A disk scan per request is wasteful when
// the answer is stable for the life of a run, so we keep a process-local
// Map seeded by createRun() and lazily refilled from disk on miss.
//
// Same survive-restart shape as derivedRowCache below: globalThis-pinned
// so Next.js dev module reloads don't duplicate it, no LRU bound (tens of
// runs at prototype scale), single-worker-only.
const globalIndexKey = Symbol.for('opencode_swarm.sessionIndex');
type GlobalWithIndex = typeof globalThis & {
  [globalIndexKey]?: Map<string, string>;
};
function sessionIndex(): Map<string, string> {
  const g = globalThis as GlobalWithIndex;
  if (!g[globalIndexKey]) g[globalIndexKey] = new Map();
  return g[globalIndexKey]!;
}

// Resolve a session to its owning swarm run. Returns null when the session
// isn't managed by any swarm run — that's the opt-out flow (direct `?session=`
// prompts that bypass swarm bounds by construction; see DESIGN.md §9).
//
// Lazy-population on miss: if the index doesn't know about this session, walk
// every meta.json once and refill. Subsequent misses skip the rescan — a
// sessionID that isn't in any run is a genuine "not swarm-managed" answer.
export async function findRunBySession(
  sessionID: string
): Promise<string | null> {
  const index = sessionIndex();
  const cached = index.get(sessionID);
  if (cached) return cached;
  // Rescan — cheap at tens-of-runs scale (N file reads). A sessionID that
  // still isn't found after rescan is not-swarm-managed; we don't re-rescan
  // for subsequent misses to avoid a per-prompt disk walk on every direct
  // session flow.
  const metas = await listRuns();
  for (const m of metas) {
    for (const sid of m.sessionIDs) index.set(sid, m.swarmRunID);
  }
  return index.get(sessionID) ?? null;
}

// Compact, sortable ID: `run_<time-b36>_<rand-b36>`. Time component sorts
// lexicographically in creation order; random suffix avoids collisions
// across simultaneous creates within the same millisecond.
function mintSwarmRunID(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `run_${t}_${r}`;
}

export async function createRun(
  req: SwarmRunRequest,
  sessionIDs: string[],
  extras: { criticSessionID?: string } = {},
): Promise<SwarmRunMeta> {
  const swarmRunID = mintSwarmRunID();
  const meta: SwarmRunMeta = {
    swarmRunID,
    pattern: req.pattern,
    createdAt: Date.now(),
    workspace: req.workspace,
    sessionIDs,
    source: req.source,
    directive: req.directive,
    title: req.title,
    bounds: req.bounds,
    teamRoles: req.teamRoles,
    criticMaxIterations: req.criticMaxIterations,
    debateMaxRounds: req.debateMaxRounds,
    // enableCriticGate is copied only when truthy so meta stays terse for
    // the default case. criticSessionID is only populated when the extra
    // session spawn succeeded — callers fall back to no-gate behavior
    // when it's absent.
    enableCriticGate: req.enableCriticGate ? true : undefined,
    criticSessionID: extras.criticSessionID,
  };
  await fs.mkdir(runDir(swarmRunID), { recursive: true });
  await fs.writeFile(metaPath(swarmRunID), JSON.stringify(meta, null, 2), 'utf8');
  // Touch events.ndjson so the multiplexer can append without a separate
  // existence check. An empty file is a valid NDJSON (zero records).
  await fs.writeFile(eventsPath(swarmRunID), '', { flag: 'a' });
  // Seed the reverse index so the cost-cap gate resolves this run's
  // sessions without a full disk scan on first prompt.
  for (const sid of sessionIDs) sessionIndex().set(sid, swarmRunID);
  return meta;
}

export async function getRun(swarmRunID: string): Promise<SwarmRunMeta | null> {
  try {
    const raw = await fs.readFile(metaPath(swarmRunID), 'utf8');
    return JSON.parse(raw) as SwarmRunMeta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// Enumerate every run under ROOT/runs by reading each meta.json. Returns
// newest-first by createdAt — that's the order the picker wants, and it
// matches the lexicographic order of the b36 time prefix in swarmRunID, so
// the disk layout is already roughly sorted on its own.
//
// What this skips silently:
//   - directory entries that aren't run dirs (stray files, .DS_Store)
//   - run dirs with missing or malformed meta.json (partial creates, manual
//     edits). A returned list with N-1 entries is better than a throw that
//     hides every valid run because one is broken.
//
// Pagination: not yet. At prototype scale N is small (tens, not thousands).
// When it starts to hurt, the fix is a cursor-based API — the directory
// scan itself is cheap, it's the per-file read that adds up.
export async function listRuns(): Promise<SwarmRunMeta[]> {
  const runsRoot = path.join(ROOT, 'runs');
  let entries: string[];
  try {
    entries = await fs.readdir(runsRoot);
  } catch (err) {
    // No runs have ever been created on this server — the directory hasn't
    // been touched. Return empty rather than throw; callers don't need to
    // distinguish "no runs" from "filesystem error" for the picker.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const metas = await Promise.all(
    entries.map(async (id) => {
      try {
        const raw = await fs.readFile(metaPath(id), 'utf8');
        return JSON.parse(raw) as SwarmRunMeta;
      } catch {
        return null;
      }
    })
  );

  return metas
    .filter((m): m is SwarmRunMeta => m !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

// A turn with no `completed` timestamp that's older than this is treated as
// a zombie: opencode probably crashed mid-turn or the process was killed
// before the assistant could finish. Mirrors the threshold in
// transform.ts's liveness heuristic so the single-session and cross-run
// views agree on what "running" means. See memory note
// "opencode zombie assistant messages" for why this guard exists.
const ZOMBIE_THRESHOLD_MS = 10 * 60 * 1000;

// Cost fallback for assistant messages where opencode didn't populate
// `info.cost` (free tiers, old sessions, go-bundle messages). Mirrors
// `derivedCost` in transform.ts so single-run and cross-run dollar figures
// match within rounding. Duplicated here rather than imported because
// transform.ts is a client-adjacent module and we want the server path
// free of its transitive deps.
function costForAssistant(info: OpencodeMessageInfo): number {
  if (typeof info.cost === 'number') return info.cost;
  const price = priceFor(info.modelID);
  const t = info.tokens;
  if (!price || !t) return 0;
  const input = t.input * price.input;
  const output = t.output * price.output;
  const cachedRead = t.cache.read * price.cached;
  const cachedWrite = t.cache.write * (price.write ?? price.input);
  return (input + output + cachedRead + cachedWrite) / 1_000_000;
}

function sumRunMetrics(messages: OpencodeMessage[]): {
  costTotal: number;
  tokensTotal: number;
} {
  let costTotal = 0;
  let tokensTotal = 0;
  for (const m of messages) {
    if (m.info.role !== 'assistant') continue;
    tokensTotal += m.info.tokens?.total ?? 0;
    costTotal += costForAssistant(m.info);
  }
  return { costTotal, tokensTotal };
}

interface DerivedRow {
  status: SwarmRunStatus;
  lastActivityTs: number | null;
  costTotal: number;
  tokensTotal: number;
}

// Classify one session's tail + sum its assistant-message $/tokens. The
// aggregate in deriveRunRow() composes these per-session rows; keeping the
// single-session shape isolated means pattern='none' and pattern='council'
// use the exact same classifier — no divergence to drift.
//
// Never throws. A probe failure collapses to `unknown` + zeros so the
// aggregate can still fold this session in without rejecting the whole run.
async function deriveSessionRow(
  sessionID: string,
  workspace: string,
  signal?: AbortSignal
): Promise<DerivedRow> {
  let messages;
  try {
    messages = await getSessionMessagesServer(sessionID, workspace, signal);
  } catch {
    // Could be the session was deleted out from under us, or opencode is
    // momentarily unreachable. Either way, not actionable by the picker —
    // surface as unknown and let the next poll try again.
    return { status: 'unknown', lastActivityTs: null, costTotal: 0, tokensTotal: 0 };
  }

  if (messages.length === 0) {
    // Session exists but no messages yet. Usually means the run was just
    // created and the first directive is still in flight. Not idle, not
    // error — honest answer is unknown.
    return { status: 'unknown', lastActivityTs: null, costTotal: 0, tokensTotal: 0 };
  }

  const { costTotal, tokensTotal } = sumRunMetrics(messages);
  const last = messages[messages.length - 1];
  const info = last.info;
  const now = Date.now();

  // A trailing user message means opencode has accepted a prompt but hasn't
  // yet attached the assistant reply. That's live — something is about to
  // produce tokens.
  if (info.role === 'user') {
    return { status: 'live', lastActivityTs: info.time.created, costTotal, tokensTotal };
  }

  // Assistant message path.
  if (info.error) {
    return {
      status: 'error',
      lastActivityTs: info.time.completed ?? info.time.created,
      costTotal,
      tokensTotal,
    };
  }
  if (info.time.completed) {
    return { status: 'idle', lastActivityTs: info.time.completed, costTotal, tokensTotal };
  }
  // No completed, no error — either actively producing or zombie.
  if (now - info.time.created < ZOMBIE_THRESHOLD_MS) {
    return { status: 'live', lastActivityTs: info.time.created, costTotal, tokensTotal };
  }
  return { status: 'stale', lastActivityTs: info.time.created, costTotal, tokensTotal };
}

// Priority for folding N per-session statuses into one run-level status.
// Ordered so the aggregate answers the picker's real question — "what does
// this run most need my attention for?" — without losing information:
//   live   → someone is actively producing tokens, eclipses everything
//   error  → at least one session is in a failure state, needs surfacing
//   stale  → at least one session is a likely zombie (no completed, old)
//   idle   → every session has completed cleanly
//   unknown → we couldn't probe or nothing has happened yet
// Higher number wins. Any session at a given level pins the run there.
const STATUS_PRIORITY: Record<SwarmRunStatus, number> = {
  live: 4,
  error: 3,
  stale: 2,
  idle: 1,
  unknown: 0,
};

// Row-level derivation: one message fetch per *session*, fanned out in
// parallel across meta.sessionIDs, then folded into one row for the picker:
//   - costTotal / tokensTotal  — sum across all sessions
//   - lastActivityTs           — max across sessions (most recent thing seen)
//   - status                   — priority-reduced via STATUS_PRIORITY
//
// Single-session runs (pattern='none') degenerate to the old behavior: one
// fetch, one classification, no aggregation math to speak of. Multi-session
// runs (pattern='council') fold every member's state in without branching —
// same code path, same cache entry, same error-tolerance semantics.
//
// Never throws. Per-session probe failures already collapse to unknown +
// zeros in deriveSessionRow, so Promise.allSettled is defense-in-depth
// rather than load-bearing — but we keep it so a thrown-from-helper bug
// can't take down an entire list fetch.
export async function deriveRunRow(
  meta: SwarmRunMeta,
  signal?: AbortSignal
): Promise<DerivedRow> {
  if (meta.sessionIDs.length === 0) {
    return { status: 'unknown', lastActivityTs: null, costTotal: 0, tokensTotal: 0 };
  }

  const settled = await Promise.allSettled(
    meta.sessionIDs.map((sid) => deriveSessionRow(sid, meta.workspace, signal))
  );

  let costTotal = 0;
  let tokensTotal = 0;
  let lastActivityTs: number | null = null;
  let statusRank = STATUS_PRIORITY.unknown;
  let status: SwarmRunStatus = 'unknown';

  for (const r of settled) {
    // deriveSessionRow is non-throwing; a rejection here would be an
    // unexpected bug path. Treat as unknown + zeros so one pathological
    // session doesn't poison the aggregate.
    const row: DerivedRow =
      r.status === 'fulfilled'
        ? r.value
        : { status: 'unknown', lastActivityTs: null, costTotal: 0, tokensTotal: 0 };

    costTotal += row.costTotal;
    tokensTotal += row.tokensTotal;
    if (row.lastActivityTs !== null) {
      lastActivityTs =
        lastActivityTs === null ? row.lastActivityTs : Math.max(lastActivityTs, row.lastActivityTs);
    }
    const rank = STATUS_PRIORITY[row.status];
    if (rank > statusRank) {
      statusRank = rank;
      status = row.status;
    }
  }

  return { status, lastActivityTs, costTotal, tokensTotal };
}

// Per-session token/cost rows + the aggregate, in one fan-out. Separate from
// deriveRunRow because callers that want the granular breakdown (the /tokens
// endpoint, cost-dashboard drill-down) shouldn't have to re-fetch per-session
// data the aggregate already paid for.
//
// Keeps deriveRunRow unchanged — that one's on the hot path (list endpoint,
// 4s poll) and shouldn't pay the extra allocation for callers that only want
// the aggregate. Duplication is ~15 lines; composing via refactor would mean
// touching the cache path for a 1-caller feature.
export interface RunTokensBreakdown {
  totals: {
    tokens: number;
    cost: number;
    lastActivityTs: number | null;
    status: SwarmRunStatus;
  };
  sessions: Array<{
    sessionID: string;
    tokens: number;
    cost: number;
    lastActivityTs: number | null;
    status: SwarmRunStatus;
  }>;
}

export async function deriveRunTokens(
  meta: SwarmRunMeta,
  signal?: AbortSignal,
): Promise<RunTokensBreakdown> {
  if (meta.sessionIDs.length === 0) {
    return {
      totals: { tokens: 0, cost: 0, lastActivityTs: null, status: 'unknown' },
      sessions: [],
    };
  }

  const settled = await Promise.allSettled(
    meta.sessionIDs.map((sid) => deriveSessionRow(sid, meta.workspace, signal)),
  );

  const sessions: RunTokensBreakdown['sessions'] = [];
  let costTotal = 0;
  let tokensTotal = 0;
  let lastActivityTs: number | null = null;
  let statusRank = STATUS_PRIORITY.unknown;
  let status: SwarmRunStatus = 'unknown';

  meta.sessionIDs.forEach((sid, i) => {
    const r = settled[i];
    const row: DerivedRow =
      r.status === 'fulfilled'
        ? r.value
        : { status: 'unknown', lastActivityTs: null, costTotal: 0, tokensTotal: 0 };

    sessions.push({
      sessionID: sid,
      tokens: row.tokensTotal,
      cost: row.costTotal,
      lastActivityTs: row.lastActivityTs,
      status: row.status,
    });

    costTotal += row.costTotal;
    tokensTotal += row.tokensTotal;
    if (row.lastActivityTs !== null) {
      lastActivityTs =
        lastActivityTs === null
          ? row.lastActivityTs
          : Math.max(lastActivityTs, row.lastActivityTs);
    }
    const rank = STATUS_PRIORITY[row.status];
    if (rank > statusRank) {
      statusRank = rank;
      status = row.status;
    }
  });

  return {
    totals: { tokens: tokensTotal, cost: costTotal, lastActivityTs, status },
    sessions,
  };
}

// ---- derived-row cache ----------------------------------------------------
//
// deriveRunRow() costs one opencode /message fetch per run. The list
// endpoint fans that out for *every* run on every GET, and the picker polls
// on ~4s cadence, so unchanged runs take the same hit they took a moment
// ago. Short-TTL memoization flattens that curve:
//
//   - key:    swarmRunID
//   - value:  { row, fetchedAt } — the full deriveRunRow() return
//   - TTL:    CACHE_TTL_MS (2s) — below the poll cadence, above the
//             roundtrip jitter so one GET benefits from the prior one
//   - purge:  appendEvent() drops the entry for that run, so any new event
//             the multiplexer writes forces the next poll to re-fetch
//
// No LRU bound. The ledger has tens of runs at prototype scale (see memory
// user_host_machine). When the ledger grows into thousands this needs a
// bounded LRU; flag and move on.
//
// Shape is survive-restart safe because it lives in process memory only —
// a reboot is a natural purge. `globalThis` pinning matches memoryDb() so
// Next.js's module-reload in dev doesn't duplicate the map.
//
// Not thread-aware: single Next.js worker in dev. If we ever scale to
// multiple workers, this becomes a per-worker cache and runs with stale
// entries across workers — fine for a status picker, but call it out here.
interface CachedRow {
  row: DerivedRow;
  fetchedAt: number;
}

const CACHE_TTL_MS = 2000;

const globalCacheKey = Symbol.for('opencode_swarm.deriveRowCache');
type GlobalWithCache = typeof globalThis & {
  [globalCacheKey]?: Map<string, CachedRow>;
};
function derivedRowCache(): Map<string, CachedRow> {
  const g = globalThis as GlobalWithCache;
  if (!g[globalCacheKey]) g[globalCacheKey] = new Map();
  return g[globalCacheKey]!;
}

// Cached variant of deriveRunRow. Prefer this in the list endpoint; call
// the uncached deriveRunRow directly when freshness matters more than
// latency (e.g. a user clicking "refresh now" on a single run detail).
export async function deriveRunRowCached(
  meta: SwarmRunMeta,
  signal?: AbortSignal
): Promise<DerivedRow> {
  const cache = derivedRowCache();
  const now = Date.now();
  const hit = cache.get(meta.swarmRunID);
  if (hit && now - hit.fetchedAt < CACHE_TTL_MS) return hit.row;
  const row = await deriveRunRow(meta, signal);
  cache.set(meta.swarmRunID, { row, fetchedAt: now });
  return row;
}

function invalidateDerivedRow(swarmRunID: string): void {
  derivedRowCache().delete(swarmRunID);
}

// Append one event as a single JSON line. Uses appendFile (single syscall,
// O_APPEND semantics on POSIX) so concurrent appends from one process are
// safe without an explicit lock. The trailing newline is required for
// line-by-line replay readers.
//
// Side effect: purges the derived-row cache for this run. The next GET
// /api/swarm/run will re-probe opencode and pick up whatever this event
// implies (new tokens, status change, completion).
export async function appendEvent(
  swarmRunID: string,
  event: SwarmRunEvent
): Promise<void> {
  const line = JSON.stringify(event) + '\n';
  await fs.appendFile(eventsPath(swarmRunID), line, 'utf8');
  invalidateDerivedRow(swarmRunID);
}

// Stream events.ndjson line-by-line. Yields each parsed SwarmRunEvent in
// the order it was appended — this is the authoritative replay order
// (server-receive clock), not opencode's internal event ordering.
//
// Transparent compression support: if events.ndjson is missing but
// events.ndjson.gz exists, we stream through a gunzip pipeline. The sweep
// script (scripts/compress.mjs) renames to .gz once a run has been idle
// for 24h+ (see memory project_retention_policy). Callers never need to
// know which state a run is in.
//
// `sinceTs` is an optional exclusive lower bound on ts (epoch ms). Useful
// when a client reconnects after a drop and only needs the tail. Missing
// or malformed lines are skipped silently — the file is append-only and
// a partial trailing write can exist if the process died mid-line.
//
// Returns nothing when the run has no events file yet (createRun touches
// it, so this is rare — typically a race between createRun and the first
// read). ENOENT becomes an empty stream rather than throwing.
export async function* readEvents(
  swarmRunID: string,
  opts: { sinceTs?: number } = {}
): AsyncGenerator<SwarmRunEvent> {
  const plain = eventsPath(swarmRunID);
  const gz = eventsGzPath(swarmRunID);

  let lines: AsyncIterable<string>;
  let cleanup: () => Promise<void> = async () => undefined;

  const plainHandle = await fs.open(plain, 'r').catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  });

  if (plainHandle) {
    // readLines() is the node 18+ built-in line iterator. Handles UTF-8
    // boundaries across chunk reads correctly.
    lines = plainHandle.readLines({ encoding: 'utf8' });
    cleanup = () => plainHandle.close().catch(() => undefined);
  } else {
    // Fall back to the compressed sibling. Ungzip is a Transform stream;
    // readline gives us the same line-by-line contract as readLines().
    const gzStream = createReadStream(gz).on('error', () => undefined);
    // Surface ENOENT on the gz side as "no events" rather than throwing —
    // matches the plain-file contract and keeps readEvents() total.
    try {
      await fs.access(gz);
    } catch {
      return;
    }
    const rl = readline.createInterface({
      input: gzStream.pipe(createGunzip()),
      crlfDelay: Infinity,
    });
    lines = rl;
    cleanup = async () => {
      rl.close();
      gzStream.destroy();
    };
  }

  try {
    const sinceTs = opts.sinceTs;
    for await (const line of lines) {
      if (!line) continue;
      let ev: SwarmRunEvent;
      try {
        ev = JSON.parse(line) as SwarmRunEvent;
      } catch {
        continue;
      }
      if (sinceTs !== undefined && ev.ts <= sinceTs) continue;
      yield ev;
    }
  } finally {
    await cleanup();
  }
}
