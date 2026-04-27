// Initial planner sweep — step 3a of .
//
// Given a live swarm run with an empty board, prompts one of the run's
// sessions to emit a todowrite list and translates each todo into an open
// board item. This is the seed that gives other agents something to claim.
//
// on 2026-04-26. This file is now a re-export barrel so the 6 import sites
// don't churn. Per-file responsibilities:
//
//   - planner/sweep.ts      — runPlannerSweep + isViableCriterion + types
//                             + HMR-resilient publishExports
//   - planner/prompt.ts     — buildPlannerPrompt + readWorkspaceReadme
//                             + buildPlannerBoardContext + TIER_LADDER
//   - planner/parsers.ts    — strip-* tag helpers + latestTodosFrom + RawTodo
//   - planner/summaries.ts  — buildPlannerPartialSummary +
//                             buildZeroTodoSummary + buildAllFilteredSummary
//                             + extractAssistantExcerpt + snapshotBoard
//
// Boundary decisions (preserved from pre-split):
//   - We send the prompt via opencode's async /prompt endpoint and poll
//     /message for the new assistant turn to land. SSE would be lower
//     latency but we don't have a server-to-server SSE client yet and the
//     sweep is a one-shot blocking operation; 1s polling is honest here.
//   - We reuse sessionIDs[0] for the sweep rather than create a dedicated
//     session. For step 3a this means sweeping a council run's first slot
//     injects a planner-style turn into its transcript. That's acceptable
//     for testing against existing runs; when pattern='blackboard' lifts
//     from 501 (step 3d) the run creation can provision a sweep session
//     without touching the workers.
//   - One todowrite call fully replaces the prior list (see
//     parsers.ts::latestTodosFrom). We take the last todowrite in the new
//     assistant message as the canonical list.
//
// Server-only. Not imported from client code.

import 'server-only';

// the planner ↔ degraded-completion import cycle. Imported AND re-
// exported here so existing callers don't need to update their imports.
export { mintItemId } from './item-ids';

export {
  runPlannerSweep,
  isViableCriterion,
  PLANNER_EXPORTS_KEY,
  type PlannerExports,
  type PlannerSweepResult,
} from './planner/sweep';

export {
  buildPlannerBoardContext,
  type PlannerBoardContext,
} from './planner/prompt';

export {
  stripVerifyTag,
  stripRoleTag,
  stripFilesTag,
  stripRoleNoteTag,
  stripFromTag,
  stripCriterionTag,
  latestTodosFrom,
} from './planner/parsers';

export {
  buildZeroTodoSummary,
  buildAllFilteredSummary,
} from './planner/summaries';
