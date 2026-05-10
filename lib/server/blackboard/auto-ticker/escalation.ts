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
import { isRetryExhausted } from './policies';
import { getBoardView } from '../board-view';
import { runDualPlannerSweep } from '../planner/dual-sweep';

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
  // F4: dedup — skip if a finding for this same tier already exists,
  // so re-entrant escalation (e.g. ticker restart after HMR) doesn't
  // stack duplicate ratchet rows.
  const tierTag = `[ratchet] Escalated to tier ${nextTier}`;
  const existingFindings = listBoardItems(state.swarmRunID).filter(
    (i) => i.kind === 'finding' && i.content.startsWith(tierTag),
  );
  if (existingFindings.length === 0) {
    insertBoardItem(state.swarmRunID, {
      id: mintItemId(),
      kind: 'finding',
      content: `${tierTag}: ${tierLabel}`,
      status: 'done',
      createdAtMs: Date.now(),
    });
  }

  // Fire a planner sweep at the new tier. If it produces fresh work,
  // the run continues; if not, the idle-stop path will fire on the
  // next tick cycle.
  try {
    // FTA: at tier 3+, use dual-planner sweeps (AND-gate).
    // Drops planner failure probability from 15% to 2.25% for critical runs.
    const result = nextTier >= 3
      ? await runDualPlannerSweep(state.swarmRunID, {
          overwrite: true,
          includeBoardContext: true,
          escalationTier: nextTier,
        })
      : await livePlanner().runPlannerSweep(state.swarmRunID, {
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
      state.consecutiveFilteredAllTodos = 0;
      state.consecutiveNoClaimableWork = 0;
      return true;
    }
    console.log(
      `[board/auto-ticker] ${state.swarmRunID}: tier-${nextTier} sweep produced no new todos`,
    );
  } catch (err) {
    state.plannerErrors += 1;
    console.warn(
      `[board/auto-ticker] ${state.swarmRunID}: tier-${nextTier} sweep threw:`,
      err instanceof Error ? err.message : String(err),
    );
    // F4: dedup — only insert the error finding if one for this exact
    // tier sweep failure doesn't already exist.
    const errorTag = `[ratchet] Tier-${nextTier} sweep error:`;
    const existingErrorFinding = listBoardItems(state.swarmRunID).find(
      (i) => i.kind === 'finding' && i.content.startsWith(errorTag),
    );
    if (!existingErrorFinding) {
      insertBoardItem(state.swarmRunID, {
        id: mintItemId(),
        kind: 'finding',
        content: `${errorTag} ${err instanceof Error ? err.message : String(err)}`,
        status: 'done',
        createdAtMs: Date.now(),
      });
    }
  }

  return false;
}

// Check whether the board still has forward-progress work. Returns true
// when ANY work-class item (todo, claim) is in flight OR when open/
// blocked criteria still need auditor verification. Used by tick.ts and
// sweep.ts to prevent premature auto-stop when verification work remains.
//
// BUG FIX (2026-05-07): Items that are `open` but retry-exhausted
// (note contains [retry:N] where N >= MAX_STALE_RETRIES) are NOT
// claimable — workers can't pick them up. They were inflating the
// "work in flight" count and preventing idle-drained auto-stop even
// though no forward progress was possible. Now excluded.
//
// BUG FIX (2026-05-08 F2): Open/blocked criteria represent pending
// auditor verification — the run isn't truly drained until those
// verdicts land. Without this check, consecutiveNoClaimableWork
// would fire when all todos are done/stale but criteria still need
// judging, stopping the ticker before the auditor can run.
export function boardHasWorkInFlight(swarmRunID: string): boolean {
  const view = getBoardView(swarmRunID);
  for (const item of view.criteria) {
    if (item.status === 'open' || item.status === 'blocked') return true;
  }
  // Check open todos, excluding retry-exhausted ones that pickClaim filters out
  for (const item of view.openTodos) {
    if (!isRetryExhausted(item.note)) return true;
  }
  return view.inProgress.length > 0;
}