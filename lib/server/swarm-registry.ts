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
  extras: {
    criticSessionID?: string;
    verifierSessionID?: string;
    auditorSessionID?: string;
    // When req.continuationOf is set, the caller resolves the prior run's
    // currentTier and passes it here so meta.currentTier seeds the new
    // run at the inherited tier (vs the default tier 1 start). Ignored
    // when continuationOf is unset.
    startTier?: number;
    // Survivor-remapped teamModels, index-aligned to sessionIDs. Caller
    // handles the remap from req.teamModels's original-slot order into
    // surviving-session order.
    teamModels?: string[];
  } = {},
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
    // when it's absent. Same shape for verifier.
    enableCriticGate: req.enableCriticGate ? true : undefined,
    criticSessionID: extras.criticSessionID,
    enableVerifierGate: req.enableVerifierGate ? true : undefined,
    workspaceDevUrl: req.workspaceDevUrl,
    verifierSessionID: extras.verifierSessionID,
    // Auditor gate (Stage 2 declared-roles). Same shape as critic /
    // verifier: flag copied when truthy, sessionID only when spawn
    // succeeded. auditEveryNCommits is the cadence knob — defaulted
    // in auto-ticker when unset, but we persist the request value
    // when present so runs can resume with the user's chosen cadence.
    enableAuditorGate: req.enableAuditorGate ? true : undefined,
    auditorSessionID: extras.auditorSessionID,
    auditEveryNCommits: req.auditEveryNCommits,
    // Synthesis-verifier gate — deliberate-execute pattern only.
    // PATTERN_DESIGN/deliberate-execute.md I1. No dedicated session;
    // the verifier reuses sessionIDs[1].
    enableSynthesisVerifier: req.enableSynthesisVerifier ? true : undefined,
    // Council convergence auto-stop — PATTERN_DESIGN/council.md I1.
    autoStopOnConverge: req.autoStopOnConverge ? true : undefined,
    // Strict role routing — PATTERN_DESIGN/role-differentiated.md I1.
    strictRoleRouting: req.strictRoleRouting ? true : undefined,
    // Per-role budgets — PATTERN_DESIGN/role-differentiated.md I4.
    roleBudgets: req.roleBudgets,
    // Partial-map tolerance — PATTERN_DESIGN/map-reduce.md I3.
    partialMapTolerance: req.partialMapTolerance,
    // Synthesis-critic — PATTERN_DESIGN/map-reduce.md I1.
    enableSynthesisCritic: req.enableSynthesisCritic ? true : undefined,
    // Synthesis-model pin — PATTERN_DESIGN/map-reduce.md I4.
    synthesisModel: req.synthesisModel,
    // Per-gate model pins (2026-04-24). Each gate's reviewer module
    // reads meta.<gate>Model and passes it on postSessionMessageServer
    // so the gate runs on a specific provider/model independent of
    // the worker team's models.
    criticModel: req.criticModel,
    verifierModel: req.verifierModel,
    auditorModel: req.auditorModel,
    // Run-chaining lineage + inherited tier. currentTier stays absent
    // (interpreted as tier 1) for standalone runs; only written here
    // when the caller explicitly resolves a > 1 starting tier from a
    // prior run.
    continuationOf: req.continuationOf,
    currentTier: extras.startTier && extras.startTier > 1 ? extras.startTier : undefined,
    // Per-session model pinning (survivor-remapped upstream). Absent
    // when the caller didn't pass a team — opencode picks the default
    // agent's model per session.
    teamModels: extras.teamModels,
  };
  await fs.mkdir(runDir(swarmRunID), { recursive: true });
  await fs.writeFile(metaPath(swarmRunID), JSON.stringify(meta, null, 2), 'utf8');
  // Touch events.ndjson so the multiplexer can append without a separate
  // existence check. An empty file is a valid NDJSON (zero records).
  await fs.writeFile(eventsPath(swarmRunID), '', { flag: 'a' });
  // Seed the reverse index so the cost-cap gate resolves this run's
  // sessions without a full disk scan on first prompt.
  for (const sid of sessionIDs) sessionIndex().set(sid, swarmRunID);
  // Invalidate the listRuns cache so the picker sees the new run on its
  // next poll instead of waiting up to LIST_CACHE_TTL_MS for it to appear.
  delete listCache()[globalListCacheKey];
  return meta;
}

// 2026-04-25 — getRun() TTL cache. WSL2's 9P protocol for /mnt/c file
// reads costs 50-200ms each. With multiple polling hooks (useLiveTicker
// 5s, useLiveBoard 2s, useSwarmRun, useSwarmRuns, plus every API route
// that calls getRun for existence checks), the dev server was burning
// hundreds of ms per second on redundant file reads of the same
// meta.json — saturating the request queue and making the browser feel
// stuck.
//
// 2-second TTL captures the burst-pattern (multiple hooks fan out at
// the same render tick) while still picking up legit mutations within
// a render-cycle delay. updateRunMeta below invalidates explicitly so
// writes don't have to wait for TTL expiry.
//
// Keyed by globalThis so HMR module reloads don't lose the cache —
// matches the same pattern as the F7 baselineCache in opencode-server.ts.
const META_CACHE_TTL_MS = 2000;
interface MetaCacheEntry {
  value: SwarmRunMeta | null;
  fetchedAt: number;
}
const globalMetaCacheKey = Symbol.for('opencode_swarm.swarmRegistry.metaCache');
type GlobalWithMetaCache = typeof globalThis & {
  [globalMetaCacheKey]?: Map<string, MetaCacheEntry>;
};
function metaCache(): Map<string, MetaCacheEntry> {
  const g = globalThis as GlobalWithMetaCache;
  if (!g[globalMetaCacheKey]) g[globalMetaCacheKey] = new Map();
  return g[globalMetaCacheKey]!;
}
function invalidateMetaCache(swarmRunID: string): void {
  metaCache().delete(swarmRunID);
}

export async function getRun(swarmRunID: string): Promise<SwarmRunMeta | null> {
  const cache = metaCache();
  const cached = cache.get(swarmRunID);
  if (cached && Date.now() - cached.fetchedAt < META_CACHE_TTL_MS) {
    return cached.value;
  }
  try {
    const raw = await fs.readFile(metaPath(swarmRunID), 'utf8');
    const value = JSON.parse(raw) as SwarmRunMeta;
    cache.set(swarmRunID, { value, fetchedAt: Date.now() });
    return value;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Cache the negative answer too — a 404 polling loop shouldn't
      // hammer fs.readFile every tick. TTL applies the same way.
      cache.set(swarmRunID, { value: null, fetchedAt: Date.now() });
      return null;
    }
    throw err;
  }
}

// Read-modify-write of meta.json for post-create mutations. The file
// is small (< 2 KB even for the largest configs) and writes are
// single-process single-writer (Next.js dev), so a naive read-parse-
// merge-write is fine. Callers should keep patches narrow — only the
// ambition-ratchet uses this today to persist currentTier; adding new
// fields means extending SwarmRunMeta in swarm-run-types.ts first.
//
// Returns the new meta on success or null if the run doesn't exist /
// the file is malformed. Silently no-ops on missing — the caller
// (e.g. fire-and-forget ticker write) doesn't need to know.
export async function updateRunMeta(
  swarmRunID: string,
  patch: Partial<SwarmRunMeta>,
): Promise<SwarmRunMeta | null> {
  const current = await getRun(swarmRunID);
  if (!current) return null;
  const next: SwarmRunMeta = { ...current, ...patch };
  await fs.writeFile(metaPath(swarmRunID), JSON.stringify(next, null, 2), 'utf8');
  // Replace cache entry with the freshly-written value so subsequent
  // getRun calls within the TTL window see the update without a re-read.
  metaCache().set(swarmRunID, { value: next, fetchedAt: Date.now() });
  // listRuns cache is keyed on the whole list — invalidate so the
  // picker reflects this update on its next poll.
  delete listCache()[globalListCacheKey];
  return next;
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
// 2026-04-25 — listRuns() result-level TTL cache. Even with the per-id
// getRun cache, the FIRST call to listRuns has to readdir + read every
// meta.json — at ~50-200ms per /mnt/c read on WSL2 with 50+ runs
// accumulated, that's 2-10 seconds blocking the picker. The list as
// a whole rarely changes (only when runs are created/deleted), so a
// 2s TTL captures the burst without hurting freshness for any
// meaningful workflow.
//
// Pagination: not yet. At prototype scale N is small (tens, not
// thousands). When the cache hit-rate drops, the fix is a cursor-based
// API; the directory scan itself is cheap, it's the per-file read that
// adds up.
// 2026-04-25 — bumped from 2s to 15s. With 80+ accumulated runs each
// triggering a per-session opencode probe, deriveRunRowCached's
// computation alone takes 2-3s. A 2s TTL means every subsequent
// poll arrived AFTER expiry, so the cache never hit. 15s captures
// useSwarmRuns's 30s polling cadence enough that one in two polls
// returns cached. Status freshness suffers by 15s in worst case,
// which is fine for the picker (live status flows through SSE
// elsewhere; this endpoint is the cold-load list view).
const LIST_CACHE_TTL_MS = 15_000;
interface ListCacheEntry {
  value: SwarmRunMeta[];
  fetchedAt: number;
}
const globalListCacheKey = Symbol.for('opencode_swarm.swarmRegistry.listCache');
type GlobalWithListCache = typeof globalThis & {
  [globalListCacheKey]?: ListCacheEntry | null;
};
function listCache(): GlobalWithListCache {
  return globalThis as GlobalWithListCache;
}

export async function listRuns(): Promise<SwarmRunMeta[]> {
  const cache = listCache();
  const cached = cache[globalListCacheKey];
  if (cached && Date.now() - cached.fetchedAt < LIST_CACHE_TTL_MS) {
    return cached.value;
  }
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

  // Route through getRun so each meta-read hits the per-id cache on
  // subsequent ticks. The first listRuns call still reads each file
  // (cache miss for all), but the per-id cache then absorbs follow-on
  // reads from getRun() callers who target a specific run.
  const metas = await Promise.all(
    entries.map((id) => getRun(id).catch(() => null)),
  );

  const value = metas
    .filter((m): m is SwarmRunMeta => m !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
  cache[globalListCacheKey] = { value, fetchedAt: Date.now() };
  return value;
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
  // yet attached the assistant reply. That's live — but ONLY if the user
  // post is recent. Sessions where the assistant never replied (opencode
  // crashed, the run was aborted before the turn completed, etc.) get
  // stuck with a trailing user message forever; without the freshness
  // check below those orphans claim live status indefinitely. Same
  // threshold the assistant-message zombie path uses below; consistent
  // semantics across the two no-completed-yet branches.
  if (info.role === 'user') {
    if (now - info.time.created < ZOMBIE_THRESHOLD_MS) {
      return { status: 'live', lastActivityTs: info.time.created, costTotal, tokensTotal };
    }
    return { status: 'stale', lastActivityTs: info.time.created, costTotal, tokensTotal };
  }

  // Assistant message path.
  if (info.error) {
    // #7.Q27 — distinguish operator-initiated aborts from real failures.
    // opencode marks MessageAbortedError on the trailing assistant turn
    // whenever our /abort fires (cap-stop, manual /stop, operator abort,
    // F1 silent-watchdog stop). All four are *graceful terminations* —
    // the run did what it was supposed to do and was shut down cleanly.
    // Treating them as `error` was making cap-stopped runs (the cleanest
    // outcome we have) show red in the picker. Other error names (provider
    // failures, parse errors, model timeouts) still escalate to `error`.
    const errName = (info.error as { name?: string } | null | undefined)?.name;
    if (errName === 'MessageAbortedError') {
      return {
        status: 'idle',
        lastActivityTs: info.time.completed ?? info.time.created,
        costTotal,
        tokensTotal,
      };
    }
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

  // #7.Q28 + #7.Q35 — ticker-snapshot consultation. Two corrections:
  //
  // Q28 (live-during-active): per-session "between turns" idleness
  // shouldn't classify a run that's still being dispatched as `idle`.
  // Empirical: a 60-min orchestrator-worker run shows every session as
  // `idle` whenever the workers complete a turn between dispatches
  // (their trailing assistant has time.completed set). The per-session
  // classifier is correct at that microsecond; the run-level answer
  // isn't. Promote to `live` whenever a non-stopped ticker exists.
  //
  // Q35 (failure-vs-clean stop distinction): post-Q27, MessageAbortedError
  // sessions classify as `idle`. But the ticker can stop for many reasons
  // — graceful (wall-clock-cap / commits-cap / todos-cap / manual /
  // auto-idle / operator-hard-stop) or failure (opencode-frozen /
  // zen-rate-limit / replan-loop-exhausted). Without distinguishing,
  // a silently-frozen run looks identical to a successfully-capped one
  // in the picker. Promote `idle` → `error` when the stopReason is in
  // the failure set so the picker's dot color tells truth.
  //
  // Dynamic import keeps swarm-registry decoupled from the ticker
  // module's globalThis registry.
  if (status === 'idle') {
    try {
      const { getTickerSnapshot } = await import('./blackboard/auto-ticker');
      const ticker = getTickerSnapshot(meta.swarmRunID);
      if (ticker) {
        if (!ticker.stopped) {
          status = 'live';
        } else if (
          ticker.stopReason === 'opencode-frozen' ||
          ticker.stopReason === 'zen-rate-limit' ||
          ticker.stopReason === 'replan-loop-exhausted'
        ) {
          status = 'error';
        }
      }
    } catch {
      // ticker registry unreachable — keep idle. The picker already
      // tolerates this case via its existing classifier.
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

// 2026-04-25 — bumped from 2s to 10s. Each derivation costs one
// opencode message-fetch per session (100-300ms each on WSL2 in
// dev). Across 80+ runs the list endpoint serializes 250+ probes,
// taking 2-3s total. A 2s TTL meant the next poll always missed.
// 10s lets one in three polls (default useSwarmRuns 30s cadence)
// cached-fall-through. appendEvent still invalidates per-run on
// state change so the freshness window is "no recent appends"
// — actively-live runs are still up-to-date when something happens.
const CACHE_TTL_MS = 10_000;

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
