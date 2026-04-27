'use client';

// Plan-revisions read hook. Backs the orchestrator-worker `strategy` tab.
//
// HARDENING_PLAN.md#E4 — migrated 2026-04-26 from a 5s poll on
// /api/swarm/run/:id/strategy to SSE consumption via
// board-events-multiplexer. Cold-load still goes through one fetch so
// the rail renders immediately on mount; subsequent updates flow through
// `board.strategy.update` frames on the same SSE channel as the board.

import { useEffect, useState } from 'react';

import { subscribeBoardEvents } from './board-events-multiplexer';

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
  const [revisions, setRevisions] = useState<PlanRevisionWire[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Cold-load: fetch the historical revisions on mount so the rail renders
  // immediately. Subsequent updates land via SSE — no polling.
  useEffect(() => {
    if (!swarmRunID) {
      setRevisions([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchStrategy(swarmRunID)
      .then((data) => {
        if (cancelled) return;
        setRevisions(data.revisions);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [swarmRunID]);

  // Live updates via the board-events SSE channel.
  useEffect(() => {
    if (!swarmRunID) return;
    const unsubscribe = subscribeBoardEvents(
      swarmRunID,
      (frame) => {
        if (frame.type === 'board.strategy.update') {
          setRevisions((prior) => {
            // Append + dedup by id so an SSE replay of an already-seen
            // revision doesn't duplicate the row. Newest-last matches
            // the cold-load order (revisions table is ORDER BY round ASC).
            if (prior.some((r) => r.id === frame.revision.id)) return prior;
            return [...prior, frame.revision];
          });
        }
      },
      (err) => setError(err),
    );
    return unsubscribe;
  }, [swarmRunID]);

  return { revisions, loading, error };
}
