import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const mocks = vi.hoisted(() => ({
  transitionStatus: vi.fn(),
  insertBoardItem: vi.fn(),
  mintItemId: vi.fn(),
  release: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('../../store', () => ({
  transitionStatus: mocks.transitionStatus,
  insertBoardItem: mocks.insertBoardItem,
}));
vi.mock('../../item-ids', () => ({ mintItemId: mocks.mintItemId }));
vi.mock('../file-locks', () => ({ FileLockSet: { release: mocks.release } }));
vi.mock('../../board-view', () => ({ invalidateBoardView: mocks.invalidate }));
vi.mock('server-only', () => ({}));

describe('transitionItem', () => {
  let transitionItem: Function;

  beforeAll(async () => {
    const mod = await import('../transition-item');
    transitionItem = mod.transitionItem;
  });

  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.mintItemId.mockReturnValue('finding_id');
  });

  function makeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'item_1',
      kind: 'todo',
      content: 'fix the login bug in auth module',
      status: 'in-progress',
      ownerAgentId: 'agent_1',
      createdAt: Date.now(),
      ...overrides,
    };
  }

  it('transitions in-progress → done and releases file locks', async () => {
    const item = makeItem();
    await transitionItem('run_test', item, 'done', { fileHashes: [{ path: 'a.ts', sha: 'abc' }] });
    expect(mocks.release).toHaveBeenCalledWith('run_test', 'item_1');
    expect(mocks.transitionStatus).toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalledWith('run_test');
  });

  it('transitions in-progress → stale with finding when reason provided', async () => {
    const item = makeItem();
    await transitionItem('run_test', item, 'stale', { reason: 'turn timed out' });
    expect(mocks.release).toHaveBeenCalledWith('run_test', 'item_1');
    expect(mocks.insertBoardItem).toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalledWith('run_test');
  });

  it('transitions in-progress → open on retry with budget remaining', async () => {
    const item = makeItem();
    await transitionItem('run_test', item, 'retry', {
      reason: 'turn silent',
      retryCount: 0,
      maxRetries: 2,
    });
    expect(mocks.release).toHaveBeenCalledWith('run_test', 'item_1');
    expect(mocks.transitionStatus).toHaveBeenCalled();
  });

  it('transitions in-progress → stale when retry budget exhausted', async () => {
    const item = makeItem();
    await transitionItem('run_test', item, 'retry', {
      reason: 'turn silent',
      retryCount: 1,
      maxRetries: 2,
    });
    expect(mocks.release).toHaveBeenCalledWith('run_test', 'item_1');
    expect(mocks.invalidate).toHaveBeenCalledWith('run_test');
  });

  it('handles open → stale for zombie cleanup (open items)', async () => {
    const item = makeItem({ status: 'open' });
    await transitionItem('run_test', item, 'stale', { reason: 'retry-exhausted safety net' });
    expect(mocks.release).toHaveBeenCalledWith('run_test', 'item_1');
    expect(mocks.invalidate).toHaveBeenCalledWith('run_test');
  });

  it('always releases file locks regardless of outcome', async () => {
    const item = makeItem();
    await transitionItem('run_test', item, 'done', {});
    expect(mocks.release).toHaveBeenCalledWith('run_test', 'item_1');
  });
});
