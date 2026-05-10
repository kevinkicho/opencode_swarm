import { describe, it, expect } from 'vitest';

describe('auto-ticker types', () => {
  it('IDLE_TICKS_BEFORE_STOP is 6', async () => {
    const mod = await import('../types');
    expect(mod.IDLE_TICKS_BEFORE_STOP).toBe(6);
  });

  it('IDLE_TICKS_BEFORE_EAGER_SWEEP is 2 (tightened from 3)', async () => {
    const mod = await import('../types');
    expect(mod.IDLE_TICKS_BEFORE_EAGER_SWEEP).toBe(2);
  });

  it('MIN_MS_BETWEEN_SWEEPS is 60000 (tightened from 120000)', async () => {
    const mod = await import('../types');
    expect(mod.MIN_MS_BETWEEN_SWEEPS).toBe(60000);
  });

  it('NO_CLAIMABLE_WORK_TICKS is 18', async () => {
    const mod = await import('../types');
    expect(mod.NO_CLAIMABLE_WORK_TICKS).toBe(18);
  });

  it('TIER_LADDER has 5 rungs', async () => {
    const mod = await import('../types');
    expect(mod.TIER_LADDER).toHaveLength(5);
  });

  it('MAX_TIER equals TIER_LADDER length', async () => {
    const mod = await import('../types');
    expect(mod.MAX_TIER).toBe(mod.TIER_LADDER.length);
  });

  it('DEFAULT_INTERVAL_MS is 10000', async () => {
    const mod = await import('../types');
    expect(mod.DEFAULT_INTERVAL_MS).toBe(10000);
  });

  it('MAX_CONSECUTIVE_FILTERED_ALL_SWEEPS is 4', async () => {
    const mod = await import('../types');
    expect(mod.MAX_CONSECUTIVE_FILTERED_ALL_SWEEPS).toBe(4);
  });
});
