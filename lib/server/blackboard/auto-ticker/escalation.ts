// Ambition ratchet — tier escalation when the board drains at the
// current ambition band.
//
// When all work-class items on the board are done/stale and the ticker
// is about to auto-stop with 'auto-idle-drained', the ratchet bumps the
// tier and fires a fresh planner sweep at the new, higher-ambition level.
// If the sweep produces new work, the run continues. If not, the run
// stops — we've exhausted the codebase at the highest tier.
//
// Each tier scales the planner's scope via the prompt preamble passed to
// `runPlannerSweep(escalationTier)`. The planner shifts from bug fixes
// (tier 1) up to architectural changes and new features (tier 4+).
//
// Extracted so tick.ts and sweep.ts can import without circular deps.

import 'server-only';

import { insertBoardItem } from '../store';
import { livePlanner } from './live-exports';
import { maybeRunAudit } from './audit';
import { mintItemId } from '../planner';
import { updateRunMeta } from '../../swarm-registry';
import { MAX_TIER, TIER_LADDER } from './types';
import type { TickerState } from './types';
import { listBoardItems } from '../store';

export async function attemptTierEscalation(
  state: TickerState,
): Promise<boolean> {
  if (state.stopped) return false;
  if (state.currentTier >= MAX_TIER) return false;

  const nextTier = state.currentTier + 1;
  const tierLabel = TIER_LADDER[nextTier - 1] ?? `Tier ${nextTier}`;
  console.log(
    `[board/auto-ticker] ${state.swarmRunID}: board drained at tier ${state.currentTier} — escalating to tier ${nextTier} ("${tierLabel}")`,
  );

  // Audit pending criteria at the old tier so the new sweep sees fresh
  // verdicts. tier-escalation reason triggers audit even if the cadence
  // counter hasn't expired yet.
  try {
    await maybeRunAudit(state, 'tier-escalation');
  } catch (err) {
    console.warn(
      `[board/auto-ticker] ${state.swarmRunID}: tier-escalation audit threw:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Bump tier before the sweep so the planner prompt reflects the new
  // ambition level. Persist to meta so a ticker restart lands at the
  // correct tier.
  state.currentTier = nextTier;
  try {
    await updateRunMeta(state.swarmRunID, { currentTier: nextTier });
  } catch (err) {
    // Log but don't block — the in-memory state is authoritative for
    // this tick cycle. Meta persist is for crash recovery.
    console.warn(
      `[board/auto-ticker] ${state.swarmRunID}: tier persist failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Record an escalation finding on the board for observability.
  insertBoardItem(state.swarmRunID, {
    id: mintItemId(),
    kind: 'finding',
    content: `[ratchet] Escalated to tier ${nextTier}: ${tierLabel}`,
    status: 'done',
    createdAtMs: Date.now(),
  });

  // Fire a planner sweep at the new tier. If it produces fresh work,
  // the run continues; if not, the idle-stop path will fire on the
  // next tick cycle.
  try {
    const result = await livePlanner().runPlannerSweep(state.swarmRunID, {
      overwrite: true,
      includeBoardContext: true,
      escalationTier: nextTier,
    });
    const newWork = result.items.filter(
      (i) => i.status === 'open' && i.kind === 'todo',
    ).length;
    if (newWork > 0) {
      console.log(
        `[board/auto-ticker] ${state.swarmRunID}: tier-${nextTier} sweep produced ${newWork} new todo(s) — resuming`,
      );
      // Reset idle counters so sessions pick up the new work.
      for (const slot of state.slots.values()) slot.consecutiveIdle = 0;
      return true;
    }
    console.log(
      `[board/auto-ticker] ${state.swarmRunID}: tier-${nextTier} sweep produced no new todos`,
    );
  } catch (err) {
    console.warn(
      `[board/auto-ticker] ${state.swarmRunID}: tier-${nextTier} sweep threw:`,
      err instanceof Error ? err.message : String(err),
    );
    // Record the sweep failure as a finding for observability.
    insertBoardItem(state.swarmRunID, {
      id: mintItemId(),
      kind: 'finding',
      content: `[ratchet] Tier-${nextTier} sweep error: ${err instanceof Error ? err.message : String(err)}`,
      status: 'done',
      createdAtMs: Date.now(),
    });
  }

  return false;
}

// Check whether the board has zero work-class items in flight (open,
// claimed, or in-progress todos). Used by tick.ts to decide whether
// idle-stop should attempt tier escalation first.
export function boardHasWorkInFlight(swarmRunID: string): boolean {
  const items = listBoardItems(swarmRunID);
  for (const item of items) {
    if (item.kind !== 'todo' && item.kind !== 'claim') continue;
    if (
      item.status === 'open' ||
      item.status === 'claimed' ||
      item.status === 'in-progress'
    ) {
      return true;
    }
  }
  return false;
}