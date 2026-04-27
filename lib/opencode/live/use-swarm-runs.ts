'use client';

//
// Run-list + run-snapshot + run-events hooks. Three closely-related
// hooks that all hit `/api/swarm/run/...` endpoints (not opencode):
//
//   - useSwarmRunEvents     — SSE stream of run-level events (replay + live)
//   - useSwarmRuns          — polling list of every persisted run
//   - useSwarmRunSnapshot   — single aggregator-endpoint cold-load fetch

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type {
  SwarmRunEvent,
  SwarmRunListRow,
  SwarmRunMeta,
} from '../../swarm-run-types';

// ─── useSwarmRunEvents ────────────────────────────────────────────────────
// Stream of run-level events. Consumes GET /api/swarm/run/:id/events and
// accumulates both the L0 replay (replayed SwarmRunEvents tagged replay:true)
// and the live feed. The control frames `swarm.run.attached`,
// `swarm.run.replay.start`, `swarm.run.replay.end`, `swarm.run.error` drive
// the `phase` state machine but are not surfaced as events themselves.
//
// Use this instead of useLiveSession when you need a cross-session view of
// a run — e.g. the run-provenance drawer. For a single-session drill-down,
// useLiveSession is still cheaper (it hydrates message history from
// /session/{id}/message instead of replaying every tagged event).

export type SwarmRunPhase =
  | 'idle'         // no swarmRunID or not yet connected
  | 'attached'     // handshake received, replay not yet started
  | 'replaying'    // streaming historical events from L0
  | 'live'         // replay complete, receiving live opencode events
  | 'error';       // upstream threw; `events` still holds what we got

export interface SwarmRunEventRow extends SwarmRunEvent {
  // Present on rows emitted during the replay phase. Absent on live rows.
  replay?: boolean;
}

export interface SwarmRunEventsSnapshot {
  events: SwarmRunEventRow[];
  phase: SwarmRunPhase;
  replayCount: number;   // what the server reported at replay.end
  error: string | null;
}

export function useSwarmRunEvents(
  swarmRunID: string | null
): SwarmRunEventsSnapshot {
  const [events, setEvents] = useState<SwarmRunEventRow[]>([]);
  const [phase, setPhase] = useState<SwarmRunPhase>('idle');
  const [replayCount, setReplayCount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!swarmRunID) {
      setEvents([]);
      setPhase('idle');
      setReplayCount(0);
      setError(null);
      return;
    }

    setEvents([]);
    setPhase('attached');
    setReplayCount(0);
    setError(null);

    const es = new EventSource(
      `/api/swarm/run/${encodeURIComponent(swarmRunID)}/events`
    );
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as {
          type?: string;
          properties?: unknown;
          replay?: boolean;
          ts?: number;
          sessionID?: string;
          swarmRunID?: string;
        };

        // Control frames drive the phase machine.
        if (parsed.type === 'swarm.run.attached') {
          setPhase('replaying');
          return;
        }
        if (parsed.type === 'swarm.run.replay.start') {
          setPhase('replaying');
          return;
        }
        if (parsed.type === 'swarm.run.replay.end') {
          const count = Number(
            (parsed.properties as { count?: number } | undefined)?.count ?? 0
          );
          setReplayCount(count);
          setPhase('live');
          return;
        }
        if (parsed.type === 'swarm.run.error') {
          const msg =
            (parsed.properties as { message?: string } | undefined)?.message ??
            'stream error';
          setError(msg);
          setPhase('error');
          return;
        }

        // Everything else is a tagged SwarmRunEvent (has ts + sessionID +
        // swarmRunID). Keep replay rows and live rows in the same array,
        // ordered by arrival — the server guarantees replay order first.
        if (
          typeof parsed.ts === 'number' &&
          typeof parsed.sessionID === 'string' &&
          typeof parsed.swarmRunID === 'string'
        ) {
          const row = parsed as SwarmRunEventRow;
          setEvents((prev) => [...prev, row]);
        }
      } catch {
        // Ignore malformed frames — the server shouldn't emit these but a
        // proxy / buffering edge case could split a JSON payload.
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects on transport errors; we only surface
      // the state change. If the server returned 404 the connection closes
      // permanently — phase stays 'error' and the caller (useLiveSwarmRun)
      // will also have seen the 404 on its meta lookup.
      setPhase((prev) => (prev === 'live' ? 'live' : 'error'));
    };

    return () => {
      es.close();
    };
  }, [swarmRunID]);

  return { events, phase, replayCount, error };
}

// ─── useSwarmRuns ─────────────────────────────────────────────────────────
// Polling list of every persisted swarm run. Drives the status-rail runs
// picker. Shape mirrors useLiveSessions so the picker component can be
// structured the same way — a wide dense-row popover with filter + sort.
//
// Why poll vs subscribe: registry writes are rare (once per run create) and
// the existing SSE machinery is scoped to one run, not the whole ledger. A
// short poll keeps the picker fresh without plumbing a global event stream.

export interface SwarmRunsSnapshot {
  // Rows carry the persisted meta plus a live-derived status. Consumers
  // that only care about meta can read `row.meta`; consumers that want to
  // color-code by status read `row.status`.
  rows: SwarmRunListRow[];
  error: string | null;
  loading: boolean;
  lastUpdated: number | null;
}

// useSwarmRuns — lists every swarm run (live + finished + stale). Migrated
// to TanStack Query (2026-04-24 pilot per docs/POSTMORTEMS/ and the cold-
// load audit). Benefits over the previous useEffect+setInterval shape:
//
//   - Dedup: multiple callers mounting the hook share one in-flight fetch
//     and one cached result. Before, each mount = its own poll loop.
//   - Cache persistence: data survives component unmounts and is instantly
//     available to the next mount (subject to staleTime).
//   - Visibility / reconnect integration: refetchOnWindowFocus and
//     refetchOnReconnect come for free from the QueryProvider defaults.
//   - Devtools: full history of every query's state under the inline
//     devtools panel in dev builds.
//
// Legacy signature (just an interval number) still works for backward
// compat with older call sites. Options form accepts `enabled` to gate
// the fetch by UI state (picker open, etc.).
export function useSwarmRuns(
  arg: number | { intervalMs?: number; enabled?: boolean } = {},
): SwarmRunsSnapshot {
  const { intervalMs, enabled } =
    typeof arg === 'number'
      ? { intervalMs: arg, enabled: true }
      : { intervalMs: arg.intervalMs ?? 4000, enabled: arg.enabled ?? true };

  const q = useQuery({
    queryKey: SWARM_RUNS_QUERY_KEY,
    queryFn: swarmRunsFetcher,
    enabled,
    // refetchInterval runs only while the query is `enabled`; staleness
    // bookkeeping still applies when disabled so returning to an enabled
    // mount uses the cached snapshot without an extra flight.
    refetchInterval: enabled ? intervalMs : false,
    // When disabled, useQuery returns whatever's in cache; we don't want
    // the first disabled read to go through a loading state.
    placeholderData: (prev) => prev,
  });

  return {
    rows: q.data ?? [],
    error: q.error ? (q.error as Error).message : null,
    loading: q.isLoading,
    lastUpdated: q.dataUpdatedAt || null,
  };
}

// Shared key + fetcher so other modules can `queryClient.invalidateQueries`
// or `prefetchQuery` this endpoint without re-deriving the key shape.
export const SWARM_RUNS_QUERY_KEY = ['swarm', 'runs', 'list'] as const;

async function swarmRunsFetcher(): Promise<SwarmRunListRow[]> {
  const res = await fetch('/api/swarm/run', { cache: 'no-store' });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `swarm run list -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  const body = (await res.json()) as { runs?: SwarmRunListRow[] };
  return body.runs ?? [];
}

// ─── useSwarmRunSnapshot ──────────────────────────────────────────────────
// that replaces the cold-load fan-out (useLiveSwarmRun + useLiveTicker
// initial + useLiveBoard initial + derivedRow lookup against
// useSwarmRuns). Backend endpoint at /api/swarm/run/:id/snapshot was
// measured at 4.5x cold-load speedup vs the 5-call fan-out (commit
// c85724a). Live updates continue to flow through the existing SSE
// channels — this hook only owns the cold-load seed.
//
// Shape mirrors the snapshot endpoint's response. Consumers can either
// use this directly or pass the snapshot's sub-fields as initialData to
// the existing live hooks (useLiveBoard / useLiveTicker) so SSE picks
// up from a warm baseline.

export interface SwarmRunSnapshot {
  meta: SwarmRunMeta;
  status: import('../../swarm-run-types').SwarmRunStatus;
  derivedRow: {
    status: import('../../swarm-run-types').SwarmRunStatus;
    lastActivityTs: number | null;
    costTotal: number;
    tokensTotal: number;
  };
  tokens: {
    totals: {
      tokens: number;
      cost: number;
      lastActivityTs: number | null;
      status: import('../../swarm-run-types').SwarmRunStatus;
    };
    sessions: Array<unknown>;
  };
  board: { items: Array<unknown> };
  ticker: { state: 'none' } | (import('../../blackboard/live').TickerSnapshot);
  planRevisions: { count: number };
}

export interface SwarmRunSnapshotResult {
  snapshot: SwarmRunSnapshot | null;
  error: string | null;
  loading: boolean;
  notFound: boolean;
  lastUpdated: number | null;
}

export const SWARM_RUN_SNAPSHOT_QUERY_KEY = (swarmRunID: string) =>
  ['swarm', 'run', 'snapshot', swarmRunID] as const;

async function swarmRunSnapshotFetcher(
  swarmRunID: string,
): Promise<SwarmRunSnapshot | null> {
  const res = await fetch(
    `/api/swarm/run/${encodeURIComponent(swarmRunID)}/snapshot`,
    { cache: 'no-store' },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `swarm run snapshot -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  return (await res.json()) as SwarmRunSnapshot;
}

export function useSwarmRunSnapshot(
  swarmRunID: string | null,
): SwarmRunSnapshotResult {
  const q = useQuery({
    queryKey: SWARM_RUN_SNAPSHOT_QUERY_KEY(swarmRunID ?? ''),
    queryFn: () => swarmRunSnapshotFetcher(swarmRunID!),
    enabled: !!swarmRunID,
    // Snapshot is the cold-load seed; SSE keeps the page fresh after.
    // 30s staleTime is generous — the live channels do the heavy lifting.
    staleTime: 30_000,
  });

  return {
    snapshot: q.data ?? null,
    error: q.error ? (q.error as Error).message : null,
    loading: q.isLoading,
    notFound: q.data === null && !q.isLoading && !q.isError,
    lastUpdated: q.dataUpdatedAt || null,
  };
}
