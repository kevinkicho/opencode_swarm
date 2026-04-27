// Picker ordering contract — pinned because /api/swarm/run upstream order
// can drift between polls (opencode session-list endpoint has documented
// instability per the project memory). The sort here gives the picker a
// deterministic display order regardless of fetch order.

import { describe, it, expect } from 'vitest';
import { sortRunsForPicker } from '../picker-sort';
import type { SwarmRunListRow, SwarmRunStatus } from '../swarm-run-types';

function row(id: string, status: SwarmRunStatus, createdAt: number): SwarmRunListRow {
  return {
    meta: {
      swarmRunID: id,
      pattern: 'none',
      createdAt,
      workspace: '/tmp/x',
      sessionIDs: [`ses_${id}`],
    },
    status,
    lastActivityTs: createdAt,
    costTotal: 0,
    tokensTotal: 0,
  };
}

describe('sortRunsForPicker', () => {
  it('alive bucket (live + idle) precedes everything else', () => {
    const rows = [
      row('stale-1000', 'stale', 1000),
      row('live-100', 'live', 100),
      row('idle-500', 'idle', 500),
      row('error-900', 'error', 900),
    ];
    const sorted = sortRunsForPicker(rows);
    const ids = sorted.map((r) => r.meta.swarmRunID);
    // live first, then idle, then non-alive by createdAt desc.
    // Within the non-alive bucket: stale (1000) before error (900)
    // because the tiebreaker is createdAt desc, not status.
    expect(ids).toEqual(['live-100', 'idle-500', 'stale-1000', 'error-900']);
  });

  it('live precedes idle within the alive cluster', () => {
    const rows = [
      row('idle-newer', 'idle', 2000),
      row('live-older', 'live', 1000),
    ];
    expect(sortRunsForPicker(rows).map((r) => r.meta.swarmRunID)).toEqual([
      'live-older',
      'idle-newer',
    ]);
  });

  it('within bucket sorts createdAt desc (newest first)', () => {
    const rows = [
      row('a-old', 'stale', 100),
      row('b-newer', 'stale', 300),
      row('c-newest', 'stale', 500),
    ];
    expect(sortRunsForPicker(rows).map((r) => r.meta.swarmRunID)).toEqual([
      'c-newest',
      'b-newer',
      'a-old',
    ]);
  });

  it('stable across shuffled inputs (deterministic)', () => {
    // Build the same logical set in 5 different orders. The picker
    // must show the same ordering each time. Backstops the upstream
    // order-drift class — even if /api/swarm/run returns rows in a
    // random permutation per poll, the rendered list is stable.
    const set = [
      row('live-1', 'live', 1000),
      row('live-2', 'live', 2000),
      row('idle-1', 'idle', 1500),
      row('stale-1', 'stale', 800),
      row('error-1', 'error', 3000),
    ];
    const expected = sortRunsForPicker(set).map((r) => r.meta.swarmRunID);
    for (let i = 0; i < 5; i++) {
      const shuffled = [...set].sort(() => Math.random() - 0.5);
      const got = sortRunsForPicker(shuffled).map((r) => r.meta.swarmRunID);
      expect(got).toEqual(expected);
    }
  });

  it('does not mutate the input array', () => {
    const original = [
      row('a', 'stale', 100),
      row('b', 'live', 200),
    ];
    const before = original.map((r) => r.meta.swarmRunID);
    sortRunsForPicker(original);
    expect(original.map((r) => r.meta.swarmRunID)).toEqual(before);
  });

  it('empty list returns empty list', () => {
    expect(sortRunsForPicker([])).toEqual([]);
  });

  it('ties (same status + same createdAt) are accepted in input order', () => {
    // No explicit tiebreaker — sort is stable in modern JS engines, so
    // two identical-key rows preserve relative input order. This test
    // pins that behavior so a future change to add a tiebreaker
    // (e.g. by swarmRunID) is a deliberate decision, not silent drift.
    const rows = [
      row('first', 'live', 1000),
      row('second', 'live', 1000),
    ];
    expect(sortRunsForPicker(rows).map((r) => r.meta.swarmRunID)).toEqual([
      'first',
      'second',
    ]);
  });
});
