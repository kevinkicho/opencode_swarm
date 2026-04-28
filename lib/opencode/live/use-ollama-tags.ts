'use client';

// Client hook for /api/ollama/tags — locally-pulled ollama models.
// Used by the new-run modal's ollama help popover to surface the gap
// between what the user has pulled vs what opencode declares.

import { useQuery } from '@tanstack/react-query';

export interface OllamaTagsSnapshot {
  // null when ollama is unreachable; an empty array means reachable
  // but nothing pulled yet.
  pulled: string[] | null;
  source: 'live' | 'unreachable';
  fetchedAt: number;
  ollamaUrl: string;
  error?: string;
}

const QUERY_KEY = ['ollama', 'tags'] as const;

async function fetchTags(): Promise<OllamaTagsSnapshot> {
  const res = await fetch('/api/ollama/tags', { cache: 'no-store' });
  if (!res.ok) {
    return {
      pulled: null,
      source: 'unreachable',
      fetchedAt: Date.now(),
      ollamaUrl: 'unknown',
      error: `proxy → HTTP ${res.status}`,
    };
  }
  return (await res.json()) as OllamaTagsSnapshot;
}

export function useOllamaTags(opts: { enabled?: boolean } = {}) {
  const enabled = opts.enabled ?? true;
  const q = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchTags,
    enabled,
    // 30s staleTime mirrors the server-side cache TTL so we don't
    // hammer the proxy when the modal is repeatedly opened.
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
    placeholderData: (prev) => prev,
  });
  return {
    snapshot: q.data ?? null,
    pulled: q.data?.pulled ?? null,
    reachable: q.data?.source === 'live',
    error: q.data?.error ?? (q.error ? (q.error as Error).message : null),
    isLoading: q.isPending,
  };
}
