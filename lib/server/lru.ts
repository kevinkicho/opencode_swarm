//
// Pre-fix: swarm-registry.ts had three unbounded Map caches (metaCache,
// derivedRowCache, sessionIndex) plus tree/route.ts treeCache. At
// "tens of runs" scale they're fine, but a long-lived dev process
// accumulates sessionIDs forever — every session across every run,
// including deleted runs.
//
// This LRU is a small, dependency-free wrapper around `Map`'s
// insertion-order iteration. `get` and `set` re-insert to bump the
// entry to the most-recently-used position. Eviction trims the oldest
// entries when size exceeds `max`.

import 'server-only';

export class LRU<K, V> {
  private store = new Map<K, V>();
  constructor(public readonly max: number) {
    if (max < 0 || !Number.isInteger(max)) {
      throw new Error(`LRU max must be a non-negative integer (got ${max})`);
    }
  }

  get size(): number {
    return this.store.size;
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  get(key: K): V | undefined {
    if (!this.store.has(key)) return undefined;
    // Re-insert to bump to MRU position. Map preserves insertion
    // order — delete + set moves the key to the end.
    const value = this.store.get(key)!;
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.max === 0) return; // disabled cache; no-op
    if (this.store.has(key)) {
      // Refresh position by deleting first.
      this.store.delete(key);
    } else if (this.store.size >= this.max) {
      // Evict the LRU entry (first in insertion order).
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, value);
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  // Iterate from least-recently-used to most-recently-used.
  *entries(): IterableIterator<[K, V]> {
    for (const entry of this.store) yield entry;
  }

  *keys(): IterableIterator<K> {
    for (const k of this.store.keys()) yield k;
  }

  *values(): IterableIterator<V> {
    for (const v of this.store.values()) yield v;
  }
}
