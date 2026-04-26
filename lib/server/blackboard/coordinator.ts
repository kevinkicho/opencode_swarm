// Coordinator module — public surface + HMR plumbing.
//
// The actual logic lives in `coordinator/` siblings (decomposed in #107):
//   - coordinator/types.ts         — TickOutcome, TickOpts, CoordinatorExports, KEY symbol
//   - coordinator/timeouts.ts      — turnTimeoutFor, zombieThresholdFor
//   - coordinator/retry.ts         — retryOrStale, currentRetryCount, MAX_STALE_RETRIES
//   - coordinator/path-utils.ts    — sha7, extractPathTokens, pathOverlaps, etc.
//   - coordinator/heat.ts          — scoreTodoByHeat (stigmergy v1)
//   - coordinator/message-helpers.ts — extractLatestErrorText, ownerIdForSession, buildWorkPrompt
//   - coordinator/wait.ts          — waitForSessionIdle (5-layer watchdog)
//   - coordinator/drift.ts         — scheduleCasDriftReplan
//   - coordinator/dispatch.ts      — tickCoordinator (the main orchestration)
//
// External callers' import paths stay unchanged — every public symbol is
// re-exported below. The HMR publishExports call at the bottom keeps the
// auto-ticker / map-reduce / council / debate-judge / etc. consumers
// resolving to fresh implementations after module reloads.
//
// Server-only. Never imported from client code.

import { publishExports } from '../hmr-exports';
import {
  COORDINATOR_EXPORTS_KEY,
  type CoordinatorExports,
  type TickOpts,
  type TickOutcome,
} from './coordinator/types';
import { turnTimeoutFor, zombieThresholdFor } from './coordinator/timeouts';
import {
  currentRetryCount,
  extractRetryFailureReason,
} from './coordinator/retry';
import {
  extractPathTokens,
  pathOverlaps,
  relativizeToWorkspace,
} from './coordinator/path-utils';
import {
  buildWorkPrompt,
  extractLatestErrorText,
  ownerIdForSession,
} from './coordinator/message-helpers';
import { waitForSessionIdle } from './coordinator/wait';
import { tickCoordinator } from './coordinator/dispatch';

// Public surface — re-exported so external imports
// (`from '@/lib/server/blackboard/coordinator'`) keep working unchanged.
export {
  COORDINATOR_EXPORTS_KEY,
  turnTimeoutFor,
  zombieThresholdFor,
  currentRetryCount,
  extractRetryFailureReason,
  extractPathTokens,
  pathOverlaps,
  relativizeToWorkspace,
  buildWorkPrompt,
  extractLatestErrorText,
  ownerIdForSession,
  waitForSessionIdle,
  tickCoordinator,
};
export type { CoordinatorExports, TickOpts, TickOutcome };

// Publish to globalThis so HMR-replaced modules propagate to existing
// consumers (auto-ticker's setInterval callbacks, map-reduce's
// runMapReduceSynthesis, council's runCouncilRounds) without requiring
// those consumers to restart. See lib/server/hmr-exports.ts for the
// rationale and pattern.
publishExports<CoordinatorExports>(COORDINATOR_EXPORTS_KEY, {
  tickCoordinator,
  waitForSessionIdle,
});
