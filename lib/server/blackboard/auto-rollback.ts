// Auto-rollback — revert a worker's file edits when a gate rejects the
// item. When a critic, verifier, or build gate bounces a todo to stale,
// the worker's edits are still on disk. Without rollback, the next
// worker that claims the item sees the prior worker's half-done state,
// which can confuse the LLM or create merge conflicts.
//
// This module reads the list of editedPaths and runs `git checkout --`
// on each to restore the pre-edit state. It's called from
// run-gate-checks after any stale transition.
//
// Safety: only rolls back files that were in the worker's patch parts.
// Files not touched by this worker are left alone. If git checkout
// fails (detached HEAD, no git repo, etc.), the failure is logged but
// does not block the stale transition — the next worker gets a fresh
// attempt on a potentially-dirty tree, which is better than blocking.

import 'server-only';

import { execFile } from 'node:child_process';
import path from 'node:path';

export interface RollbackInput {
  workspace: string;
  editedPaths: string[];
  timeoutMs?: number;
}

export interface RollbackResult {
  rolledBack: string[];
  failed: Array<{ path: string; error: string }>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export async function rollbackEditedFiles(
  input: RollbackInput,
): Promise<RollbackResult> {
  const { workspace, editedPaths, timeoutMs = DEFAULT_TIMEOUT_MS } = input;

  if (editedPaths.length === 0) {
    return { rolledBack: [], failed: [] };
  }

  const cwd = path.resolve(workspace);
  const rolledBack: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  // Batch: git checkout -- file1 file2 ... is faster than one-per-file.
  // Split into batches of 20 to avoid arg-length limits.
  const batchSize = 20;
  for (let i = 0; i < editedPaths.length; i += batchSize) {
    const batch = editedPaths.slice(i, i + batchSize);
    try {
      await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'git',
      ['restore', '--source=HEAD', '--', ...batch],
          { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
          (error) => {
            if (error) reject(error);
            else resolve();
          },
        );
        child.on('error', reject);
      });
      rolledBack.push(...batch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const p of batch) {
        failed.push({ path: p, error: msg });
      }
    }
  }

  return { rolledBack, failed };
}