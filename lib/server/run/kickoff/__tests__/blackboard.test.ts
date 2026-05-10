import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runPlannerSweep: vi.fn(),
  startAutoTicker: vi.fn(),
  listBoardItems: vi.fn(),
}));

vi.mock('../../../blackboard/planner', () => ({
  runPlannerSweep: mocks.runPlannerSweep,
  isViableCriterion: vi.fn(),
}));

vi.mock('../../../blackboard/auto-ticker', () => ({
  startAutoTicker: mocks.startAutoTicker,
}));

vi.mock('../../../blackboard/store', () => ({
  listBoardItems: mocks.listBoardItems,
}));

vi.mock('../../../degraded-completion', () => ({
  recordPartialOutcome: vi.fn(),
}));

vi.mock('../../../blackboard/pattern-guard', () => ({
  assertStartupInvariant: vi.fn(),
}));

vi.mock('../../../swarm-registry', () => ({
  getRun: vi.fn().mockResolvedValue({
    swarmRunID: 'test',
    pattern: 'blackboard',
    sessionIDs: ['s1'],
    workspace: '/test',
    teamModels: [],
  }),
}));

vi.mock('server-only', () => ({}));

describe('runBlackboardKickoff', () => {
  let runBlackboardKickoff: (
    swarmRunID: string,
    opts?: { persistentSweepMinutes?: number },
  ) => Promise<void>;

  beforeAll(async () => {
    const mod = await import('../blackboard');
    runBlackboardKickoff = mod.runBlackboardKickoff;
  });

  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('starts the auto-ticker when sweep produces todos', async () => {
    mocks.runPlannerSweep.mockResolvedValue({
      items: [
        { id: 't_001', kind: 'todo', content: 'do task 1', status: 'open', createdAtMs: Date.now() },
        { id: 't_002', kind: 'todo', content: 'do task 2', status: 'open', createdAtMs: Date.now() },
      ],
      sessionID: 'ses_planner',
      planMessageID: null,
    });

    await runBlackboardKickoff('run_test');

    expect(mocks.startAutoTicker).toHaveBeenCalledTimes(1);
    expect(mocks.startAutoTicker).toHaveBeenCalledWith('run_test', {
      periodicSweepMs: 5 * 60_000,
    });
  });

  it('does not start the auto-ticker when sweep produces 0 todos', async () => {
    mocks.runPlannerSweep.mockResolvedValue({
      items: [],
      sessionID: 'ses_planner',
      planMessageID: null,
    });

    await runBlackboardKickoff('run_test');

    expect(mocks.startAutoTicker).not.toHaveBeenCalled();
  });

  // F1 regression: planner sweep error should not kill the run
  it('starts the auto-ticker when sweep throws but board has salvageable items', async () => {
    mocks.runPlannerSweep.mockRejectedValue(
      new Error('planner sweep aborted: session went silent'),
    );
    // Board has items from the recordPartialOutcome finding
    mocks.listBoardItems.mockReturnValue([
      { id: 'f_001', kind: 'finding', content: '[blackboard] partial outcome', status: 'done', createdAtMs: Date.now() },
    ]);

    await runBlackboardKickoff('run_test');

    expect(mocks.startAutoTicker).toHaveBeenCalledTimes(1);
    expect(mocks.startAutoTicker).toHaveBeenCalledWith('run_test', {
      periodicSweepMs: 5 * 60_000,
    });
  });

  it('does not start the auto-ticker when sweep throws and board is empty', async () => {
    mocks.runPlannerSweep.mockRejectedValue(
      new Error('planner sweep timed out after 900000ms'),
    );
    mocks.listBoardItems.mockReturnValue([]);

    await runBlackboardKickoff('run_test');

    expect(mocks.startAutoTicker).not.toHaveBeenCalled();
  });

  it('starts the auto-ticker with custom persistentSweepMinutes', async () => {
    mocks.runPlannerSweep.mockResolvedValue({
      items: [
        { id: 't_001', kind: 'todo', content: 'do task', status: 'open', createdAtMs: Date.now() },
      ],
      sessionID: 'ses_planner',
      planMessageID: null,
    });

    await runBlackboardKickoff('run_test', { persistentSweepMinutes: 10 });

    expect(mocks.startAutoTicker).toHaveBeenCalledWith('run_test', {
      periodicSweepMs: 10 * 60_000,
    });
  });

  it('starts the auto-ticker with periodicSweepMs=0 when persistentSweepMinutes is 0', async () => {
    mocks.runPlannerSweep.mockResolvedValue({
      items: [
        { id: 't_001', kind: 'todo', content: 'do task', status: 'open', createdAtMs: Date.now() },
      ],
      sessionID: 'ses_planner',
      planMessageID: null,
    });

    await runBlackboardKickoff('run_test', { persistentSweepMinutes: 0 });

    expect(mocks.startAutoTicker).toHaveBeenCalledWith('run_test', {
      periodicSweepMs: 0,
    });
  });
});