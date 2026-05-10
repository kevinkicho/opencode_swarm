//
// `tickSession` in tick.ts drives the per-session dispatch loop. The
// `consecutiveNoClaimableWork` counter tracks how many ticks in a row
// saw `pickClaim` return "no claimable todos" (retry-exhausted). When
// it reaches NO_CLAIMABLE_WORK_TICKS (18), the ticker stops with
// reason 'no-claimable-work'.
//
// Bug being tested: the counter accumulates across ticks even when
// there are still work-class items in flight on the board (claimed,
// in-progress, or open-but-retryable). A run with active workers
// should NOT be stopped just because `pickClaim` can't find NEW
// work — the existing work is still progressing.
//
// The test drills in to `tickSession` directly, mocking every IO dep
// and `boardHasWorkInFlight` to simulate the scenario.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRun: vi.fn(),
  listBoardItems: vi.fn(),
  insertBoardItem: vi.fn(),
  tickCoordinator: vi.fn(),
  stopAutoTicker: vi.fn(),
  finalizeRetryExhaustedItems: vi.fn(),
  boardHasWorkInFlight: vi.fn(),
  attemptTierEscalation: vi.fn(),
  runPeriodicSweep: vi.fn(),
  checkLiveness: vi.fn(),
  maybeRunAudit: vi.fn(),
  checkHardCaps: vi.fn(),
  checkStuckDeliberation: vi.fn(),
  emitTickerTick: vi.fn(),
  persistTickerSnapshot: vi.fn(),
  orchestratorReplanCapHit: vi.fn(),
  computeDelta: vi.fn(),
  getLatestRevisionContents: vi.fn(),
  nextRoundForRun: vi.fn(),
  recordPlanRevision: vi.fn(),
  postSessionMessageServer: vi.fn(),
  waitForSessionIdle: vi.fn(),
  getSessionMessagesServer: vi.fn(),
  abortSessionServer: vi.fn(),
  recordPartialOutcome: vi.fn(),
  roleNamesBySessionID: vi.fn(),
}));

vi.mock('../../../swarm-registry', () => ({
  getRun: mocks.getRun,
}));

vi.mock('../../store', () => ({
  listBoardItems: mocks.listBoardItems,
  insertBoardItem: mocks.insertBoardItem,
}));

vi.mock('../../coordinator', () => ({
  tickCoordinator: mocks.tickCoordinator,
  waitForSessionIdle: mocks.waitForSessionIdle,
  COORDINATOR_EXPORTS_KEY: Symbol.for('opencode_swarm.coordinator.exports'),
}));

vi.mock('../stop', () => ({
  stopAutoTicker: mocks.stopAutoTicker,
}));

vi.mock('../escalation', () => ({
  attemptTierEscalation: mocks.attemptTierEscalation,
  boardHasWorkInFlight: mocks.boardHasWorkInFlight,
}));

vi.mock('../sweep', () => ({
  runPeriodicSweep: mocks.runPeriodicSweep,
}));

vi.mock('../liveness', () => ({
  checkLiveness: mocks.checkLiveness,
}));

vi.mock('../audit', () => ({
  maybeRunAudit: mocks.maybeRunAudit,
}));

vi.mock('../hard-caps', () => ({
  checkHardCaps: mocks.checkHardCaps,
}));

vi.mock('../stuck-check', () => ({
  checkStuckDeliberation: mocks.checkStuckDeliberation,
}));

vi.mock('../bus', () => ({
  emitTickerTick: mocks.emitTickerTick,
}));

vi.mock('../live-exports', () => ({
  liveCoordinator: () => ({ tickCoordinator: mocks.tickCoordinator }),
  livePlanner: () => ({ runPlannerSweep: vi.fn() }),
}));

vi.mock('../../coordinator/retry', () => ({
  finalizeRetryExhaustedItems: mocks.finalizeRetryExhaustedItems,
}));

vi.mock('../../../degraded-completion', () => ({
  recordPartialOutcome: mocks.recordPartialOutcome,
}));

vi.mock('../../opencode-server', () => ({
  abortSessionServer: mocks.abortSessionServer,
  getSessionMessagesServer: mocks.getSessionMessagesServer,
  postSessionMessageServer: mocks.postSessionMessageServer,
}));

vi.mock('../../hmr-exports', () => ({
  liveExports: <T>(_key: symbol, fallback: T) => fallback,
}));

vi.mock('../state', () => ({
  snapshot: () => ({ swarmRunID: 'run_test', stopped: true, stopReason: 'no-claimable-work' }),
  tickers: () => new Map(),
}));

vi.mock('../ticker-snapshots', () => ({
  persistTickerSnapshot: mocks.persistTickerSnapshot,
}));

import type { TickerState, PerSessionSlot } from '../types';

const NO_CLAIMABLE_WORK_TICKS = 18;

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
    periodicSweepMs: 0,
    periodicSweepTimer: null,
    orchestratorSessionID: '',
    lastSweepAtMs: 0,
    livenessTimer: null,
    lastSeenTokens: 0,
    lastTokensChangedAtMs: Date.now(),
    currentTier: 1,
    consecutiveFilteredAllTodos: 0,
    consecutiveNoClaimableWork: 0,
    ...overrides,
  } as TickerState;
}

const skippedRetryExhausted: { status: 'skipped'; reason: string } = {
  status: 'skipped',
  reason: 'no claimable todos',
};

const skippedWithRetryExhausted: { status: 'skipped'; reason: string } = {
  status: 'skipped',
  reason: 'retry-exhausted',
};

describe('consecutiveNoClaimableWork gate', () => {
  let state: TickerState;
  let tickSession: any;
  beforeAll(async () => {
    const mod = await import('../tick');
    tickSession = mod.tickSession;
  });

  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.getRun.mockResolvedValue(null);
    mocks.listBoardItems.mockReturnValue([]);
    mocks.insertBoardItem.mockReturnValue(undefined);
    mocks.finalizeRetryExhaustedItems.mockReturnValue(0);
    mocks.boardHasWorkInFlight.mockReturnValue(false);
    mocks.attemptTierEscalation.mockResolvedValue(false);
    mocks.stopAutoTicker.mockImplementation(() => {
      return undefined;
    });
    mocks.checkLiveness.mockResolvedValue(undefined);
    mocks.maybeRunAudit.mockResolvedValue(undefined);
    mocks.checkHardCaps.mockResolvedValue(undefined);
    mocks.checkStuckDeliberation.mockResolvedValue(undefined);
    mocks.emitTickerTick.mockImplementation(() => {});
    state = makeState();
  });

  afterEach(() => vi.restoreAllMocks());

  it('stops the ticker after NO_CLAIMABLE_WORK_TICKS consecutive retry-exhausted outcomes', async () => {
    mocks.tickCoordinator.mockResolvedValue(skippedWithRetryExhausted);
    state.consecutiveNoClaimableWork = NO_CLAIMABLE_WORK_TICKS - 1;

    await tickSession(state, 'ses_a');

    expect(state.consecutiveNoClaimableWork).toBe(NO_CLAIMABLE_WORK_TICKS);
    expect(mocks.stopAutoTicker).toHaveBeenCalledWith(
      'run_test',
      'no-claimable-work',
    );
  });

  it('resets counter to 0 on a non-idle outcome (picked)', async () => {
    mocks.tickCoordinator.mockResolvedValue({
      status: 'picked',
      sessionID: 'ses_a',
      itemID: 't_001',
      editedPaths: ['src/foo.ts'],
    });
    state.consecutiveNoClaimableWork = 10;

    await tickSession(state, 'ses_a');

    expect(state.consecutiveNoClaimableWork).toBe(0);
    expect(mocks.stopAutoTicker).not.toHaveBeenCalled();
  });

  it('resets counter to 0 on a stale (non-phantom) outcome', async () => {
    mocks.tickCoordinator.mockResolvedValue({
      status: 'stale',
      sessionID: 'ses_a',
      itemID: 't_001',
      reason: 'turn-timed-out',
    });
    state.consecutiveNoClaimableWork = 10;

    await tickSession(state, 'ses_a');

    expect(state.consecutiveNoClaimableWork).toBe(0);
  });

  it('does NOT reset counter on skipped outcomes without retry-exhausted', async () => {
    mocks.tickCoordinator.mockResolvedValue(skippedRetryExhausted);
    state.consecutiveNoClaimableWork = 5;

    await tickSession(state, 'ses_a');

    expect(state.consecutiveNoClaimableWork).toBe(5);
    expect(mocks.stopAutoTicker).not.toHaveBeenCalled();
  });

  it('increments counter on skipped+retry-exhausted outcomes', async () => {
    mocks.tickCoordinator.mockResolvedValue(skippedWithRetryExhausted);
    state.consecutiveNoClaimableWork = 3;

    await tickSession(state, 'ses_a');

    expect(state.consecutiveNoClaimableWork).toBe(4);
  });

  it('counts phantom-no-tools as idle (does NOT increment consecutiveNoClaimableWork)', async () => {
    mocks.tickCoordinator.mockResolvedValue({
      status: 'stale',
      sessionID: 'ses_a',
      itemID: 't_001',
      reason: 'phantom-no-tools',
    });
    state.consecutiveNoClaimableWork = 5;

    await tickSession(state, 'ses_a');

    // phantom-no-tools is idle per isIdleOutcome, but it's 'stale' not 'skipped',
    // so the consecutiveNoClaimableWork guard (which checks 'skipped' + 'retry-exhausted')
    // doesn't increment it. It also doesn't reset it (isIdleOutcome returns true,
    // so the else branch resetting to 0 doesn't fire).
    // The counter stays unchanged.
    expect(state.consecutiveNoClaimableWork).toBe(5);
  });

  // KEY REGRESSION TEST: consecutiveNoClaimableWork should NOT stop the
  // ticker when there are still work-class items in flight. The 
  // boardHasWorkInFlight guard ensures that workers actively working 
  // prevent the ticker from stopping even if no new work is claimable.
  it('does NOT stop the ticker when board has work in flight, even after NO_CLAIMABLE_WORK_TICKS consecutive retry-exhausted ticks', async () => {
    mocks.tickCoordinator.mockResolvedValue(skippedWithRetryExhausted);
    // Simulate: the board has claimed/in-progress items — workers are
    // actively working, but pickClaim can't find NEW open items because
    // they're all retry-exhausted.
    mocks.boardHasWorkInFlight.mockReturnValue(true);
    state.consecutiveNoClaimableWork = NO_CLAIMABLE_WORK_TICKS - 1;

    await tickSession(state, 'ses_a');

    // Counter should have incremented past the threshold...
    expect(state.consecutiveNoClaimableWork).toBeGreaterThanOrEqual(
      NO_CLAIMABLE_WORK_TICKS,
    );
    // ...but the ticker should NOT be stopped because boardHasWorkInFlight
    // returned true — there are still items being worked on.
    expect(mocks.stopAutoTicker).not.toHaveBeenCalledWith(
      'run_test',
      'no-claimable-work',
    );
  });

  it('stops the ticker when board has NO work in flight after threshold ticks', async () => {
    mocks.tickCoordinator.mockResolvedValue(skippedWithRetryExhausted);
    mocks.boardHasWorkInFlight.mockReturnValue(false);
    state.consecutiveNoClaimableWork = NO_CLAIMABLE_WORK_TICKS - 1;

    await tickSession(state, 'ses_a');

    expect(state.consecutiveNoClaimableWork).toBe(NO_CLAIMABLE_WORK_TICKS);
    expect(mocks.stopAutoTicker).toHaveBeenCalledWith(
      'run_test',
      'no-claimable-work',
    );
  });

  it('does NOT stop ticker below threshold even with retry-exhausted outcomes', async () => {
    mocks.tickCoordinator.mockResolvedValue(skippedWithRetryExhausted);
    state.consecutiveNoClaimableWork = 5;

    await tickSession(state, 'ses_a');

    expect(state.consecutiveNoClaimableWork).toBe(6);
    expect(mocks.stopAutoTicker).not.toHaveBeenCalled();
  });
});