// HARDENING_PLAN.md#C4 — tickCoordinator decomposition phase 5.
//
// commitDone — final transitionStatus from in-progress → done. The CAS
// can lose if something else moved the row mid-flight (rare; the
// dispatch-mutex makes within-run concurrency impossible, but a
// /board/:itemId/state route could still flip the row from outside).
// Surface the observed status so the caller can re-read.

import 'server-only';

import { transitionStatus } from '../../store';
import type { TickOutcome } from '../types';
import type { GatedContext } from './_context';

export function commitDone(gated: GatedContext): TickOutcome {
  const { meta, sessionID, todo, fileHashes, editedPaths } = gated;

  const done = transitionStatus(meta.swarmRunID, todo.id, {
    from: 'in-progress',
    to: 'done',
    fileHashes: fileHashes.length > 0 ? fileHashes : null,
    setCompletedAt: true,
  });
  if (!done.ok) {
    // Something else moved it mid-flight. Surface the observed state so
    // the caller can re-read and decide.
    return {
      status: 'stale',
      sessionID,
      itemID: todo.id,
      reason: `done-transition lost: ${done.currentStatus}`,
    };
  }

  return { status: 'picked', sessionID, itemID: todo.id, editedPaths };
}
