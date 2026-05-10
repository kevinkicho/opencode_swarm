import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  listBoardItems: vi.fn(),
  invalidateBoardView: vi.fn(),
  getBoardView: vi.fn(),
}));

vi.mock('../../store', () => ({ listBoardItems: mocks.listBoardItems }));
vi.mock('../../board-view', () => ({
  invalidateBoardView: mocks.invalidateBoardView,
  getBoardView: mocks.getBoardView,
}));
vi.mock('server-only', () => ({}));

describe('FileLockSet', () => {
  let FileLockSet: any;

  beforeAll(async () => {
    const mod = await import('../file-locks');
    FileLockSet = mod.FileLockSet;
  });

  beforeEach(() => {
    mocks.listBoardItems.mockReset();
    FileLockSet.release('run_test', 'todo_1');
    FileLockSet.release('run_test', 'todo_2');
  });

  it('acquires and releases file locks', () => {
    FileLockSet.acquire('run_test', 'todo_1', ['src/auth.ts', 'src/login.ts']);
    expect(FileLockSet.isLocked('run_test', ['src/auth.ts'])).toBe(true);
    expect(FileLockSet.isLocked('run_test', ['src/other.ts'])).toBe(false);

    FileLockSet.release('run_test', 'todo_1');
    expect(FileLockSet.isLocked('run_test', ['src/auth.ts'])).toBe(false);
  });

  it('allows same todo to re-acquire its own files (retry path)', () => {
    FileLockSet.acquire('run_test', 'todo_1', ['src/auth.ts']);
    expect(FileLockSet.isLocked('run_test', ['src/auth.ts'], 'todo_1')).toBe(false);
  });

  it('blocks different todo from locking same files', () => {
    FileLockSet.acquire('run_test', 'todo_1', ['src/auth.ts']);
    expect(FileLockSet.isLocked('run_test', ['src/auth.ts'], 'todo_2')).toBe(true);
  });

  it('rebuilds lock set from board state', () => {
    mocks.getBoardView.mockReturnValue({
      inProgress: [
        { id: 't1', status: 'in-progress', expectedFiles: ['a.ts'] },
        { id: 't3', status: 'in-progress', expectedFiles: ['c.ts', 'd.ts'] },
      ],
    });
    FileLockSet.rebuild('run_test');
    expect(FileLockSet.isLocked('run_test', ['a.ts'])).toBe(true);
    expect(FileLockSet.isLocked('run_test', ['b.ts'])).toBe(false);
    expect(FileLockSet.isLocked('run_test', ['c.ts'])).toBe(true);
  });

  it('returns false for empty file list', () => {
    expect(FileLockSet.isLocked('run_test', [])).toBe(false);
  });
});
