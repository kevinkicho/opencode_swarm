// Long-running cadenced planner sweep. Fires on a timer regardless of
// whether the board is idle — the point is to periodically re-examine
// the repo as it evolves under the workers' edits and seed fresh todos
// the original planner pass couldn't see. Uses `resweepInFlight` as a
// mutex so concurrent sweep requests collapse to one.

import 'server-only';

import { listBoardItems } from '../store';
import { livePlanner } from './live-exports';
import {
  MAX_ORCHESTRATOR_REPLANS,
  orchestratorReplanCapHit,
} from './policies';
import { stopAutoTicker } from './stop';
import {
  MIN_MS_BETWEEN_SWEEPS,
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
    } else {
      console.log(
        `[board/auto-ticker] ${swarmRunID}: periodic sweep produced no new work (planner returned ${result.items.length} total items)`,
      );
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
}
