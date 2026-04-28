// Tests for opencodeFetch's circuit breaker. The breaker exists to
// short-circuit fan-outs when opencode :4097 is unreachable — without it,
// /api/swarm/run's 130-row × N-session derive path waits 20s × every
// concurrent fetch on the cold path.
//
// 2026-04-27 retune: bumped threshold 3→6 / window 2s→5s after a live
// map-reduce run tripped the breaker on 3 legitimate parallel
// /message fetches. Also: timeouts no longer count as breaker failures
// (we control the timer; only TypeError-shaped fetch rejections count).
//
// Tests inject failures via global.fetch override — TypeError shape is
// what the real Node fetch throws on connection-refused / ECONNRESET.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { opencodeFetch } from '../client';

describe('opencodeFetch circuit breaker', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    // Reset the breaker by clearing its globalThis slot. The slot is
    // keyed by Symbol.for so we can reach it from a test.
    const slot = Symbol.for('opencode_swarm.circuitBreaker.v1');
    delete (globalThis as Record<symbol, unknown>)[slot];
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns synthesized 503 after 6 hard failures within window', async () => {
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount += 1;
      // TypeError shape — Node's fetch throws this on connection-refused.
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as typeof fetch;

    // 6 hard failures arm the breaker.
    for (let i = 0; i < 6; i += 1) {
      await opencodeFetch('/probe').catch(() => null);
    }
    expect(callCount).toBe(6);

    // 7th call short-circuits — no fetch invocation, immediate 503.
    const res = await opencodeFetch('/probe');
    expect(callCount).toBe(6);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/circuit-breaker/i);
  });

  it('resets the breaker on a successful response', async () => {
    let callCount = 0;
    let mode: 'fail' | 'ok' = 'fail';
    global.fetch = vi.fn(async () => {
      callCount += 1;
      if (mode === 'fail') throw new TypeError('fetch failed');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    // 3 failures (below the 6-threshold).
    for (let i = 0; i < 3; i += 1) {
      await opencodeFetch('/probe').catch(() => null);
    }
    expect(callCount).toBe(3);

    // Recovery: now opencode is up. Success resets the breaker.
    mode = 'ok';
    const res = await opencodeFetch('/probe');
    expect(res.status).toBe(200);
    expect(callCount).toBe(4);

    // Two more failures still don't trip — the success reset the counter.
    mode = 'fail';
    await opencodeFetch('/probe').catch(() => null);
    await opencodeFetch('/probe').catch(() => null);
    expect(callCount).toBe(6);

    // The breaker is NOT tripped (we're at 2 failures since reset, well
    // under the 6 threshold). The 7th call still attempts fetch.
    await opencodeFetch('/probe').catch(() => null);
    expect(callCount).toBe(7);
  });

  it('does NOT trip on AbortError (timeout from our own timer)', async () => {
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount += 1;
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }) as typeof fetch;

    // Even 10 timeouts should not trip the breaker. Timeouts are our
    // own choice, not a network signal.
    for (let i = 0; i < 10; i += 1) {
      await opencodeFetch('/probe').catch(() => null);
    }
    expect(callCount).toBe(10);

    // 11th still calls fetch — breaker untripped.
    await opencodeFetch('/probe').catch(() => null);
    expect(callCount).toBe(11);
  });
});
