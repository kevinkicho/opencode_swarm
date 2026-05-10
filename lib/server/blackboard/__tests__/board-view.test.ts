import { describe, it, expect, beforeAll } from 'vitest';

describe('BoardView', () => {
  let getBoardView: Function;
  let invalidateBoardView: Function;

  beforeAll(async () => {
    const mod = await import('../board-view');
    getBoardView = mod.getBoardView;
    invalidateBoardView = mod.invalidateBoardView;
  });

  it('exports getBoardView as a function', () => {
    expect(typeof getBoardView).toBe('function');
  });

  it('exports invalidateBoardView as a function', () => {
    expect(typeof invalidateBoardView).toBe('function');
  });

  it('invalidateBoardView does not throw on arbitrary IDs', () => {
    expect(() => invalidateBoardView('non_existent_run')).not.toThrow();
  });
});
