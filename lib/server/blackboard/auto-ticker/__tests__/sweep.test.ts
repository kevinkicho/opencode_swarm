import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TickerState, PerSessionSlot } from '../types';

const mocks = vi.hoisted(() => ({
  listBoardItems: vi.fn(),
  livePlanner: vi.fn(),
  orchestratorReplanCapHit: vi.fn(),
  stopAutoTicker: vi.fn(),
  boardHasWorkInFlight: vi.fn(),
}));

vi.mock('../../store', () => ({
  listBoardItems: mocks.listBoardItems,
  insertBoardItem: vi.fn(),
}));

vi.mock('../live-exports', () => ({
  livePlanner: mocks.livePlanner,
}));

vi.mock('../policies', () => ({
  MAX_ORCHESTRATOR_REPLANS: 20,
  orchestratorReplanCapHit: mocks.orchestratorReplanCapHit,
}));

vi.mock('../stop', () => ({
  stopAutoTicker: mocks.stopAutoTicker,
}));

vi.mock('../escalation', () => ({
  attemptTierEscalation: vi.fn(),
  boardHasWorkInFlight: mocks.boardHasWorkInFlight,
}));

vi.mock('../../degraded-completion', () => ({
  recordPartialOutcome: vi.fn(),
}));

function makeState(overrides: Partial<TickerState> = {}): TickerState {
  return {
    swarmRunID: 'run_test',
    intervalMs: 10_000,
    timer: null,
    stopped: false,
    startedAtMs: Date.now() - 60_000,
    sessionIDs: ['ses_a', 'ses_b'],
    slots: new Map<string, PerSessionSlot>([
      ['ses_a', { sessionID: 'ses_a', inFlight: false, consecutiveIdle: 0 }],
      ['ses_b', { sessionID: 'ses_b', inFlight: false, consecutiveIdle: 0 }],
    ]),
    resweepInFlight: false,
    commitsSinceLastAudit: 0,
    auditInFlight: false,
    auditEveryNCommits: 3,
    totalCommits: 0,
    periodicSweepMs: 300_000,
    periodicSweepTimer: null,
    orchestratorSessionID: '',
    lastSweepAtMs: 0,
    livenessTimer: null,
    lastSeenTokens: 0,
    lastTokensChangedAtMs: Date.now(),
    currentTier: 1,
    consecutiveFilteredAllTodos: 0,
    consecutiveNoClaimableWork: 0,
    retryAfterEndsAtMs: undefined,
    ...overrides,
  } as TickerState;
}

describe('runPeriodicSweep · F1 sweep error handling', () => {
  let runPeriodicSweep: (state: TickerState) => Promise<void>;

  beforeAll(async () => {
    const mod = await import('../sweep');
    runPeriodicSweep = mod.runPeriodicSweep;
  });

  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.orchestratorReplanCapHit.mockResolvedValue(false);
    mocks.boardHasWorkInFlight.mockReturnValue(false);
    mocks.listBoardItems.mockReturnValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('increments consecutiveNoClaimableWork on sweep error', async () => {
    const state = makeState({ lastSweepAtMs: Date.now() - 200_000 });
    mocks.livePlanner.mockReturnValue({
      runPlannerSweep: vi.fn().mockRejectedValue(new Error('planner sweep aborted')),
    });

    await runPeriodicSweep(state);

    expect(state.consecutiveNoClaimableWork).toBe(1);
    expect(mocks.stopAutoTicker).not.toHaveBeenCalled();
  });

  it('stops the ticker after consecutive sweep errors reach threshold with no work', async () => {
    const state = makeState({
      lastSweepAtMs: Date.now() - 200_000,
      consecutiveNoClaimableWork: 17, // NO_CLAIMABLE_WORK_TICKS - 1
    });
    mocks.livePlanner.mockReturnValue({
      runPlannerSweep: vi.fn().mockRejectedValue(new Error('planner sweep aborted')),
    });

    await runPeriodicSweep(state);

    expect(state.consecutiveNoClaimableWork).toBe(18);
    expect(mocks.stopAutoTicker).toHaveBeenCalledWith('run_test', 'no-claimable-work');
  });

  it('does NOT stop the ticker when sweep errors but board has work in flight', async () => {
    const state = makeState({
      lastSweepAtMs: Date.now() - 200_000,
      consecutiveNoClaimableWork: 17,
    });
    mocks.livePlanner.mockReturnValue({
      runPlannerSweep: vi.fn().mockRejectedValue(new Error('planner sweep aborted')),
    });
    mocks.boardHasWorkInFlight.mockReturnValue(true);

    await runPeriodicSweep(state);

    expect(state.consecutiveNoClaimableWork).toBe(18);
    expect(mocks.stopAutoTicker).not.toHaveBeenCalled();
  });

  it('resets resweepInFlight even when sweep throws', async () => {
    const state = makeState({ lastSweepAtMs: Date.now() - 200_000 });
    mocks.livePlanner.mockReturnValue({
      runPlannerSweep: vi.fn().mockRejectedValue(new Error('boom')),
    });

    await runPeriodicSweep(state);

    expect(state.resweepInFlight).toBe(false);
  });
});