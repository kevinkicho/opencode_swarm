//
// Tests for `lib/server/lru.ts`. Verifies: basic Map semantics, eviction
// of the least-recently-used entry, get-promotes, set-of-existing-key-
// promotes, max=0/1 edge cases.

import { describe, it, expect } from 'vitest';
import { LRU } from '../lru';

describe('LRU · basic Map semantics', () => {
  it('set + get round-trips', () => {
    const l = new LRU<string, number>(10);
    l.set('a', 1);
    expect(l.get('a')).toBe(1);
  });

  it('has() returns true for present, false for absent', () => {
    const l = new LRU<string, number>(10);
    l.set('a', 1);
    expect(l.has('a')).toBe(true);
    expect(l.has('missing')).toBe(false);
  });

  it('delete() removes the entry and returns true', () => {
    const l = new LRU<string, number>(10);
    l.set('a', 1);
    expect(l.delete('a')).toBe(true);
    expect(l.has('a')).toBe(false);
    // Second delete returns false (entry no longer present).
    expect(l.delete('a')).toBe(false);
  });

  it('clear() empties the cache', () => {
    const l = new LRU<string, number>(10);
    l.set('a', 1);
    l.set('b', 2);
    l.clear();
    expect(l.size).toBe(0);
  });

  it('size reflects current entry count', () => {
    const l = new LRU<string, number>(10);
    expect(l.size).toBe(0);
    l.set('a', 1);
    expect(l.size).toBe(1);
    l.set('b', 2);
    expect(l.size).toBe(2);
  });

  it('get on missing key returns undefined', () => {
    const l = new LRU<string, number>(10);
    expect(l.get('missing')).toBeUndefined();
  });
});

describe('LRU · eviction', () => {
  it('evicts the least-recently-used entry when size exceeds max', () => {
    const l = new LRU<string, number>(3);
    l.set('a', 1);
    l.set('b', 2);
    l.set('c', 3);
    l.set('d', 4); // evicts 'a' (oldest insert)
    expect(l.has('a')).toBe(false);
    expect(l.has('b')).toBe(true);
    expect(l.has('c')).toBe(true);
    expect(l.has('d')).toBe(true);
  });

  it('get() promotes the entry to most-recently-used', () => {
    const l = new LRU<string, number>(3);
    l.set('a', 1);
    l.set('b', 2);
    l.set('c', 3);
    l.get('a'); // promote 'a' to MRU
    l.set('d', 4); // evicts 'b' (now LRU since 'a' was promoted)
    expect(l.has('a')).toBe(true);
    expect(l.has('b')).toBe(false);
    expect(l.has('c')).toBe(true);
    expect(l.has('d')).toBe(true);
  });

  it('set() of an existing key promotes to most-recently-used', () => {
    const l = new LRU<string, number>(3);
    l.set('a', 1);
    l.set('b', 2);
    l.set('c', 3);
    l.set('a', 99); // re-set a — promotes to MRU + updates value
    l.set('d', 4); // evicts 'b'
    expect(l.has('b')).toBe(false);
    expect(l.get('a')).toBe(99);
  });

  it('evicts in insertion order when no gets have happened', () => {
    const l = new LRU<string, number>(2);
    l.set('a', 1);
    l.set('b', 2);
    l.set('c', 3); // evicts 'a'
    l.set('d', 4); // evicts 'b'
    expect(l.has('a')).toBe(false);
    expect(l.has('b')).toBe(false);
    expect(l.has('c')).toBe(true);
    expect(l.has('d')).toBe(true);
  });

  it('size never exceeds max', () => {
    const l = new LRU<string, number>(3);
    for (let i = 0; i < 100; i++) l.set(`k${i}`, i);
    expect(l.size).toBe(3);
  });
});

describe('LRU · edge cases', () => {
  it('max=0 means cache is disabled (set is a no-op)', () => {
    const l = new LRU<string, number>(0);
    l.set('a', 1);
    expect(l.size).toBe(0);
    expect(l.has('a')).toBe(false);
  });

  it('max=1 stores at most one entry', () => {
    const l = new LRU<string, number>(1);
    l.set('a', 1);
    l.set('b', 2);
    expect(l.size).toBe(1);
    expect(l.has('a')).toBe(false);
    expect(l.has('b')).toBe(true);
  });

  it('rejects negative max with a clear error', () => {
    expect(() => new LRU<string, number>(-1)).toThrow();
  });

  it('rejects fractional max', () => {
    expect(() => new LRU<string, number>(1.5)).toThrow();
  });

  it('iterating yields entries in insertion order (LRU first)', () => {
    const l = new LRU<string, number>(10);
    l.set('a', 1);
    l.set('b', 2);
    l.set('c', 3);
    const order = [...l.keys()];
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
