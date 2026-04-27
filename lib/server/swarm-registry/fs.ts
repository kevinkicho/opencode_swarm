//
// Filesystem-backed registry for swarm runs. Runs live under
// `.opencode_swarm/runs/<swarmRunID>/` with two files:
//
//   meta.json      - SwarmRunMeta, written once at createRun()
//   events.ndjson  - one SwarmRunEvent per line, appended by the multiplexer
//
// Design choices (see docs/DESIGN.md §Tier 2 and 
// §"Backend gap" for the why):
//
// - JSON over SQLite: zero deps, grep-able, survives server restart.
// - One directory per run: easy to tar/rm/rotate; no global index to corrupt.
// - Append-only NDJSON for events: O(1) writes, replayable, naturally ordered.
// - No locking: single Next.js process in dev; fs.appendFile is atomic enough
//   for one-writer-per-file (one multiplexer per run).
//
// This module is server-only — do not import from 'use client' code.
//
// Split out of swarm-registry.ts in W5.1: this file holds the persistence
// layer (createRun / getRun / listRuns / updateRunMeta / appendEvent /
// readEvents / findRunBySession). The opencode-bound derivation layer
// (deriveRunRow / deriveRunTokens / deriveRunRowCached) lives in
// `./derive.ts`. The barrel `lib/server/swarm-registry.ts` re-exports
// both halves for backward compatibility with callers.

import 'server-only';

import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';

import {
  validateSwarmRunEvent,
  validateSwarmRunMeta,
} from '../swarm-registry-validate';
import { atomicWriteFile, withKeyedMutex } from '../atomic-write';
import { LRU } from '../lru';
import type {
  SwarmRunEvent,
  SwarmRunMeta,
  SwarmRunRequest,
} from '../../swarm-run-types';

// OPENCODE_SWARM_ROOT default is repo-root/.opencode_swarm; override
// via env for deployments that want runs under a different root.
import { OPENCODE_SWARM_ROOT as ROOT } from '../../config';

// Cross-half import for cache invalidation. appendEvent() needs to drop
// the derived-row cache entry for this run so the next poll re-probes
// opencode for whatever the event implies. One-way edge — derive.ts
// never imports from fs.ts.
import { invalidateDerivedRow } from './derive';

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
// Map; in long-lived dev it accumulated every session ID across every
// run (including deleted runs) forever. 2000 entries is generous for
// the prototype scale (~20 sessions × 100 runs); each entry is just
// two strings (sessionID → swarmRunID) so memory footprint is trivial.
const SESSION_INDEX_MAX = 2000;
const globalIndexKey = Symbol.for('opencode_swarm.sessionIndex');
type GlobalWithIndex = typeof globalThis & {
  [globalIndexKey]?: LRU<string, string>;
};
function sessionIndex(): LRU<string, string> {
  const g = globalThis as GlobalWithIndex;
  if (!g[globalIndexKey]) g[globalIndexKey] = new LRU(SESSION_INDEX_MAX);
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
    // Council convergence auto-stop
    autoStopOnConverge: req.autoStopOnConverge ? true : undefined,
    // Strict role routing
    strictRoleRouting: req.strictRoleRouting ? true : undefined,
    // Per-role budgets
    roleBudgets: req.roleBudgets,
    // Partial-map tolerance
    partialMapTolerance: req.partialMapTolerance,
    // Synthesis-critic
    enableSynthesisCritic: req.enableSynthesisCritic ? true : undefined,
    // Synthesis-model pin
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
  // doesn't leave a 0-byte meta.json that getRun parse-throws on.
  await atomicWriteFile(metaPath(swarmRunID), JSON.stringify(meta, null, 2));
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
// Map; a long-lived dev process accumulated entries forever. 500
// entries is well above any realistic prototype run count and cheap
// in memory (~2 KB meta × 500 = ~1 MB worst case).
const META_CACHE_MAX = 500;
interface MetaCacheEntry {
  value: SwarmRunMeta | null;
  fetchedAt: number;
}
const globalMetaCacheKey = Symbol.for('opencode_swarm.swarmRegistry.metaCache');
type GlobalWithMetaCache = typeof globalThis & {
  [globalMetaCacheKey]?: LRU<string, MetaCacheEntry>;
};
function metaCache(): LRU<string, MetaCacheEntry> {
  const g = globalThis as GlobalWithMetaCache;
  if (!g[globalMetaCacheKey]) g[globalMetaCacheKey] = new LRU(META_CACHE_MAX);
  return g[globalMetaCacheKey]!;
}

export async function getRun(swarmRunID: string): Promise<SwarmRunMeta | null> {
  const cache = metaCache();
  const cached = cache.get(swarmRunID);
  if (cached && Date.now() - cached.fetchedAt < META_CACHE_TTL_MS) {
    return cached.value;
  }
  try {
    const raw = await fs.readFile(metaPath(swarmRunID), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      // Pre-fix: this would throw and propagate up; downstream callers
      // saw the failure as "run is broken" without context. Treat as
      // missing — the validator path warns once, then null cascades.
      console.warn(
        `[swarm-registry] meta.json for ${swarmRunID} is corrupt JSON:`,
        parseErr instanceof Error ? parseErr.message : String(parseErr),
      );
      cache.set(swarmRunID, { value: null, fetchedAt: Date.now() });
      return null;
    }
    // R7 — validate the parsed shape before trusting it. A truncated
    // meta.json that happens to be valid JSON (e.g., `{}`) would have
    // passed the cast pre-fix and propagated undefined fields into
    // every consumer.
    const value = validateSwarmRunMeta(parsed);
    if (value === null) {
      cache.set(swarmRunID, { value: null, fetchedAt: Date.now() });
      return null;
    }
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
// is small (< 2 KB even for the largest configs).
//
// concurrent updateRunMeta calls don't lost-update each other. Pre-fix
// the read-modify-write was unsynchronized: caller A reads { tier: 1 },
// caller B reads { tier: 1 }, both modify, A writes { tier: 2 }, B
// writes { tier: 1, ... } overwriting A. Plus atomicWriteFile so a
// crash mid-write doesn't leave a 0-byte meta.json.
//
// Returns the new meta on success or null if the run doesn't exist /
// the file is malformed. Silently no-ops on missing — the caller
// (e.g. fire-and-forget ticker write) doesn't need to know.
export async function updateRunMeta(
  swarmRunID: string,
  patch: Partial<SwarmRunMeta>,
): Promise<SwarmRunMeta | null> {
  return withKeyedMutex(`meta:${swarmRunID}`, async () => {
    const current = await getRun(swarmRunID);
    if (!current) return null;
    const next: SwarmRunMeta = { ...current, ...patch };
    await atomicWriteFile(metaPath(swarmRunID), JSON.stringify(next, null, 2));
    // Replace cache entry with the freshly-written value so subsequent
    // getRun calls within the TTL window see the update without a re-read.
    metaCache().set(swarmRunID, { value: next, fetchedAt: Date.now() });
    // listRuns cache is keyed on the whole list — invalidate so the
    // picker reflects this update on its next poll.
    delete listCache()[globalListCacheKey];
    return next;
  });
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
      // Pre-fix the cast trusted any line that parsed as JSON,
      // including hand-edited noise that would have surfaced as
      // undefined fields downstream.
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const ev = validateSwarmRunEvent(parsed);
      if (ev === null) continue;
      if (sinceTs !== undefined && ev.ts <= sinceTs) continue;
      yield ev;
    }
  } finally {
    await cleanup();
  }
}
