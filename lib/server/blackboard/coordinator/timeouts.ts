// Per-pattern timeout policy for the coordinator.
//
// Two dimensions:
//   - turnTimeoutFor: how long the worker dispatch waits for the assistant
//     turn to complete before aborting + marking the todo stale.
//   - zombieThresholdFor: how long an in-flight assistant message can
//     sit (no completed + no error — opencode's zombie shape) before
//     the picker auto-aborts and reuses the session for new work.
//
// Both default to 10 min for blackboard-family patterns; deliberate-execute's
// synthesis phase gets 15 min because reconciling N council drafts +
// writing todowrite legitimately takes longer than a single-file edit.
//
// Extracted from coordinator.ts in #107 phase 2.

// Raised from 5 min to 10 min after the 2026-04-23 overnight run showed
// substantive README-verification todos ("Verify CreditMarket EM bonds
// spread data rendering") legitimately running past 5 min — not zombies,
// just slow work involving multiple reads + a test file edit + a test
// run. The zombie auto-abort in the picker already handles truly-stuck
// sessions at 10 min, so the worker timeout matches that boundary.
//
// Per-pattern tuning mirrors ZOMBIE_TURN_THRESHOLDS_MS: patterns whose
// turns legitimately take longer get more budget. deliberate-execute's
// synthesis phase reconciles N drafts + writes todowrite — slower than
// a single-file edit. critic-loop's worker turns are typically tight
// revisions on a focused target, so a shorter timeout catches hung
// turns faster without losing legitimate work. Patterns not in the map
// fall back to DEFAULT_TURN_TIMEOUT_MS.
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const TURN_TIMEOUTS_MS: Record<string, number> = {
  blackboard: 10 * 60_000,
  'orchestrator-worker': 10 * 60_000,
  'role-differentiated': 10 * 60_000,
  'deliberate-execute': 15 * 60_000,
};

export function turnTimeoutFor(pattern: string): number {
  return TURN_TIMEOUTS_MS[pattern] ?? DEFAULT_TURN_TIMEOUT_MS;
}

// Per-pattern zombie threshold for the session picker. opencode assistant
// turns can hang with no completed AND no error (see
// memory/reference_opencode_zombie_messages.md) — in-flight indefinitely,
// silently blocking dispatch because the picker skips any session with an
// active in-flight turn. After this many ms, the picker treats the turn
// as stale: auto-aborts it and dispatches to the session anyway.
//
// Only blackboard-family patterns (blackboard / orchestrator-worker /
// role-differentiated / deliberate-execute) run through tickCoordinator,
// so those are the only values that matter in practice. 10 min is the
// legacy default and works for typical refactor work; deliberate-execute's
// synthesis phase gets more headroom because reconciling N council drafts
// legitimately takes longer than a single-file edit.
const ZOMBIE_TURN_THRESHOLD_DEFAULT_MS = 10 * 60_000;
const ZOMBIE_TURN_THRESHOLDS_MS: Record<string, number> = {
  blackboard: 10 * 60_000,
  'orchestrator-worker': 10 * 60_000,
  'role-differentiated': 10 * 60_000,
  'deliberate-execute': 15 * 60_000,
};

export function zombieThresholdFor(pattern: string): number {
  return ZOMBIE_TURN_THRESHOLDS_MS[pattern] ?? ZOMBIE_TURN_THRESHOLD_DEFAULT_MS;
}
