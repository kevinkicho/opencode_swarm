// Cold-file seeding
//
// When the auto-ticker drains the board AND a tier-escalation sweep
// produces no new work, the run is at risk of stopping with workspace
// territory still unexplored. Stigmergy v1's exploratory bias is
// useless once the queue is empty (nothing to score).
//
// This seeder fires as a final fallback before idle-stop: it walks the
// workspace's code files, subtracts any path that any session has
// edited (heat = 0 means untouched), and inserts a small batch of
// "investigate <file>; report findings" todos so the swarm has
// something exploratory to chew on. Capped at SEED_MAX so a fresh
// repo with hundreds of untouched files doesn't dump them all at once
// — the ticker re-fires this on subsequent drains until everything is
// touched or the operator stops the run.
//
// Deterministic: no LLM call, just fs + heat. Cheap (~ms on small
// repos, capped on large repos by the recursion cost). Server-only.

import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { toFileHeat } from '@/lib/opencode/transform';
import { getSessionMessagesServer } from '../opencode-server';
import { getRun } from '../swarm-registry';
import { insertBoardItem, listBoardItems } from './store';
import { mintItemId } from './planner';

const SEED_MAX = 5;
const COLD_CODE_EXTS = new Set<string>([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rb', '.java', '.kt', '.swift',
  '.rs', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.cs', '.php', '.scala', '.sh', '.sql',
]);
// Don't recurse into these — same set as map-reduce SLICE_EXCLUDE plus
// a few extras (test fixtures, generated). Avoids burning the budget
// on directories that are intentionally untouched.
const COLD_EXCLUDE_DIRS = new Set<string>([
  '.git', '.next', '.svelte-kit', '.turbo',
  'node_modules', 'dist', 'build', 'out',
  'coverage', '.cache', 'tmp', 'fixtures',
  '__snapshots__', 'vendor',
]);
// Hard ceiling on how many candidate files to enumerate before
// stopping the walk. Most code repos have < 5000 files; larger ones
// still get a representative sample without pinning the seeder.
const WALK_MAX_FILES = 8000;

async function walkCodeFiles(
  rootAbs: string,
  rootRel: string,
  dir: string,
  out: string[],
): Promise<void> {
  if (out.length >= WALK_MAX_FILES) return;
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as import('node:fs').Dirent[];
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= WALK_MAX_FILES) return;
    if (e.name.startsWith('.') || COLD_EXCLUDE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkCodeFiles(rootAbs, rootRel, full, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!COLD_CODE_EXTS.has(ext)) continue;
      // Emit workspace-relative paths so the heat-set comparison can
      // match how `patch.files` are reported (relative to workspace
      // root by opencode convention).
      const rel = path.relative(rootAbs, full).replace(/\\/g, '/');
      out.push(rel);
    }
  }
}

// Returns the number of cold todos seeded onto the board. 0 means
// either no untouched files found, the run isn't found, or seeding
// aborted (e.g. fs read failed).
export async function attemptColdFileSeeding(
  swarmRunID: string,
): Promise<number> {
  const meta = await getRun(swarmRunID);
  if (!meta) return 0;
  if (!meta.workspace) return 0;

  // Gather every session's messages so heat reflects the entire run,
  // not just one session's activity. Failures on individual sessions
  // get swallowed — partial heat data is better than none.
  const allMessages = (
    await Promise.all(
      meta.sessionIDs.map(async (sid) => {
        try {
          return await getSessionMessagesServer(sid, meta.workspace);
        } catch {
          return [];
        }
      }),
    )
  ).flat();
  const heat = toFileHeat(allMessages);
  const touched = new Set<string>();
  for (const h of heat) {
    touched.add(h.path);
    // Heat paths sometimes carry leading workspace-segment; also add
    // the basename so we don't seed a file whose dir was already
    // hit. Conservative: false negatives (skipping a slightly-cold
    // file) are fine; false positives (seeding a hot one) waste
    // budget.
    touched.add(h.path.replace(/\\/g, '/'));
  }

  const candidates: string[] = [];
  await walkCodeFiles(meta.workspace, '', meta.workspace, candidates);
  if (candidates.length === 0) return 0;

  const cold = candidates.filter((p) => !touched.has(p));
  if (cold.length === 0) return 0;

  // Stable sample: sort alphabetically and take the first SEED_MAX.
  // Predictable across re-runs so we don't seed different files on
  // each cascade. The next cascade will pick up where this left off
  // (those will be touched after workers process the seeds).
  cold.sort();
  const picks = cold.slice(0, SEED_MAX);

  // Idempotency: don't double-seed the same file in the same run.
  // Compare against open + any-status board items' content for
  // exact-path mentions. Simple includes() covers the case where a
  // prior cold-file seed is still pending.
  const board = listBoardItems(swarmRunID);
  const existing = board.map((it) => it.content);
  const fresh = picks.filter((p) => !existing.some((c) => c.includes(p)));
  if (fresh.length === 0) return 0;

  let seeded = 0;
  const baseMs = Date.now();
  for (let i = 0; i < fresh.length; i += 1) {
    const p = fresh[i];
    try {
      insertBoardItem(swarmRunID, {
        id: mintItemId(),
        kind: 'todo',
        content: `Investigate ${p}; report findings as a brief markdown summary (no edits)`,
        status: 'open',
        createdAtMs: baseMs + i,
      });
      seeded += 1;
    } catch (err) {
      console.warn(
        `[cold-file-seed] insert failed for ${p}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (seeded > 0) {
    console.log(
      `[cold-file-seed] ${swarmRunID}: seeded ${seeded} exploration todo(s) for cold files`,
    );
  }
  return seeded;
}
