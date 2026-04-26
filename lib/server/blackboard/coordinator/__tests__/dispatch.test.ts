// HARDENING_PLAN.md#D4 #2 + C4 — dispatch coordinator decomposition tests.
//
// `tickCoordinator` in dispatch.ts is 753 LOC with 14 exits and zero
// tests. The Q34 silent-drop class lives here. Per C4, this file should
// be split into `pickClaim / dispatchPrompt / awaitTurn / runGateChecks /
// commitDone`. Each helper gets its own test file once split. This file
// is the smoke-test scaffold for the orchestrator after the split.
//
// Status: scaffold. Un-skip once C4 split lands. The test cases below
// describe the contract for each exit path.

import { describe } from 'vitest';

describe.skip('dispatch · tickCoordinator (D4 #2 + C4 — to be implemented)', () => {
  // === Happy path ===
  //
  // it('returns picked when a queued todo is claimed and dispatched');

  // === Skipped outcomes (8) ===
  //
  // it('returns skipped:no-board-items when board is empty');
  // it('returns skipped:no-queued-items when all items are claimed/done');
  // it('returns skipped:no-idle-session when every session has an in-flight turn');
  // it('returns skipped:claim-cas-lost when transitionStatus returns 0 changes');
  // it('returns skipped:no-prompt when buildClaimPrompt yields empty');
  // it('returns skipped:run-not-found when the meta is missing');
  // it('returns skipped:run-stopped when run.stoppedAt is set');
  // it('returns skipped:bounds-exceeded when wall-clock cap is hit');

  // === Stale outcomes (6) ===
  //
  // it('returns stale:wait-failed when waitForSessionIdle errors');
  // it('returns stale:cas-drift when post-wait commit CAS misses');
  // it('returns stale:phantom-no-tools (Q42) when worker emits text-only with no tool/patch');
  // it('returns stale:critic-rejected when critic verdict is REVISE');
  // it('returns stale:verifier-rejected when verifier verdict is REJECT');
  // it('returns stale:final-emit-failed when board write fails');

  // === Q34 silent-drop firewall ===
  //
  // it('rejects an opencode response with no assistant turn (silent-drop case)');
  // it('rejects an assistant turn with zero parts after the deadline');

  // === Restriction ===
  //
  // it('honors restrictToSessionID — only picks claims for that session');
  // it('does not pick from sessions outside the restriction');
});
