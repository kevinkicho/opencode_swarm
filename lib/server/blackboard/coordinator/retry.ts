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

import { listBoardItems } from '../store';
import { transitionItem } from './transition-item';
import { transitionStatus } from '../store';
import type { BoardItem } from '../../../blackboard/types';

// Default max retries before an item goes permanently stale.
// Can be reduced per-model via getMaxRetries — weaker models get fewer
// retries because they burn through them faster (silence/abort patterns).
export const MAX_STALE_RETRIES = 2;
const RETRY_TAG_RE = /^\[retry:(\d+)\]\s*/;

// P6: model-aware retry budget. Models with known capability limitations
// get fewer retries to avoid wasting tokens on repeated failures.
// - gemma/llama families: 1 retry (they're prone to silent/abort on
//   complex multi-file tasks)
// - everything else: 2 retries (the current default)
export function getMaxRetries(teamModels: readonly string[], sessionIndex: number): number {
  const model = teamModels[sessionIndex] ?? '';
  const lower = model.toLowerCase();
  // Coarser model families get 1 retry instead of 2
  if (/gemma|llama|mistral-small|phi|qwen2\.5-.*0\.5b|qwen2\.5-.*1\.5b/i.test(lower)) {
    return 1;
  }
  return MAX_STALE_RETRIES;
}

export function currentRetryCount(note: string | null | undefined): number {
  if (!note) return 0;
  const m = RETRY_TAG_RE.exec(note);
  return m ? Number(m[1]) : 0;
}

// Transition an in-progress item into either `open` (retry) or `stale`
// (final) based on accumulated retry count in the note field. Preserves
// the failure reason in the note so inspector / rail views still show
// why the previous attempt failed.
//
// BUG FIX (2026-05-07): The previous `< MAX_STALE_RETRIES` boundary was
// a fencepost error. When retries=1 (second failure), the condition
// `1 < 2` was true, so the item went back to `open` with note `[retry:2]`.
// But pickClaim's filter uses `currentRetryCount(note) >= MAX_STALE_RETRIES`
// which treated `[retry:2]` (count=2) as unclaimable. The item was stuck:
// not claimable, but never routed through retryOrStale again (which only
// runs on in-progress items). The fix uses `>= MAX_STALE_RETRIES - 1`
// so the LAST retry goes directly to `stale` instead of cycling through
// `open` where it becomes unclaimable.
export async function retryOrStale(
  swarmRunID: string,
  item: BoardItem,
  reason: string,
  maxRetries: number = MAX_STALE_RETRIES,
): Promise<'retry' | 'stale'> {
  const retries = currentRetryCount(item.note);

  const result = await transitionItem(swarmRunID, item, 'retry', {
    reason,
    retryCount: retries,
    maxRetries,
  });

  return result.newStatus === 'open' ? 'retry' : 'stale';
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

// Safety net: transition any `open` items that have retry count >=
// MAX_STALE_RETRIES to `stale`. These items are unclaimable (pickClaim
// excludes them) but stuck in `open` status forever because retryOrStale
// only runs on `in-progress` items. Called at tick-start to unstick
// items that fell through the pre-fix fencepost or were orphaned by a
// server restart mid-retry.
//
// Returns the number of items transitioned so callers can log it.
export async function finalizeRetryExhaustedItems(swarmRunID: string): Promise<number> {
  const items = listBoardItems(swarmRunID);
  let fixed = 0;
  for (const item of items) {
    if (item.status !== 'open') continue;
    if (item.kind !== 'todo' && item.kind !== 'question' && item.kind !== 'synthesize') continue;
    if (currentRetryCount(item.note) >= MAX_STALE_RETRIES) {
      await transitionItem(swarmRunID, item, 'stale', {
        reason: `retry-exhausted safety net (${currentRetryCount(item.note)} retries)`,
      });
      fixed += 1;
    }
  }
  return fixed;
}

// UML State Machine 5.3: Claims stuck in `claimed` have no timeout transition.
// If the process crashes between open→claimed and claimed→in-progress (rare —
// microseconds gap), the item is permanently claimed. This safety net transitions
// any `claimed` item older than CLAIMED_ZOMBIE_MS to stale.
const CLAIMED_ZOMBIE_MS = 10 * 60_000; // 10 minutes

export function finalizeClaimedZombies(swarmRunID: string): number {
  const items = listBoardItems(swarmRunID);
  const cutoff = Date.now() - CLAIMED_ZOMBIE_MS;
  let fixed = 0;
  for (const item of items) {
    if (item.status !== 'claimed') continue;
    if (item.createdAtMs > cutoff) continue;
    transitionStatus(swarmRunID, item.id, {
      from: 'claimed',
      to: 'stale',
      note: '[zombie-cleanup] claimed item exceeded 10-min timeout',
    });
    fixed += 1;
  }
  if (fixed > 0) {
    console.log(`[retry] finalized ${fixed} claimed zombie(s) to stale in ${swarmRunID}`);
  }
  return fixed;
}
