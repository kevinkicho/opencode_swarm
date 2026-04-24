'use client';

// Plan-revisions read hook. Backs the orchestrator-worker `strategy`
// tab. TanStack Query for transparent dedup if multiple subviews ever
// need the data; refetch interval matches the board's 2s cadence so
// fresh sweeps surface within ~2s.

import { useQuery } from '@tanstack/react-query';

export interface PlanRevisionWire {
  id: number;
  swarmRunID: string;
  round: number;
  added: string[];
  removed: string[];
  rephrased: Array<{ before: string; after: string }>;
  addedCount: number;
  removedCount: number;
  rephrasedCount: number;
  boardSnapshot: {
    total: number;
    open: number;
    claimed: number;
    inProgress: number;
    done: number;
    stale: number;
    blocked: number;
  };
  excerpt: string | null;
  planMessageId: string | null;
  createdAt: number;
}

interface StrategyResponse {
  revisions: PlanRevisionWire[];
}

async function fetchStrategy(swarmRunID: string): Promise<StrategyResponse> {
  const res = await fetch(`/api/swarm/run/${swarmRunID}/strategy`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`strategy fetch failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as StrategyResponse;
}

export function useStrategy(swarmRunID: string | null): {
  revisions: PlanRevisionWire[];
  loading: boolean;
  error: string | null;
} {
  const q = useQuery({
    queryKey: ['swarm', 'strategy', swarmRunID],
    queryFn: () => fetchStrategy(swarmRunID!),
    enabled: swarmRunID !== null,
    refetchInterval: 5000,
    placeholderData: (prev) => prev,
    retry: false,
  });
  return {
    revisions: q.data?.revisions ?? [],
    loading: q.isLoading,
    error: q.error ? (q.error as Error).message : null,
  };
}
