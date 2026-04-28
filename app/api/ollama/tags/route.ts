// GET /api/ollama/tags — proxy to ollama's /api/tags endpoint.
//
// Returns the list of locally-pulled models (Ollama's ground truth)
// distinct from opencode's view (/api/swarm/providers). The new-run
// modal's ollama-help popover diffs the two to show:
//   - "you have it pulled, opencode doesn't know"  (most common)
//   - "opencode has it declared, you haven't pulled" (also common)
//   - "both ✓"                                       (good state)
//
// 30s in-memory TTL — same shape as the providers cache. ollama's
// model registry only changes when the user runs `ollama pull/rm`,
// so 30s is plenty fresh.

import 'server-only';
import { NextResponse } from 'next/server';
import { OLLAMA_URL } from '@/lib/config';

interface OllamaModel {
  name: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
}

interface TagsResponse {
  pulled: string[] | null;
  source: 'live' | 'unreachable';
  fetchedAt: number;
  ollamaUrl: string;
  error?: string;
}

const CACHE_KEY = Symbol.for('opencode_swarm.ollamaTagsCache.v1');
const CACHE_TTL_MS = 30_000;
interface CacheSlot {
  snapshot: TagsResponse;
  fetchedAt: number;
}
function getCache(): { slot: CacheSlot | undefined; set: (s: CacheSlot) => void } {
  const g = globalThis as { [CACHE_KEY]?: CacheSlot };
  return {
    slot: g[CACHE_KEY],
    set: (s) => {
      g[CACHE_KEY] = s;
    },
  };
}

async function fetchOllamaTags(): Promise<TagsResponse> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: ctl.signal });
    if (!res.ok) {
      return {
        pulled: null,
        source: 'unreachable',
        fetchedAt: Date.now(),
        ollamaUrl: OLLAMA_URL,
        error: `ollama /api/tags → HTTP ${res.status}`,
      };
    }
    const json = (await res.json()) as { models?: OllamaModel[] };
    const pulled = (json.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
      .sort();
    return {
      pulled,
      source: 'live',
      fetchedAt: Date.now(),
      ollamaUrl: OLLAMA_URL,
    };
  } catch (err) {
    return {
      pulled: null,
      source: 'unreachable',
      fetchedAt: Date.now(),
      ollamaUrl: OLLAMA_URL,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(): Promise<Response> {
  const cache = getCache();
  const now = Date.now();
  if (cache.slot && now - cache.slot.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json(cache.slot.snapshot, {
      headers: { 'cache-control': 'no-store' },
    });
  }
  const snapshot = await fetchOllamaTags();
  cache.set({ snapshot, fetchedAt: now });
  return NextResponse.json(snapshot, {
    headers: { 'cache-control': 'no-store' },
  });
}
