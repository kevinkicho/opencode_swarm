'use client';

//
// Live provider/model catalog hook. Wraps GET /api/swarm/providers (which
// in turn calls opencode's /config/providers) with TanStack Query so the
// new-run modal + inspector model picker share one cache entry.
//
// Why TanStack: the modal mounts on every "new run" click and the picker
// rerenders any time agent state changes. Without dedup we'd refetch on
// every mount; refetchInterval is unnecessary because the upstream changes
// only on opencode restart (provider blocks are config). 30s staleTime
// matches the route's TTL — within that window every consumer hits the
// cache, after it the query revalidates lazily on next mount/focus.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { ProviderInfo, ProviderModel, ProviderSnapshot } from '@/app/api/swarm/providers/route';
import type { Provider } from '@/lib/swarm-types';

export const OPENCODE_PROVIDERS_QUERY_KEY = ['opencode', 'providers'] as const;

async function fetchProviders(): Promise<ProviderSnapshot> {
  const res = await fetch('/api/swarm/providers', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`providers fetch -> HTTP ${res.status}`);
  }
  return (await res.json()) as ProviderSnapshot;
}

export interface UseOpencodeProvidersResult {
  /** Status echoed from server. `'fallback'` ⇒ opencode was unreachable. */
  source: 'live' | 'fallback' | 'loading';
  providers: ProviderInfo[];
  /** Flat list across every provider, in declaration order. */
  models: ProviderModel[];
  /** Indexed by canonical id for O(1) lookups from message metadata. */
  byId: Map<string, ProviderModel>;
  /** Group by Provider tier (zen/go/ollama/byok) for the inspector picker. */
  byTier: (tier: Provider) => ProviderModel[];
  /** Upstream defaults (e.g. opencode's `default.build`). */
  defaults?: Record<string, string>;
  error?: string;
  isLoading: boolean;
  refetch: () => void;
}

const EMPTY_LOADING: ProviderSnapshot = {
  source: 'live',
  fetchedAt: 0,
  providers: [],
};

export function useOpencodeProviders(): UseOpencodeProvidersResult {
  const q = useQuery({
    queryKey: OPENCODE_PROVIDERS_QUERY_KEY,
    queryFn: fetchProviders,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: false,
    placeholderData: (prev) => prev,
  });

  const snapshot = q.data ?? EMPTY_LOADING;

  const { models, byId } = useMemo(() => {
    const flat: ProviderModel[] = [];
    const map = new Map<string, ProviderModel>();
    for (const p of snapshot.providers) {
      for (const m of p.models) {
        flat.push(m);
        map.set(m.id, m);
      }
    }
    return { models: flat, byId: map };
  }, [snapshot]);

  const byTier = useMemo(() => {
    const cache = new Map<Provider, ProviderModel[]>();
    return (tier: Provider): ProviderModel[] => {
      const hit = cache.get(tier);
      if (hit) return hit;
      const rows = models.filter((m) => m.provider === tier);
      cache.set(tier, rows);
      return rows;
    };
  }, [models]);

  return {
    source: q.isPending ? 'loading' : snapshot.source,
    providers: snapshot.providers,
    models,
    byId,
    byTier,
    defaults: snapshot.defaults,
    error: snapshot.error,
    isLoading: q.isPending,
    refetch: () => q.refetch(),
  };
}
