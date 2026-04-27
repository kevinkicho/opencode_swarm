//
// Persistence layer for swarm runs. Two stores:
//
//   - metadata → SQLite (`memory.sqlite` runs table; one row per run)
//   - events   → per-run events.ndjson on disk (append-only L0 replay)
//
// Why this split? Run metadata is a small structured record that
// listRuns + getRun + updateRunMeta read frequently; SQLite gives us
// atomic writes, indexed `WHERE workspace=?` queries, and one fsync
// per write — replacing the per-run JSON file + 4 in-memory caches +
// per-run mutex stack the old layout needed. Events are unbounded
// append-only firehose — SQLite would be wrong shape; NDJSON files
// stay (with the gz fallback in readEvents below).
//
// Migration: on first read of a swarm run, if the row doesn't exist
// in SQLite but a `.opencode_swarm/runs/<id>/meta.json` does, import
// it lazily. Once SQLite has the row, the JSON becomes inert (we
// never write to it again; you can delete the on-disk meta.json by
// hand if you want, but listRuns still scans the runs/ dir on
// startup to lazy-import any not-yet-migrated runs).
//
// This module is server-only — do not import from 'use client' code.

import 'server-only';

import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';

import {
  validateSwarmRunEvent,
  validateSwarmRunMeta,
} from '../swarm-registry-validate';
import { LRU } from '../lru';
import { memoryDb } from '../memory/db';
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

function legacyMetaPath(swarmRunID: string): string {
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
// session?" on every prompt POST. A SQL scan per request is wasteful when
// the answer is stable for the life of a run, so we keep a process-local
// LRU seeded by createRun() and lazily refilled from SQLite on miss.

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
export async function findRunBySession(
  sessionID: string
): Promise<string | null> {
  const index = sessionIndex();
  const cached = index.get(sessionID);
  if (cached) return cached;
  // Rescan: walk every run's sessionIDs once and refill. SQLite makes
  // this cheap (one query, JSON_EXTRACT in-process). A sessionID that
  // isn't found after rescan is not-swarm-managed; we don't re-rescan
  // for subsequent misses to avoid a per-prompt scan on every direct
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
    // Survivor-remapped teamModels, index-aligned to sessionIDs.
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
    criticMaxIterations: req.criticMaxIterations,
    debateMaxRounds: req.debateMaxRounds,
    enableCriticGate: req.enableCriticGate ? true : undefined,
    criticSessionID: extras.criticSessionID,
    enableVerifierGate: req.enableVerifierGate ? true : undefined,
    workspaceDevUrl: req.workspaceDevUrl,
    verifierSessionID: extras.verifierSessionID,
    enableAuditorGate: req.enableAuditorGate ? true : undefined,
    auditorSessionID: extras.auditorSessionID,
    auditEveryNCommits: req.auditEveryNCommits,
    autoStopOnConverge: req.autoStopOnConverge ? true : undefined,
    partialMapTolerance: req.partialMapTolerance,
    enableSynthesisCritic: req.enableSynthesisCritic ? true : undefined,
    synthesisModel: req.synthesisModel,
    criticModel: req.criticModel,
    verifierModel: req.verifierModel,
    auditorModel: req.auditorModel,
    continuationOf: req.continuationOf,
    teamModels: extras.teamModels,
  };
  // Insert into SQLite. The transaction makes the events.ndjson touch +
  // the registry insert appear as one operation to readers.
  const db = memoryDb();
  db.prepare(
    `INSERT INTO runs (swarm_run_id, workspace, source, pattern, created_at, payload)
     VALUES (@swarm_run_id, @workspace, @source, @pattern, @created_at, @payload)`,
  ).run({
    swarm_run_id: swarmRunID,
    workspace: meta.workspace,
    source: meta.source ?? null,
    pattern: meta.pattern,
    created_at: meta.createdAt,
    payload: JSON.stringify(meta),
  });
  // events.ndjson lives next to (legacy) meta.json under runs/<id>/.
  // Touch it so the multiplexer can append without an existence check.
  await fs.mkdir(runDir(swarmRunID), { recursive: true });
  await fs.writeFile(eventsPath(swarmRunID), '', { flag: 'a' });
  // Seed the reverse index so the cost-cap gate resolves this run's
  // sessions without a full scan on first prompt.
  for (const sid of sessionIDs) sessionIndex().set(sid, swarmRunID);
  return meta;
}

export async function getRun(swarmRunID: string): Promise<SwarmRunMeta | null> {
  const db = memoryDb();
  const row = db
    .prepare('SELECT payload FROM runs WHERE swarm_run_id = ?')
    .get(swarmRunID) as { payload: string } | undefined;
  if (row) {
    try {
      const parsed = JSON.parse(row.payload);
      return validateSwarmRunMeta(parsed);
    } catch (err) {
      console.warn(
        `[swarm-registry] runs row for ${swarmRunID} has corrupt JSON:`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }
  // SQLite miss: try lazy-import from a legacy meta.json on disk. This
  // covers runs created before the SQLite migration AND any run whose
  // SQLite row was wiped while the on-disk events.ndjson + meta.json
  // remain. Returns null for a non-existent run (no JSON, no row).
  return importLegacyMeta(swarmRunID);
}

async function importLegacyMeta(swarmRunID: string): Promise<SwarmRunMeta | null> {
  let raw: string;
  try {
    raw = await fs.readFile(legacyMetaPath(swarmRunID), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    console.warn(
      `[swarm-registry] meta.json for ${swarmRunID} is corrupt JSON:`,
      parseErr instanceof Error ? parseErr.message : String(parseErr),
    );
    return null;
  }
  const meta = validateSwarmRunMeta(parsed);
  if (!meta) return null;
  // Insert into SQLite so subsequent getRun calls hit the row, not the disk.
  const db = memoryDb();
  db.prepare(
    `INSERT OR REPLACE INTO runs (swarm_run_id, workspace, source, pattern, created_at, payload)
     VALUES (@swarm_run_id, @workspace, @source, @pattern, @created_at, @payload)`,
  ).run({
    swarm_run_id: meta.swarmRunID,
    workspace: meta.workspace,
    source: meta.source ?? null,
    pattern: meta.pattern,
    created_at: meta.createdAt,
    payload: JSON.stringify(meta),
  });
  return meta;
}

// Read-modify-write of meta. The runs row holds the full payload so
// updates atomically replace the JSON blob.
export async function updateRunMeta(
  swarmRunID: string,
  patch: Partial<SwarmRunMeta>,
): Promise<SwarmRunMeta | null> {
  const current = await getRun(swarmRunID);
  if (!current) return null;
  const next: SwarmRunMeta = { ...current, ...patch };
  const db = memoryDb();
  db.prepare(
    `UPDATE runs SET workspace = @workspace, source = @source, pattern = @pattern,
                     created_at = @created_at, payload = @payload
     WHERE swarm_run_id = @swarm_run_id`,
  ).run({
    swarm_run_id: next.swarmRunID,
    workspace: next.workspace,
    source: next.source ?? null,
    pattern: next.pattern,
    created_at: next.createdAt,
    payload: JSON.stringify(next),
  });
  return next;
}

// Enumerate every run, newest-first. SQLite owns the canonical list;
// any pre-migration meta.json files under runs/ get lazy-imported on
// first call (one-shot scan of the runs/ directory).
//
// Once import has happened, subsequent listRuns() calls are a single
// SQL scan — no filesystem traversal at all. The flag is per-process,
// so an HMR reload re-runs the import (idempotent via INSERT OR
// IGNORE), which is fine.
let _legacyImportDone = false;

export async function listRuns(): Promise<SwarmRunMeta[]> {
  if (!_legacyImportDone) {
    await importAllLegacyMetas();
    _legacyImportDone = true;
  }
  const db = memoryDb();
  const rows = db
    .prepare('SELECT payload FROM runs ORDER BY created_at DESC')
    .all() as Array<{ payload: string }>;
  const out: SwarmRunMeta[] = [];
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.payload);
      const meta = validateSwarmRunMeta(parsed);
      if (meta) out.push(meta);
    } catch {
      // Corrupt blob — skip silently. Same shape as the per-run getRun
      // path; one bad row shouldn't poison the whole list.
    }
  }
  return out;
}

async function importAllLegacyMetas(): Promise<void> {
  const runsRoot = path.join(ROOT, 'runs');
  let entries: string[];
  try {
    entries = await fs.readdir(runsRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const db = memoryDb();
  const existing = new Set(
    (db.prepare('SELECT swarm_run_id FROM runs').all() as Array<{ swarm_run_id: string }>)
      .map((r) => r.swarm_run_id),
  );
  for (const id of entries) {
    if (existing.has(id)) continue;
    await importLegacyMeta(id).catch(() => null);
  }
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
// for 24h+. Callers never need to know which state a run is in.
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
    lines = plainHandle.readLines({ encoding: 'utf8' });
    cleanup = () => plainHandle.close().catch(() => undefined);
  } else {
    const gzStream = createReadStream(gz).on('error', () => undefined);
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
