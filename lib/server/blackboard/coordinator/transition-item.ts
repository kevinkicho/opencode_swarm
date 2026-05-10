//
// Unified state transition — consolidates 5 scattered stale/done paths
// into a single function. Every board item state change flows through
// here, ensuring FileLockSet.release, finding recording, and board-view
// invalidation fire uniformly regardless of which path triggered the
// transition.
//
// Paths consolidated (pre-fix, each path duplicated at least two of
// FileLockSet.release / finding / transitionStatus):
//   1. commitDone        — in-progress → done    (normal completion)
//   2. commitDone (fail) — in-progress → stale   (CAS lost)
//   3. retryOrStale       — in-progress → open    (retry)
//   4. retryOrStale       — in-progress → stale   (final, + finding)
//   5. finalizeRetryExhaustedItems — open → stale (+ finding)
//   6. runGateChecks stale              (gate rejection, transition handled
//      in runGateChecks, lock release handled here via dispatch.ts)
//
// See docs/SYSTEMATIC_FIXES.md § "Unified state transition"

import 'server-only';

import { transitionStatus, insertBoardItem } from '../store';
import { mintItemId } from '../item-ids';
import { FileLockSet } from './file-locks';
import { invalidateBoardView } from '../board-view';
import type { BoardItem, BoardItemStatus } from '../../../blackboard/types';

export type TransitionTarget = 'done' | 'stale' | 'retry';

export interface TransitionResult {
  ok: true;
  newStatus: BoardItemStatus;
}

function recordStaleFinding(swarmRunID: string, item: BoardItem, reason: string): void {
  const content = `[stale] ${item.content.length > 80 ? item.content.slice(0, 77).trimEnd() + '…' : item.content}`;
  const note = reason.length > 150 ? reason.slice(0, 147).trimEnd() + '…' : reason;
  try {
    insertBoardItem(swarmRunID, {
      id: mintItemId(),
      kind: 'finding',
      status: 'done',
      content,
      note,
      createdAtMs: Date.now(),
    });
  } catch (err) {
    console.warn(
      `[transition-item] failed to insert stale finding for ${item.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function transitionItem(
  swarmRunID: string,
  item: BoardItem,
  target: TransitionTarget,
  opts: {
    reason?: string;
    fileHashes?: { path: string; sha: string }[] | null;
    retryCount?: number;
    maxRetries?: number;
    setCompletedAt?: boolean;
  } = {},
): Promise<TransitionResult> {
  // File locks released on every stale/done. Retry (open) also releases
  // so the re-claim path doesn't block on the same agent's own lock.
  if (target === 'done' || target === 'stale' || target === 'retry') {
    FileLockSet.release(swarmRunID, item.id);
  }

  if (target === 'retry') {
    const retries = opts.retryCount ?? 0;
    const max = opts.maxRetries ?? 2;
    if (retries < max - 1) {
      const note = `[retry:${retries + 1}] ${opts.reason ?? ''}`.slice(0, 200);
      transitionStatus(swarmRunID, item.id, {
        from: 'in-progress',
        to: 'open',
        ownerAgentId: null,
        fileHashes: null,
        note,
      });
      return { ok: true, newStatus: 'open' };
    }
    // Fall through to stale — retry budget exhausted
  }

  if (target === 'done') {
    transitionStatus(swarmRunID, item.id, {
      from: 'in-progress',
      to: 'done',
      fileHashes: opts.fileHashes && opts.fileHashes.length > 0 ? opts.fileHashes : null,
      setCompletedAt: opts.setCompletedAt ?? true,
    });
    invalidateBoardView(swarmRunID);
    return { ok: true, newStatus: 'done' };
  }

  // target === 'stale' (or retry-exhausted falling through)
  const from: BoardItemStatus[] = item.status === 'open' ? ['open'] : ['in-progress'];
  const note = opts.reason
    ? `[final] ${opts.reason}`.slice(0, 200)
    : `[final] transitioned to stale`.slice(0, 200);

  transitionStatus(swarmRunID, item.id, {
    from,
    to: 'stale',
    note,
  });

  // Record finding for stale transitions — operator visibility
  if (opts.reason) {
    recordStaleFinding(swarmRunID, item, opts.reason);
  }

  invalidateBoardView(swarmRunID);
  return { ok: true, newStatus: 'stale' };
}
