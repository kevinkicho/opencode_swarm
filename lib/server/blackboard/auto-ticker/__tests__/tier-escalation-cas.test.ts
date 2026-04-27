// CAS-tighten fix in tier-escalation.ts.
//
// Pre-fix: tick.ts:193 did `if (!state.resweepInFlight) {
// state.resweepInFlight = true; void attemptTierEscalation(state); }`
// — read-then-set race where two concurrent tickSession calls past the
// auto-stop threshold both observed false and both fired the
// escalation. Wasted opencode probes + duplicate planner sweeps.
//
// Post-fix: attemptTierEscalation owns the flag — sets at entry, clears
// on every exit path. Concurrent callers see resweepInFlight=true and
// bail out.
//
// This test drives the function with a side-effect counter and asserts
// only one invocation actually fires the inner work, even when called
// concurrently.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock all the heavy deps so the function runs without opencode/db.
const mocks = vi.hoisted(() => ({
  orchestratorReplanCapHit: vi.fn(),
  maybeRunAudit: vi.fn(),
  livePlanner: vi.fn(),
  listBoardItems: vi.fn(),
  attemptColdFileSeeding: vi.fn(),
  updateRunMeta: vi.fn(),
  stopAutoTicker: vi.fn(),
}));

vi.mock('../../../swarm-registry', () => ({
  updateRunMeta: mocks.updateRunMeta,
}));
vi.mock('../../store', () => ({
  listBoardItems: mocks.listBoardItems,
}));
vi.mock('../../cold-file-seed', () => ({
  attemptColdFileSeeding: mocks.attemptColdFileSeeding,
}));
vi.mock('../../planner', () => ({
  MAX_TIER: 5,
  TIER_LADDER: [
    { tier: 1, name: 'tier-1' },
    { tier: 2, name: 'tier-2' },
    { tier: 3, name: 'tier-3' },
    { tier: 4, name: 'tier-4' },
    { tier: 5, name: 'tier-5' },
  ],
}));
vi.mock('../live-exports', () => ({
  livePlanner: () => ({
    runPlannerSweep: mocks.livePlanner,
  }),
}));
vi.mock('../audit', () => ({
  maybeRunAudit: mocks.maybeRunAudit,
}));
vi.mock('../policies', () => ({
  MAX_ORCHESTRATOR_REPLANS: 3,
  orchestratorReplanCapHit: mocks.orchestratorReplanCapHit,
}));
vi.mock('../stop', () => ({
  stopAutoTicker: mocks.stopAutoTicker,
}));
// Import after mocks so the production module's references bind to the
// mocked versions.
const { attemptTierEscalation } = await import('../tier-escalation');

import type { TickerState } from '../types';

function makeTickerState(overrides: Partial<TickerState> = {}): TickerState {
  return {
    swarmRunID: 'run_test_x',
    sessionIDs: ['s0', 's1'],
    slots: new Map(),
    timer: null,
    periodicSweepTimer: null,
    livenessTimer: null,
    periodicSweepMs: 0,
    stopped: false,
    stopReason: null,
    startedAtMs: Date.now(),
    stoppedAtMs: null,
    consecutiveIdleTicks: 0,
    currentTier: 1,
    tierExhausted: false,
    resweepInFlight: false,
    lastSweepAtMs: 0,
    totalCommits: 0,
    ...overrides,
  } as TickerState;
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.orchestratorReplanCapHit?.mockResolvedValue(false);
  mocks.maybeRunAudit?.mockResolvedValue(undefined);
  mocks.listBoardItems?.mockReturnValue([]);
  mocks.attemptColdFileSeeding?.mockResolvedValue(0);
  mocks.updateRunMeta?.mockResolvedValue(null);
  mocks.livePlanner?.mockResolvedValue({ items: [] });
});

afterEach(() => vi.restoreAllMocks());

describe('attemptTierEscalation · D8 CAS-tighten', () => {
  it('runs the inner sweep when called once with flag false', async () => {
    const state = makeTickerState();
    await attemptTierEscalation(state);
    expect(mocks.livePlanner).toHaveBeenCalledTimes(1);
    expect(state.resweepInFlight).toBe(false); // cleared at exit
  });

  it('bails out immediately when called with flag already set', async () => {
    const state = makeTickerState({ resweepInFlight: true });
    await attemptTierEscalation(state);
    // Caller's flag stays true (we don't clear someone else's lock).
    expect(state.resweepInFlight).toBe(true);
    // Inner work never ran.
    expect(mocks.livePlanner).not.toHaveBeenCalled();
  });

  it('two concurrent calls produce exactly one inner-sweep invocation', async () => {
    const state = makeTickerState();

    // Slow down the planner sweep so the second concurrent call has
    // time to enter the function and observe resweepInFlight=true.
    let sweepInProgress = false;
    let concurrentObserved = false;
    mocks.livePlanner.mockImplementation(async () => {
      if (sweepInProgress) concurrentObserved = true;
      sweepInProgress = true;
      // Hold the lock for one tick so the second caller arrives mid-sweep.
      await new Promise((resolve) => setTimeout(resolve, 25));
      sweepInProgress = false;
      return { items: [] };
    });

    await Promise.all([
      attemptTierEscalation(state),
      attemptTierEscalation(state),
    ]);

    // Exactly one inner sweep should have fired; the second caller
    // bailed at the resweepInFlight check.
    expect(mocks.livePlanner).toHaveBeenCalledTimes(1);
    expect(concurrentObserved).toBe(false);
    expect(state.resweepInFlight).toBe(false);
  });

  it('clears the flag on the orchestrator-replan early-return path', async () => {
    mocks.orchestratorReplanCapHit.mockResolvedValue(true);
    const state = makeTickerState();
    await attemptTierEscalation(state);
    // Flag MUST be cleared even on the early-return branch — otherwise
    // the run would be permanently locked out of future escalations.
    expect(state.resweepInFlight).toBe(false);
    expect(mocks.stopAutoTicker).toHaveBeenCalled();
  });
});
