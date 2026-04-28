// Tests for opencodeFetch's circuit breaker. The breaker exists to
// short-circuit fan-outs when opencode :4097 is unreachable — without it,
// /api/swarm/run's 130-row × N-session derive path waits 8s × every
// concurrent fetch (effectively ~11s on the cold path). The breaker turns
// that into 1.5s probe + immediate failure for the rest.
//
// We can't easily test the timeout directly without spinning up a slow
// test server, so the breaker logic is tested via failure injection:
// patch global.fetch to reject N times in a row, then verify subsequent
// calls return the synthesized 503 without invoking fetch at all.

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

  it('returns synthesized 503 after 3 failures within window', async () => {
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount += 1;
      throw new Error('connection refused');
    }) as typeof fetch;

    // 3 failures arm the breaker.
    for (let i = 0; i < 3; i += 1) {
      await opencodeFetch('/probe').catch(() => null);
    }
    expect(callCount).toBe(3);

    // 4th call short-circuits — no fetch invocation, immediate 503.
    const res = await opencodeFetch('/probe');
    expect(callCount).toBe(3);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/circuit-breaker/i);
  });

  it('resets the breaker on a successful response', async () => {
    let callCount = 0;
    let mode: 'fail' | 'ok' = 'fail';
    global.fetch = vi.fn(async () => {
      callCount += 1;
      if (mode === 'fail') throw new Error('boom');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    // 2 failures (below threshold).
    await opencodeFetch('/probe').catch(() => null);
    await opencodeFetch('/probe').catch(() => null);
    expect(callCount).toBe(2);

    // Recovery: now opencode is up. Success resets the breaker.
    mode = 'ok';
    const res = await opencodeFetch('/probe');
    expect(res.status).toBe(200);
    expect(callCount).toBe(3);

    // Even another two failures don't trip — the success reset the
    // failure counter.
    mode = 'fail';
    await opencodeFetch('/probe').catch(() => null);
    await opencodeFetch('/probe').catch(() => null);
    expect(callCount).toBe(5);

    // 5th and 6th calls hit fetch (no short-circuit) since we're below
    // the 3-failure threshold post-reset.
    const res2 = await opencodeFetch('/probe').catch((e: Error) => e);
    // A real failure throws; the breaker only synthesizes 503 once tripped.
    expect(callCount).toBe(6);
    expect(res2).toBeInstanceOf(Error);
  });
});
