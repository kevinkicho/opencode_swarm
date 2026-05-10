import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TickerState } from '../types';
import type { BoardItem } from '@/lib/blackboard/types';

const mocks = vi.hoisted(() => ({
  getRun: vi.fn(),
  listBoardItems: vi.fn(),
  insertBoardItem: vi.fn(),
  livePlanner: vi.fn(),
  maybeRunAudit: vi.fn(),
  mintItemId: vi.fn(),
  updateRunMeta: vi.fn(),
  isRetryExhausted: vi.fn(),
}));

vi.mock('../../swarm-registry', () => ({
  getRun: mocks.getRun,
  updateRunMeta: mocks.updateRunMeta,
}));

vi.mock('../../store', () => ({
  listBoardItems: mocks.listBoardItems,
  insertBoardItem: mocks.insertBoardItem,
}));

vi.mock('../live-exports', () => ({
  livePlanner: mocks.livePlanner,
}));

vi.mock('../audit', () => ({
  maybeRunAudit: mocks.maybeRunAudit,
}));

vi.mock('../planner', () => ({
  mintItemId: mocks.mintItemId,
}));

vi.mock('../policies', () => ({
  isRetryExhausted: mocks.isRetryExhausted,
  MAX_STALE_RETRIES: 3,
}));

// BoardView caches across test scenarios — invalidate on each reset.
let invalidateBoardView: (swarmRunID: string) => void;
beforeAll(async () => {
  const mod = await import('../../board-view');
  invalidateBoardView = mod.invalidateBoardView;
});

function makeState(overrides: Partial<TickerState> = {}): TickerState {
  return {
    swarmRunID: 'run_test',
    intervalMs: 10_000,
    timer: null,
    stopped: false,
    startedAtMs: Date.now() - 60_000,
    sessionIDs: ['ses_a', 'ses_b'],
    slots: new Map([
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
    retryAfterEndsAtMs: undefined,
    ...overrides,
  } as TickerState;
}

const aTodo = (status: BoardItem['status'], note = ''): BoardItem => ({
  id: 't_001',
  kind: 'todo',
  content: 'do the thing',
  status,
  createdAtMs: Date.now(),
  note,
});

const aCriterion = (status: BoardItem['status']): BoardItem => ({
  id: 'c_001',
  kind: 'criterion',
  content: 'verify the thing works',
  status,
  createdAtMs: Date.now(),
});

const aFinding = (content: string): BoardItem => ({
  id: 'f_001',
  kind: 'finding',
  content,
  status: 'done',
  createdAtMs: Date.now(),
});

describe('boardHasWorkInFlight', () => {
  let boardHasWorkInFlight: (swarmRunID: string) => boolean;

  beforeAll(async () => {
    const mod = await import('../escalation');
    boardHasWorkInFlight = mod.boardHasWorkInFlight;
  });

  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.isRetryExhausted.mockReturnValue(false);
    invalidateBoardView?.('run_test');
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns true when a claimed todo exists', () => {
    mocks.listBoardItems.mockReturnValue([aTodo('claimed')]);
    expect(boardHasWorkInFlight('run_test')).toBe(true);
  });

  it('returns true when an in-progress todo exists', () => {
    mocks.listBoardItems.mockReturnValue([aTodo('in-progress')]);
    expect(boardHasWorkInFlight('run_test')).toBe(true);
  });

  it('returns true when an open non-retry-exhausted todo exists', () => {
    mocks.listBoardItems.mockReturnValue([aTodo('open')]);
    expect(boardHasWorkInFlight('run_test')).toBe(true);
  });

  it('returns false when only retry-exhausted open todos exist', () => {
    mocks.isRetryExhausted.mockReturnValue(true);
    mocks.listBoardItems.mockReturnValue([aTodo('open', '[retry:3]')]);
    expect(boardHasWorkInFlight('run_test')).toBe(false);
  });

  it('returns false when only stale todos exist', () => {
    mocks.listBoardItems.mockReturnValue([aTodo('stale')]);
    expect(boardHasWorkInFlight('run_test')).toBe(false);
  });

  it('returns false when only done todos exist', () => {
    mocks.listBoardItems.mockReturnValue([aTodo('done')]);
    expect(boardHasWorkInFlight('run_test')).toBe(false);
  });

  // F2 regression: open/blocked criteria should count as work in flight
  it('returns true when open criteria exist', () => {
    mocks.listBoardItems.mockReturnValue([aCriterion('open')]);
    expect(boardHasWorkInFlight('run_test')).toBe(true);
  });

  it('returns true when blocked criteria exist', () => {
    mocks.listBoardItems.mockReturnValue([aCriterion('blocked')]);
    expect(boardHasWorkInFlight('run_test')).toBe(true);
  });

  it('returns false when criteria are done', () => {
    mocks.listBoardItems.mockReturnValue([aCriterion('done')]);
    expect(boardHasWorkInFlight('run_test')).toBe(false);
  });

  it('returns false when criteria are stale', () => {
    mocks.listBoardItems.mockReturnValue([aCriterion('stale')]);
    expect(boardHasWorkInFlight('run_test')).toBe(false);
  });

  it('returns true when all todos are done but open criteria exist', () => {
    mocks.listBoardItems.mockReturnValue([aTodo('done'), aCriterion('open')]);
    expect(boardHasWorkInFlight('run_test')).toBe(true);
  });

  it('returns true when all todos are stale but blocked criteria exist', () => {
    mocks.listBoardItems.mockReturnValue([aTodo('stale'), aCriterion('blocked')]);
    expect(boardHasWorkInFlight('run_test')).toBe(true);
  });

  it('ignores findings entirely', () => {
    mocks.listBoardItems.mockReturnValue([
      aTodo('done'),
      aFinding('[ratchet] Escalated to tier 2'),
    ]);
    expect(boardHasWorkInFlight('run_test')).toBe(false);
  });
});

describe('attemptTierEscalation · F4 ratchet finding dedup', () => {
  let attemptTierEscalation: (state: TickerState) => Promise<boolean>;

  beforeAll(async () => {
    const mod = await import('../escalation');
    attemptTierEscalation = mod.attemptTierEscalation;
  });

  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.maybeRunAudit.mockResolvedValue(undefined);
    mocks.updateRunMeta.mockResolvedValue(undefined);
    mocks.mintItemId.mockReturnValue('item_test');
    mocks.isRetryExhausted.mockReturnValue(false);
    invalidateBoardView?.('run_test');
  });
  afterEach(() => vi.restoreAllMocks());

  it('inserts a tier-2 finding when no same-tier finding exists', async () => {
    const state = makeState({ currentTier: 1 });
    mocks.listBoardItems.mockReturnValue([]);
    mocks.livePlanner.mockReturnValue({
      runPlannerSweep: vi.fn().mockResolvedValue({ items: [], filteredAll: false }),
    });

    const result = await attemptTierEscalation(state);

    expect(result).toBe(false);
    // Escalation finding should be inserted (no existing one)
    expect(mocks.insertBoardItem).toHaveBeenCalledTimes(1);
    const [runId, item] = mocks.insertBoardItem.mock.calls[0];
    expect(runId).toBe('run_test');
    expect(item.kind).toBe('finding');
    expect(item.content).toContain('[ratchet] Escalated to tier 2');
  });

  it('skips tier-2 finding when one already exists', async () => {
    const state = makeState({ currentTier: 1 });
    mocks.listBoardItems.mockReturnValue([
      aFinding('[ratchet] Escalated to tier 2: Refactor, extract, and enhance'),
    ]);
    mocks.livePlanner.mockReturnValue({
      runPlannerSweep: vi.fn().mockResolvedValue({ items: [], filteredAll: false }),
    });

    const result = await attemptTierEscalation(state);

    expect(result).toBe(false);
    // No duplicate escalation finding should be inserted
    expect(mocks.insertBoardItem).not.toHaveBeenCalled();
  });

  it('inserts a sweep-error finding when the planner sweep throws', async () => {
    const state = makeState({ currentTier: 1 });
    // First listBoardItems call: dedup check for escalation finding → no existing
    // Second listBoardItems call: dedup check for error finding → no existing
    mocks.listBoardItems
      .mockReturnValueOnce([]) // escalation dedup: no existing tier-2 finding
      .mockReturnValueOnce([]); // error dedup: no existing error finding
    mocks.livePlanner.mockReturnValue({
      runPlannerSweep: vi.fn().mockRejectedValue(new Error('planner sweep aborted: session went silent')),
    });

    await attemptTierEscalation(state);

    // Both escalation finding and error finding should be inserted
    expect(mocks.insertBoardItem).toHaveBeenCalledTimes(2);
    const escalationCall = mocks.insertBoardItem.mock.calls[0];
    const errorCall = mocks.insertBoardItem.mock.calls[1];
    expect(escalationCall[1].content).toContain('[ratchet] Escalated to tier 2');
    expect(errorCall[1].content).toContain('[ratchet] Tier-2 sweep error:');
  });

  it('skips sweep-error finding when one already exists for the same tier', async () => {
    const state = makeState({ currentTier: 1 });
    // First call: dedup check for escalation finding → no existing
    // Second call: error dedup check → existing error finding
    mocks.listBoardItems
      .mockReturnValueOnce([]) // no escalation finding
      .mockReturnValueOnce([
        aFinding('[ratchet] Tier-2 sweep error: planner sweep aborted'),
      ]);
    mocks.livePlanner.mockReturnValue({
      runPlannerSweep: vi.fn().mockRejectedValue(new Error('different error')),
    });

    await attemptTierEscalation(state);

    // Escalation finding should be inserted, but NOT the error finding
    expect(mocks.insertBoardItem).toHaveBeenCalledTimes(1);
    const [_, item] = mocks.insertBoardItem.mock.calls[0];
    expect(item.content).toContain('[ratchet] Escalated to tier 2');
    // The error finding should NOT be inserted since one already exists
  });

  it('returns false and does not escalate when already at max tier', async () => {
    const state = makeState({ currentTier: 5 }); // MAX_TIER
    const result = await attemptTierEscalation(state);
    expect(result).toBe(false);
    expect(mocks.insertBoardItem).not.toHaveBeenCalled();
  });

  it('returns false and does not escalate when stopped', async () => {
    const state = makeState({ stopped: true });
    const result = await attemptTierEscalation(state);
    expect(result).toBe(false);
    expect(mocks.insertBoardItem).not.toHaveBeenCalled();
  });
});