//
// File-level claim gating — systematic Fix 2.
//
// A per-run soft lock table that prevents two agents from simultaneously
// working on different todos that target the same files. When agent A
// claims a todo with `expectedFiles: ['src/auth.ts']`, that file is locked.
// Agent B's claim for a different todo touching `src/auth.ts` is skipped
// until agent A's todo transitions to done/stale and releases the lock.
//
// This is a soft lock (advisory), not a transaction. Two agents can still
// conflict if a todo has no expectedFiles (file scope unknown at claim
// time). The soft lock handles the common case (planner specifies files,
// workers claim atomically) without the complexity of real file-level
// transactions.
//
// Persistence: in-memory only (globalThis-keyed). Reconstructed from
// listBoardItems on ticker boot. Survives HMR.
//
// See docs/SYSTEMATIC_FIXES.md for the full design.

import 'server-only';

import { listBoardItems } from '../store';
import { getBoardView, invalidateBoardView } from '../board-view';
import type { BoardItem } from '../../../blackboard/types';

const FILE_LOCKS_KEY = Symbol.for('opencode_swarm.fileLocks.v1');

// swarmRunID → file → set of in-progress todo IDs
type LockTable = Map<string, Map<string, Set<string>>>;

function table(): LockTable {
  const g = globalThis as { [FILE_LOCKS_KEY]?: LockTable };
  if (!g[FILE_LOCKS_KEY]) g[FILE_LOCKS_KEY] = new Map();
  return g[FILE_LOCKS_KEY]!;
}

function forRun(swarmRunID: string): Map<string, Set<string>> {
  const t = table();
  let run = t.get(swarmRunID);
  if (!run) {
    run = new Map();
    t.set(swarmRunID, run);
  }
  return run;
}

export class FileLockSet {
  // Add expected files to the lock set for a todo. Called after CAS claim
  // succeeds (todo → in-progress). Idempotent — re-acquiring the same
  // todo's files is a no-op.
  static acquire(swarmRunID: string, todoID: string, files: string[]): void {
    if (files.length === 0) return;
    const run = forRun(swarmRunID);
    for (const f of files) {
      const holders = run.get(f) ?? new Set();
      holders.add(todoID);
      run.set(f, holders);
    }
  }

  // Remove all files locked by a todo. Called when the todo transitions
  // to done or stale. Idempotent.
  static release(swarmRunID: string, todoID: string): void {
    const run = table().get(swarmRunID);
    if (!run) return;
    for (const [file, holders] of run) {
      holders.delete(todoID);
      if (holders.size === 0) run.delete(file);
    }
    if (run.size === 0) table().delete(swarmRunID);
  }

  // Returns true if ANY of the given files is locked by a different todo
  // (not the caller's own todo). Used by pickClaim to skip candidates that
  // would conflict with in-progress work.
  static isLocked(
    swarmRunID: string,
    files: string[],
    ownTodoID?: string,
  ): boolean {
    if (files.length === 0) return false;
    const run = table().get(swarmRunID);
    if (!run) return false;
    for (const f of files) {
      const holders = run.get(f);
      if (!holders || holders.size === 0) continue;
      // Allow the same todo to re-claim (retry path — release+reacquire)
      if (ownTodoID && holders.size === 1 && holders.has(ownTodoID)) continue;
      return true;
    }
    return false;
  }

  // Reconstruct lock set from board state. Called once per run on ticker
  // boot (in ensureSlots). Reads every in-progress item's expectedFiles
  // and populates the lock table. Idempotent — second call on the same
  // run is a no-op (replaces, same result).
  static rebuild(swarmRunID: string): void {
    invalidateBoardView(swarmRunID); // force fresh scan
    const view = getBoardView(swarmRunID);
    const locked = view.inProgress.filter(
      (i: BoardItem) => i.expectedFiles && i.expectedFiles.length > 0,
    );
    const run = forRun(swarmRunID);
    run.clear();
    for (const item of locked) {
      for (const f of item.expectedFiles!) {
        const holders = run.get(f) ?? new Set();
        holders.add(item.id);
        run.set(f, holders);
      }
    }
  }
}
