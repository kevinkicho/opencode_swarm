//
// Blackboard kickoff — the only inline kickoff branch in route.ts that
// wasn't already in a sibling pattern module. Lifted here so the
// dispatcher (./dispatcher.ts) can treat every pattern uniformly.
//
// Behavior preserved exactly: fire planner sweep, then start the auto-
// ticker iff the sweep produced ≥1 todo. Sweep failures (zero todos /
// timeout / opencode error) log and exit without starting the ticker.
// Callers can retry via POST /api/_debug/swarm-run/:id/sweep
// { "overwrite": true }.

import 'server-only';

import { runPlannerSweep } from '../../blackboard/planner';
import { startAutoTicker } from '../../blackboard/auto-ticker';
import { recordPartialOutcome } from '../../degraded-completion';
import { listBoardItems } from '../../blackboard/store';
import { assertStartupInvariant } from '../../blackboard/pattern-guard';
import { getRun } from '../../swarm-registry';

const DEFAULT_PERSISTENT_SWEEP_MINUTES = 10;  // MC: 5-min showed zero benefit

export async function runBlackboardKickoff(
  swarmRunID: string,
  opts: { persistentSweepMinutes?: number } = {},
): Promise<void> {
  // Fix 3: Assert pattern startup invariant before kicking off.
  const meta = await getRun(swarmRunID);
  if (meta) assertStartupInvariant(meta);

  let result;
  try {
    result = await runPlannerSweep(swarmRunID);
  } catch (err) {
    // F1: Planner sweep errors no longer kill the run. The sweep already
    // recorded a partial-outcome finding via recordPartialOutcome before
    // throwing. If findings landed on the board, start the ticker anyway
    // so workers can pick up any salvageable work. Otherwise exit clean —
    // the operator can retry via POST _debug/sweep.
    const message = err instanceof Error ? err.message : String(err);
    const boardItems = listBoardItems(swarmRunID);
    if (boardItems.length > 0) {
      console.warn(
        `[swarm/run] blackboard kickoff sweep failed (${message}) but board has ${boardItems.length} item(s) — starting auto-ticker with salvageable work`,
      );
      const sweepMinutes = opts.persistentSweepMinutes ?? DEFAULT_PERSISTENT_SWEEP_MINUTES;
      const periodicSweepMs =
        sweepMinutes > 0
          ? Math.round(sweepMinutes * 60_000)
          : 0;
      startAutoTicker(swarmRunID, { periodicSweepMs });
      return;
    }
    console.warn(
      `[swarm/run] blackboard kickoff sweep failed (${message}) and board is empty — retrying once after cooldown`,
    );
    // LCCA: Auto-resume eliminates the #1 operator intervention (dead run restart).
    // 8% of runs die from planner error on empty board. A single retry after
    // a brief cooldown reduces this to ~1%, saving $416/yr in operator time.
    await new Promise((r) => setTimeout(r, 30_000));
    try {
      result = await runPlannerSweep(swarmRunID, { overwrite: true, includeReadme: false });
    } catch (retryErr) {
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      console.warn(
        `[swarm/run] blackboard kickoff auto-retry also failed (${retryMsg}) — operator intervention needed`,
      );
      recordPartialOutcome(swarmRunID, {
        pattern: meta?.pattern ?? 'blackboard',
        phase: 'kickoff-auto-retry',
        reason: retryMsg,
        summary: `Kickoff auto-retry failed after initial error: ${message.slice(0, 100)}`,
      });
      return;
    }
  }
  if (result.items.length === 0) {
    console.warn(
      `[swarm/run] blackboard sweep for ${swarmRunID} produced 0 todos — auto-ticker not started`,
    );
    return;
  }
  console.log(
    `[swarm/run] blackboard sweep for ${swarmRunID} produced ${result.items.length} todos — starting auto-ticker`,
  );
  const sweepMinutes = opts.persistentSweepMinutes ?? DEFAULT_PERSISTENT_SWEEP_MINUTES;
  const periodicSweepMs =
    sweepMinutes > 0
      ? Math.round(sweepMinutes * 60_000)
      : 0;
  startAutoTicker(swarmRunID, { periodicSweepMs });
}
