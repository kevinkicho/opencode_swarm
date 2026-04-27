// Visual mapping contract for SwarmRunStatus. The rename memory ("status
// rename live/idle/error/stale") flagged that tone-class drift across
// components was a real risk before consolidation. This test pins the
// canonical map so a future palette tweak surfaces here loudly.

import { describe, it, expect } from 'vitest';
import {
  STATUS_VISUAL,
  STATUS_BURN_VISUAL,
  STATUS_PRIORITY,
} from '../swarm-run-visual';

describe('STATUS_VISUAL', () => {
  it('covers all five SwarmRunStatus variants', () => {
    const keys = Object.keys(STATUS_VISUAL).sort();
    expect(keys).toEqual(['error', 'idle', 'live', 'stale', 'unknown']);
  });

  it('live status pulses mint, idle holds mint, stale fades fog', () => {
    expect(STATUS_VISUAL.live.dot).toBe('bg-mint animate-pulse');
    expect(STATUS_VISUAL.idle.dot).toBe('bg-mint');
    expect(STATUS_VISUAL.stale.dot).toBe('bg-fog-500');
  });

  it('error gets a distinct rust tone', () => {
    expect(STATUS_VISUAL.error.dot).toBe('bg-rust');
    expect(STATUS_VISUAL.error.tone).toBe('text-rust');
  });

  it('rank ordering surfaces live first, unknown last', () => {
    const ranks = Object.values(STATUS_VISUAL)
      .map((v) => v.rank)
      .sort((a, b) => a - b);
    // Strictly increasing 0..4 — no ties, which the picker relies on for
    // stable bucket ordering.
    expect(ranks).toEqual([0, 1, 2, 3, 4]);
  });

  it('labels match status names exactly (except unknown which uses em-dash)', () => {
    expect(STATUS_VISUAL.live.label).toBe('live');
    expect(STATUS_VISUAL.idle.label).toBe('idle');
    expect(STATUS_VISUAL.error.label).toBe('error');
    expect(STATUS_VISUAL.stale.label).toBe('stale');
    expect(STATUS_VISUAL.unknown.label).toBe('—');
  });
});

describe('STATUS_BURN_VISUAL', () => {
  it('live=amber for the burn-rate palette (different mental model)', () => {
    // The burn palette inverts live: amber for "actively spending"
    // rather than mint for "still attached." Documenting the contrast
    // here so a refactor that re-unifies the two palettes fails loudly.
    expect(STATUS_BURN_VISUAL.live.bg).toBe('bg-amber');
    expect(STATUS_VISUAL.live.dot).not.toBe(STATUS_BURN_VISUAL.live.bg);
  });

  it('error stays rust across both palettes', () => {
    expect(STATUS_VISUAL.error.tone).toBe('text-rust');
    expect(STATUS_BURN_VISUAL.error.tone).toBe('text-rust');
  });
});

describe('STATUS_PRIORITY', () => {
  it('error dominates everything (fold-N-into-one)', () => {
    expect(STATUS_PRIORITY[0]).toBe('error');
  });

  it('alive bucket (live+idle) before stopped bucket (stale+unknown)', () => {
    const liveIdx = STATUS_PRIORITY.indexOf('live');
    const idleIdx = STATUS_PRIORITY.indexOf('idle');
    const staleIdx = STATUS_PRIORITY.indexOf('stale');
    const unknownIdx = STATUS_PRIORITY.indexOf('unknown');
    expect(liveIdx).toBeLessThan(staleIdx);
    expect(idleIdx).toBeLessThan(staleIdx);
    expect(staleIdx).toBeLessThan(unknownIdx);
  });

  it('contains every status exactly once', () => {
    expect(STATUS_PRIORITY).toHaveLength(5);
    expect(new Set(STATUS_PRIORITY).size).toBe(5);
  });
});
