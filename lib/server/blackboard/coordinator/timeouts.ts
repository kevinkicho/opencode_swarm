// Per-pattern timeout policy for the coordinator.
//
// Two dimensions:
//   - turnTimeoutFor: how long the worker dispatch waits for the assistant
//     turn to complete before aborting + marking the todo stale.
//   - zombieThresholdFor: how long an in-flight assistant message can
//     sit (no completed + no error — opencode's zombie shape) before
//     the picker auto-aborts and reuses the session for new work.
//
// Both default to 10 min for blackboard-family patterns. Patterns not in
// the map fall back to the default.

import 'server-only';

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const TURN_TIMEOUTS_MS: Record<string, number> = {
  blackboard: 10 * 60_000,
  'orchestrator-worker': 10 * 60_000,
  'role-differentiated': 10 * 60_000,
};

export function turnTimeoutFor(pattern: string): number {
  return TURN_TIMEOUTS_MS[pattern] ?? DEFAULT_TURN_TIMEOUT_MS;
}

// Per-pattern zombie threshold for the session picker. opencode assistant
// turns can hang with no completed AND no error — in-flight indefinitely,
// silently blocking dispatch because the picker skips any session with an
// active in-flight turn. After this many ms, the picker treats the turn
// as stale: auto-aborts it and dispatches to the session anyway.
//
// Only blackboard-family patterns (blackboard / orchestrator-worker /
// role-differentiated) run through tickCoordinator, so those are the
// only values that matter in practice.
const ZOMBIE_TURN_THRESHOLD_DEFAULT_MS = 10 * 60_000;
const ZOMBIE_TURN_THRESHOLDS_MS: Record<string, number> = {
  blackboard: 10 * 60_000,
  'orchestrator-worker': 10 * 60_000,
  'role-differentiated': 10 * 60_000,
};

export function zombieThresholdFor(pattern: string): number {
  return ZOMBIE_TURN_THRESHOLDS_MS[pattern] ?? ZOMBIE_TURN_THRESHOLD_DEFAULT_MS;
}
