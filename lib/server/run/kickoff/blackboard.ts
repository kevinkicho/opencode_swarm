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

export async function runBlackboardKickoff(
  swarmRunID: string,
  opts: { persistentSweepMinutes?: number } = {},
): Promise<void> {
  const result = await runPlannerSweep(swarmRunID);
  if (result.items.length === 0) {
    console.warn(
      `[swarm/run] blackboard sweep for ${swarmRunID} produced 0 todos — auto-ticker not started`,
    );
    return;
  }
  console.log(
    `[swarm/run] blackboard sweep for ${swarmRunID} produced ${result.items.length} todos — starting auto-ticker`,
  );
  const periodicSweepMs =
    opts.persistentSweepMinutes && opts.persistentSweepMinutes > 0
      ? Math.round(opts.persistentSweepMinutes * 60_000)
      : 0;
  startAutoTicker(swarmRunID, { periodicSweepMs });
}
