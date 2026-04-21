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

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  SwarmRunEvent,
  SwarmRunMeta,
  SwarmRunRequest,
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
  sessionIDs: string[]
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
  };
  await fs.mkdir(runDir(swarmRunID), { recursive: true });
  await fs.writeFile(metaPath(swarmRunID), JSON.stringify(meta, null, 2), 'utf8');
  // Touch events.ndjson so the multiplexer can append without a separate
  // existence check. An empty file is a valid NDJSON (zero records).
  await fs.writeFile(eventsPath(swarmRunID), '', { flag: 'a' });
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

// Append one event as a single JSON line. Uses appendFile (single syscall,
// O_APPEND semantics on POSIX) so concurrent appends from one process are
// safe without an explicit lock. The trailing newline is required for
// line-by-line replay readers.
export async function appendEvent(
  swarmRunID: string,
  event: SwarmRunEvent
): Promise<void> {
  const line = JSON.stringify(event) + '\n';
  await fs.appendFile(eventsPath(swarmRunID), line, 'utf8');
}

// Stream events.ndjson line-by-line. Yields each parsed SwarmRunEvent in
// the order it was appended — this is the authoritative replay order
// (server-receive clock), not opencode's internal event ordering.
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
  let fh: Awaited<ReturnType<typeof fs.open>>;
  try {
    fh = await fs.open(eventsPath(swarmRunID), 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  try {
    // readLines() is the node 18+ built-in line iterator. Avoids the
    // boilerplate of readable-stream + split() and handles UTF-8 boundaries
    // across chunk reads correctly.
    const stream = fh.readLines({ encoding: 'utf8' });
    const sinceTs = opts.sinceTs;
    for await (const line of stream) {
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
    await fh.close().catch(() => undefined);
  }
}
