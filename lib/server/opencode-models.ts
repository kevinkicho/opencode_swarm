// Model context-limit lookup. Backs the F7 prompt-size preflight in
// postSessionMessageServer (POSTMORTEMS/2026-04-24).
//
// Source of truth: opencode's GET /model endpoint, which returns the
// runtime-resolved model catalog including each provider's
// `limit.context` value (matches what opencode itself enforces). We
// cache the response with a 5-min TTL so the per-call cost is one
// in-process Map lookup after the first sweep on a fresh server.
//
// Failure mode: if opencode's /model is unreachable or malformed, we
// return null from getModelContextLimit — callers treat null as
// "unknown, skip preflight". This is the safe default; better to
// dispatch a too-large prompt and let opencode reject it than to
// false-fire and refuse a legitimate dispatch.
//
// Server-only.

import { opencodeFetch } from '../opencode/client';

interface ModelInfoWire {
  // opencode's wire shape: { providerID, modelID, limit: { context, output } }
  // and a few other fields we ignore here.
  providerID?: string;
  modelID?: string;
  limit?: { context?: number; output?: number };
}

interface CacheEntry {
  fetchedAt: number;
  byKey: Map<string, number>;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;

async function refresh(): Promise<CacheEntry> {
  const res = await opencodeFetch('/model');
  if (!res.ok) {
    throw new Error(`opencode /model -> HTTP ${res.status}`);
  }
  const raw = (await res.json()) as unknown;
  const map = new Map<string, number>();
  if (Array.isArray(raw)) {
    for (const m of raw as ModelInfoWire[]) {
      const ctx = m.limit?.context;
      if (typeof ctx !== 'number' || !Number.isFinite(ctx) || ctx <= 0) continue;
      // Index by both `providerID/modelID` (canonical) and bare modelID
      // so callers that have only the modelID still hit the cache.
      if (m.providerID && m.modelID) {
        map.set(`${m.providerID}/${m.modelID}`, ctx);
      }
      if (m.modelID) {
        // First write wins for bare-modelID — when two providers ship
        // the same modelID we'd otherwise alternate based on iteration
        // order. The canonical full key still exists for callers that
        // know the provider.
        if (!map.has(m.modelID)) map.set(m.modelID, ctx);
      }
    }
  }
  return { fetchedAt: Date.now(), byKey: map };
}

async function ensureCache(): Promise<CacheEntry> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = refresh()
    .then((entry) => {
      cache = entry;
      return entry;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// Returns the model's context limit in tokens, or null when unknown.
// Accepts either the canonical `providerID/modelID` key or a bare
// modelID. Errors during refresh are swallowed and return null —
// preflight refuses to fire on missing data, never blocks dispatch.
export async function getModelContextLimit(modelKey: string): Promise<number | null> {
  try {
    const entry = await ensureCache();
    const direct = entry.byKey.get(modelKey);
    if (direct !== undefined) return direct;
    // Try the bare-modelID fallback: caller passed `ollama/foo:cloud`
    // but we indexed `foo:cloud` only because the wire-shape's
    // providerID was empty. Strip the first `/` and re-look-up.
    const slash = modelKey.indexOf('/');
    if (slash > 0) {
      const bare = modelKey.slice(slash + 1);
      const fallback = entry.byKey.get(bare);
      if (fallback !== undefined) return fallback;
    }
    return null;
  } catch {
    return null;
  }
}

// Cheap text-token estimator. 4 chars/token is the canonical
// rule-of-thumb for English (GPT-3 era). We use 3.5 to be conservative
// — code, JSON, and structured content trend slightly higher than
// natural language. Returns the integer token count.
//
// Used by the F7 preflight; not a substitute for tokenizer-accurate
// counts. The 85% / 60% thresholds give comfortable headroom for the
// estimate's ~10-15% error.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

// Test hook — clears the cache so a unit test can stub /model and
// observe a fresh fetch. Not exported from any index.
export function _resetOpencodeModelsCache(): void {
  cache = null;
  inflight = null;
}
