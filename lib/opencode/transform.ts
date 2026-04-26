// Maps live opencode session data into the prototype's mock-data shapes
// (Agent[] / AgentMessage[] / RunMeta / ProviderSummary[]) so the existing
// timeline, roster, and inspector can render it with zero component changes.
//
// HARDENING_PLAN.md#C11 — split into per-transformer files under
// lib/opencode/transform/ on 2026-04-26. This file is now a re-export
// barrel so the 16 import sites don't churn. Module-private helpers
// (providerOf / derivedCost / familyOf / etc.) live in
// lib/opencode/transform/_shared.ts.
//
// Per-transformer files:
//   - to-agents.ts          → toAgents
//   - to-messages.ts        → toMessages
//   - to-run-meta.ts        → toRunMeta
//   - to-run-plan.ts        → toRunPlan
//   - to-live-turns.ts      → toLiveTurns + LiveTurn
//   - to-file-heat.ts       → toFileHeat + FileHeat
//   - to-turn-cards.ts      → toTurnCards + TurnCard
//   - diffs.ts              → parseUnifiedDiff / parseSessionDiffs / filterDiffsForTurn
//   - to-provider-summary.ts → toProviderSummary

export { toAgents } from './transform/to-agents';
export { toMessages } from './transform/to-messages';
export { toRunMeta } from './transform/to-run-meta';
export { toRunPlan } from './transform/to-run-plan';
export { toLiveTurns, type LiveTurn } from './transform/to-live-turns';
export { toFileHeat, type FileHeat } from './transform/to-file-heat';
export { toTurnCards, type TurnCard } from './transform/to-turn-cards';
export {
  parseUnifiedDiff,
  parseSessionDiffs,
  filterDiffsForTurn,
} from './transform/diffs';
export { toProviderSummary } from './transform/to-provider-summary';
