// HARDENING_PLAN.md#D4 #5 — planner-sweep test.
//
// `runPlannerSweep` in planner.ts is the engine that translates a
// planner LLM reply into board todos. Today only the prefix parsers
// (44 cases in planner-parsers.test.ts) are tested. The orchestrator
// that consumes parsed output, sequences the planner prompt, and
// commits new todos is invisible to the suite.
//
// Status: scaffold. Un-skip once the test is implemented; the
// describe blocks below are the contract.

import { describe } from 'vitest';

describe.skip('planner · runPlannerSweep (D4 #5 — to be implemented)', () => {
  // Recipe:
  //
  //   import { vi } from 'vitest';
  //   const opencodeMocks = vi.hoisted(() => ({
  //     getSessionMessagesServer: vi.fn(),
  //     postSessionMessageServer: vi.fn(),
  //   }));
  //   vi.mock('../../opencode-server', () => opencodeMocks);

  // === Seeding (cold start) ===
  //
  // it('issues a planner prompt when board is empty');
  // it('parses the planner reply into todos and inserts them');
  // it('honors teamSize when seeding');
  // it('seeds at the inherited tier when meta.currentTier > 1');

  // === Resweep (incremental) ===
  //
  // it('only adds new todos that do not already exist on the board');
  // it('emits no-new-todos outcome when planner reply yields empty');

  // === Tier escalation ===
  //
  // it('escalates to the next tier when stop conditions met');
  // it('respects MAX_TIER ceiling');

  // === Failure modes ===
  //
  // it('returns sweep-failed when planner session times out');
  // it('returns sweep-failed when getSessionMessagesServer throws');
  // it('logs the planner reply that failed to parse');
});
