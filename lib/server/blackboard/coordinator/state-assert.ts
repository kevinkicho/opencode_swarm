//
// State-machine hardening — diagnostic assertions at dispatch phase
// boundaries. Each check re-reads the board item's current status and
// compares against the expected state. Mismatches are logged as warnings
// and recorded as findings — but never throw (fail-open per project
// degradation philosophy).
//
// The coordinator walks: open → claimed → in-progress → done/stale.
// If a debug endpoint, manual intervention, or race condition silently
// moves an item while the coordinator pipeline is mid-flight, these
// assertions surface the corruption before the pipeline proceeds with
// stale assumptions.
//
// See docs/SYSTEMATIC_FIXES.md § "State-machine hardening"

import 'server-only';

import { transitionStatus } from '../store';
import { insertBoardItem } from '../store';
import { mintItemId } from '../item-ids';
import type { BoardItemStatus } from '../../../blackboard/types';

// Check that an item is in the expected status. Returns the current item
// state so callers can decide whether to continue or abort.
export function assertItemStatus(
  swarmRunID: string,
  itemID: string,
  expected: BoardItemStatus | BoardItemStatus[],
): { ok: true; status: BoardItemStatus } | { ok: false; status: BoardItemStatus; expected: string } {
  // Re-read the item via a no-op transition (from=expected, to=expected).
  // If the item is in the expected state, the transition is a no-op (changes=0
  // but ok=true because the row matched the WHERE clause). If the item has
  // moved, the transition fails and we get the current status.
  const expectedArr = Array.isArray(expected) ? expected : [expected];
  const firstExpected = expectedArr[0];

  const check = transitionStatus(swarmRunID, itemID, {
    from: expectedArr as BoardItemStatus[],
    to: firstExpected, // no-op transition
  });

  if (check.ok) {
    return { ok: true, status: firstExpected };
  }

  const actual = check.currentStatus ?? 'unknown';
  const expectedStr = expectedArr.join('|');
  return { ok: false, status: actual as BoardItemStatus, expected: expectedStr };
}

// Record a state-machine violation as a finding on the board.
export function recordStateViolation(
  swarmRunID: string,
  itemID: string,
  expected: string,
  actual: string,
  phase: string,
): void {
  const finding = `[state-violation] ${phase}: item ${itemID.slice(-8)} expected ${expected} but was ${actual}`;
  console.warn(`[coordinator] ${finding}`);
  try {
    insertBoardItem(swarmRunID, {
      id: mintItemId(),
      kind: 'finding',
      content: finding,
      status: 'open',
      createdAtMs: Date.now(),
    });
  } catch (err) {
    // Non-fatal — the finding is informational
  }
}
