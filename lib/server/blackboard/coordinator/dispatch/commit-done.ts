//
// commitDone — final transition from in-progress → done via the unified
// transitionItem. FileLockSet.release is handled inside transitionItem.
//

import 'server-only';

import { transitionItem } from '../transition-item';
import type { TickOutcome } from '../types';
import type { GatedContext } from './_context';

export async function commitDone(gated: GatedContext): Promise<TickOutcome> {
  const { meta, sessionID, todo, fileHashes, editedPaths } = gated;

  await transitionItem(meta.swarmRunID, todo, 'done', {
    fileHashes,
    setCompletedAt: true,
  });

  return { status: 'picked', sessionID, itemID: todo.id, editedPaths };
}
