//
// Dual-planner sweeps — FTA structural fix for the OR-gate dominance
// problem. At tier 3+, two independent planner sessions run in parallel.
// If either produces a plan, the run continues. Both must fail for the
// run to die, converting the critical path from OR-gated (P=15%) to
// AND-gated (P=2.25%).
//
// Cost: 2× planner tokens per sweep (~$10.34 vs $5.17). Used only at
// tier 3+ where the cost of a dead run is highest (more tokens already
// invested, more operator time to restart).
//
// See docs/FAULT_TREE.md § "Structural Insight"

import 'server-only';

import { runPlannerSweep } from './sweep';
import type { PlannerSweepResult } from './sweep';

interface DualSweepOpts {
  timeoutMs?: number;
  overwrite?: boolean;
  includeBoardContext?: boolean;
  includeReadme?: boolean;
  escalationTier?: number;
}

export async function runDualPlannerSweep(
  swarmRunID: string,
  opts: DualSweepOpts = {},
): Promise<PlannerSweepResult> {
  console.log(`[planner] dual-sweep: firing two independent planner sessions for ${swarmRunID}`);

  const [a, b] = await Promise.allSettled([
    runPlannerSweep(swarmRunID, opts),
    runPlannerSweep(swarmRunID, { ...opts, overwrite: true }),
  ]);

  // Accept the first successful result with items.
  if (a.status === 'fulfilled' && a.value.items.length > 0) {
    console.log(`[planner] dual-sweep: session A succeeded with ${a.value.items.length} items`);
    return a.value;
  }
  if (b.status === 'fulfilled' && b.value.items.length > 0) {
    console.log(`[planner] dual-sweep: session B succeeded with ${b.value.items.length} items`);
    return b.value;
  }

  // Both failed or produced zero items.
  const aErr = a.status === 'rejected' ? (a.reason as Error).message : 'zero items';
  const bErr = b.status === 'rejected' ? (b.reason as Error).message : 'zero items';
  console.warn(`[planner] dual-sweep: both sessions failed — A: ${aErr}, B: ${bErr}`);

  // If either produced zero items (not errored), return empty result
  if (a.status === 'fulfilled') return a.value;
  if (b.status === 'fulfilled') return b.value;

  // Both errored — re-throw the first error
  throw a.reason;
}
