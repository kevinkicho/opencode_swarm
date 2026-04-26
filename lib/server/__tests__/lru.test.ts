// HARDENING_PLAN.md#D3 — bounded LRU caches.
//
// Tests for `lib/server/lru.ts` (TO BE WRITTEN as part of D3). Three
// in-memory caches (`metaCache`, `derivedRowCache`, `sessionIndex`,
// `treeCache`) currently grow without bound. A simple LRU helper at
// max=500 entries fixes them all.
//
// Status: scaffold. Un-skip once lru.ts ships.

import { describe } from 'vitest';

describe.skip('server · LRU<K, V> (D3 — to be implemented)', () => {
  // Recipe:
  //
  //   import { LRU } from '../lru';

  // === Basic Map semantics ===
  //
  // it('set + get round-trips');
  // it('has() returns true for present, false for absent');
  // it('delete() removes the entry');
  // it('clear() empties the cache');
  // it('size reflects current entry count');

  // === Eviction ===
  //
  // it('evicts the least-recently-used entry when size exceeds max');
  // it('get() promotes the entry to most-recently-used');
  // it('set() of an existing key promotes to most-recently-used');
  // it('evicts in insertion order when no gets have happened');

  // === Edge cases ===
  //
  // it('max=0 means cache is disabled (set is a no-op)');
  // it('max=1 stores at most one entry');
  // it('iterating yields entries in least-to-most-recently-used order');
});
