// Stale-retry budget. When a worker times out or errors on a todo,
// instead of terminating the todo as `stale` forever, requeue it as
// `open` so another tick can pick it up. The retry count is stored in
// the todo's note — after MAX_STALE_RETRIES, the item stays stale.
//
// Why: a single transient failure (slow tool call, temporarily-offline
// upstream, hit a 5-min deadline mid-work) shouldn't drop the todo from
// the swarm's work queue. The user was explicit about wanting stale
// items to not "die silently."
//
// Extracted from coordinator.ts in #107 phase 2.

import 'server-only';

import { transitionStatus } from '../store';
import type { BoardItem } from '../../../blackboard/types';

export const MAX_STALE_RETRIES = 2;
const RETRY_TAG_RE = /^\[retry:(\d+)\]\s*/;

export function currentRetryCount(note: string | null | undefined): number {
  if (!note) return 0;
  const m = RETRY_TAG_RE.exec(note);
  return m ? Number(m[1]) : 0;
}

// Transition an in-progress item into either `open` (retry) or `stale`
// (final) based on accumulated retry count in the note field. Preserves
// the failure reason in the note so inspector / rail views still show
// why the previous attempt failed.
export function retryOrStale(
  swarmRunID: string,
  item: BoardItem,
  reason: string,
): 'retry' | 'stale' {
  const retries = currentRetryCount(item.note);
  if (retries < MAX_STALE_RETRIES) {
    const nextNote = `[retry:${retries + 1}] ${reason}`.slice(0, 200);
    transitionStatus(swarmRunID, item.id, {
      from: 'in-progress',
      to: 'open',
      ownerAgentId: null,
      fileHashes: null,
      note: nextNote,
    });
    return 'retry';
  }
  transitionStatus(swarmRunID, item.id, {
    from: 'in-progress',
    to: 'stale',
    note: `[final after ${retries} retries] ${reason}`.slice(0, 200),
  });
  return 'stale';
}

// #76 — extract the human-readable failure reason from a retry note so
// it can be surfaced to the model on re-dispatch. Notes have the shape
// `[retry:N] <reason>` (set by retryOrStale). Returns null when the note
// is absent or doesn't carry a retry tag. Exported for unit tests.
export function extractRetryFailureReason(
  note: string | null | undefined,
): { attempt: number; reason: string } | null {
  if (!note) return null;
  const m = RETRY_TAG_RE.exec(note);
  if (!m) return null;
  const attempt = Number(m[1]);
  const reason = note.slice(m[0].length).trim();
  if (!reason) return { attempt, reason: '(no reason recorded)' };
  return { attempt, reason };
}
