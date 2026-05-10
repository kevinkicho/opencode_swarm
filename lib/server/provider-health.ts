// Provider health probe — checks whether the ollama daemon is reachable.
//
// Extracted from coordinator/wait.ts so it can be reused by the tick cycle
// and other modules without pulling in the full waitForSessionIdle dependency.
// The uncached version hits /api/ps with a 5s timeout. The cached version
// remembers the last result for CACHE_TTL_MS so repeated ticks don't
// re-probe a known-healthy or known-down provider.

import 'server-only';

import { OLLAMA_URL } from '../config';

const PROBE_TIMEOUT_MS = 5 * 1000;
const CACHE_TTL_MS = 60 * 1000;

let cachedResult: { ok: boolean; detail?: string; ts: number } | null = null;

export async function probeProviders(): Promise<{ ok: boolean; detail?: string }> {
  const now = Date.now();

  // Return cached result if fresh enough.
  if (cachedResult && now - cachedResult.ts < CACHE_TTL_MS) {
    return { ok: cachedResult.ok, detail: cachedResult.detail };
  }

  const result = await probeOllamaPs();
  cachedResult = { ...result, ts: now };
  return result;
}

// Raw probe — no cache. Hits ollama /api/ps with a short timeout.
// Returns ok=true if ollama is responding, ok=false otherwise.
export async function probeOllamaPs(): Promise<{ ok: boolean; detail?: string }> {
  const base = OLLAMA_URL.replace(/\/$/, '');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/ps`, {
      method: 'GET',
      signal: ac.signal,
    });
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Invalidate the cache — call this when a known failure mode resolves
// (e.g., after a session completes successfully) so the next probe
// doesn't serve a stale "provider down" result.
export function invalidateProviderHealthCache(): void {
  cachedResult = null;
}