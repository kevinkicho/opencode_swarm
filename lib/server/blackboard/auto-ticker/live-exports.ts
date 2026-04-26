// HMR-resilient cross-module call wrappers for the auto-ticker.
//
// Direct imports of tickCoordinator / runPlannerSweep are the fallback
// when the producer module hasn't published yet (unusual in practice —
// publish happens at module load). These closures read globalThis at
// each call, so HMR-reloaded coordinator / planner code takes effect
// on the next tick without needing a ticker restart.
// See lib/server/hmr-exports.ts for the rationale.
//
// Extracted from auto-ticker.ts in #106 phase 3e so tier-escalation and
// sweep modules can share these wrappers without re-defining them.

import 'server-only';

import { liveExports } from '../../hmr-exports';
import {
  COORDINATOR_EXPORTS_KEY,
  tickCoordinator,
  waitForSessionIdle,
  type CoordinatorExports,
} from '../coordinator';
import {
  PLANNER_EXPORTS_KEY,
  runPlannerSweep,
  type PlannerExports,
} from '../planner';

export function liveCoordinator(): CoordinatorExports {
  return liveExports<CoordinatorExports>(COORDINATOR_EXPORTS_KEY, {
    tickCoordinator,
    waitForSessionIdle,
  });
}

export function livePlanner(): PlannerExports {
  return liveExports<PlannerExports>(PLANNER_EXPORTS_KEY, {
    runPlannerSweep,
  });
}
