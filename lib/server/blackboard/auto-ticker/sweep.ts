// Long-running cadenced planner sweep. Unlike attemptTierEscalation
// (auto-idle path that bumps tier per attempt), this fires on a timer
// regardless of whether the board is idle — the point is to periodically
// re-examine the repo as it evolves under the workers' edits and seed
// fresh todos the original planner pass couldn't see. Reuses
// `resweepInFlight` as a mutex with the escalation path so the two
// can't collide. Periodic sweeps do NOT bump tier today — they stay
// at whatever `currentTier` the run has reached via escalation. Tying
// periodic-mode to tier escalation is a future layer.
//
// Extracted from auto-ticker.ts in #106 phase 4.

import 'server-only';

import { listBoardItems } from '../store';
import { livePlanner } from './live-exports';
import {
  isRetryExhausted,
  MAX_ORCHESTRATOR_REPLANS,
  orchestratorReplanCapHit,
} from './policies';
import { stopAutoTicker } from './stop';
import { attemptTierEscalation } from './tier-escalation';
import {
  MIN_MS_BETWEEN_SWEEPS,
  PERIODIC_DRAIN_TIER_THRESHOLD,
  type TickerState,
} from './types';

export async function runPeriodicSweep(state: TickerState): Promise<void> {
  if (state.stopped) return;
  if (state.resweepInFlight) return;

  // tier-escalation path. A long-running orchestrator-worker run
  // can rack up sweeps via either path; the cap counts both.
  if (await orchestratorReplanCapHit(state.swarmRunID)) {
    console.warn(
      `[board/auto-ticker] ${state.swarmRunID}: orchestrator hit MAX_ORCHESTRATOR_REPLANS=${MAX_ORCHESTRATOR_REPLANS} — periodic sweep skipped, stopping ticker (replan-loop-exhausted)`,
    );
    stopAutoTicker(state.swarmRunID, 'replan-loop-exhausted');
    return;
  }
  // Floor to prevent stacking: if a sweep just fired, skip this one.
  // Both the periodic timer and the eager-idle check route here, so
  // whichever one wins the race first is the one that runs.
  const sinceLast = Date.now() - (state.lastSweepAtMs ?? 0);
  if (sinceLast < MIN_MS_BETWEEN_SWEEPS) {
    console.log(
      `[board/auto-ticker] ${state.swarmRunID}: sweep requested ${Math.round(sinceLast / 1000)}s after last — under ${MIN_MS_BETWEEN_SWEEPS / 1000}s floor, skipping`,
    );
    return;
  }
  const swarmRunID = state.swarmRunID;
  state.resweepInFlight = true;
  state.lastSweepAtMs = Date.now();
  // Post-sweep flag: true when the periodic sweep produced no new
  // work AND the board carries no active items. Escalation fires
  // after the mutex is released (see block below) so it can
  // re-acquire cleanly via attemptTierEscalation's own flag handling.
  let shouldTryEscalation = false;
  try {
    const beforeOpen = listBoardItems(swarmRunID).filter(
      (i) => i.status === 'open',
    ).length;
    // overwrite: true bypasses the "board already populated" planner
    // guard. includeBoardContext: true feeds the planner the already-
    // done list so it stops re-proposing stale items — critical over an
    // 8h run where the same things would otherwise get suggested 24×.
    const result = await livePlanner().runPlannerSweep(swarmRunID, {
      overwrite: true,
      includeBoardContext: true,
    });
    const afterOpen = listBoardItems(swarmRunID).filter(
      (i) => i.status === 'open',
    ).length;
    const newlyOpen = afterOpen - beforeOpen;
    if (newlyOpen > 0) {
      console.log(
        `[board/auto-ticker] ${swarmRunID}: periodic sweep seeded ${newlyOpen} new open todo(s) — resetting idle counters`,
      );
      for (const slot of state.slots.values()) slot.consecutiveIdle = 0;
      state.consecutiveDrainedSweeps = 0;
    } else {
      console.log(
        `[board/auto-ticker] ${swarmRunID}: periodic sweep produced no new work (planner returned ${result.items.length} total items)`,
      );
      // Count this as "drained" only if workers are also done — if
      // there's active work, the planner-is-quiet state is normal
      // (workers are still chewing through the last sweep's output).
      //
      // re-kick. Open items carrying a `[retry:N]` note where N≥2
      // are workers-refused-twice, not active work. Treating them as
      // "active" stranded run_mob31bx6_jzdfs2 — the ratchet stayed
      // dormant because the predicate said "work available" while
      // every worker had already declined. Exclude retry-exhausted
      // open items from the active count so the next sweep can
      // either rephrase them at a higher tier or drop them.
      const activeCount = listBoardItems(swarmRunID).filter((i) => {
        if (
          i.status !== 'open' &&
          i.status !== 'claimed' &&
          i.status !== 'in-progress'
        ) {
          return false;
        }
        if (i.status === 'open' && isRetryExhausted(i.note)) {
          return false;
        }
        return true;
      }).length;
      if (activeCount === 0) {
        state.consecutiveDrainedSweeps += 1;
        if (
          state.consecutiveDrainedSweeps >= PERIODIC_DRAIN_TIER_THRESHOLD &&
          !state.tierExhausted
        ) {
          shouldTryEscalation = true;
        }
      } else {
        state.consecutiveDrainedSweeps = 0;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[board/auto-ticker] ${swarmRunID}: periodic sweep threw:`,
      message,
    );
  } finally {
    state.resweepInFlight = false;
  }
  // Periodic-mode tier escalation: fire AFTER the mutex is released so
  // attemptTierEscalation's own flag management (set-at-entry-via-
  // caller convention) doesn't conflict. Resets the drained counter
  // immediately so we don't re-fire on the next sweep if the
  // escalation itself produces empty.
  if (shouldTryEscalation) {
    console.log(
      `[board/auto-ticker] ${swarmRunID}: ${state.consecutiveDrainedSweeps}+ drained periodic sweeps and zero active board items — firing tier escalation from periodic-mode`,
    );
    state.consecutiveDrainedSweeps = 0;
    state.resweepInFlight = true;
    await attemptTierEscalation(state);
  }
}
