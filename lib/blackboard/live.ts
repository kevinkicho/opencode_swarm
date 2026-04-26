'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardAgent, BoardItem } from './types';

// Mirror of TickerSnapshot from lib/server/blackboard/auto-ticker.ts —
// kept as a client-side duplicate so this module doesn't pull server-only
// imports into the browser bundle. Keep in sync when new fields land
// on the server snapshot; out-of-sync means TS lets stale shapes through.
export interface TickerSnapshot {
  swarmRunID: string;
  intervalMs: number;
  inFlight: boolean;
  stopped: boolean;
  stoppedAtMs?: number;
  stopReason?:
    | 'auto-idle'
    | 'manual'
    | 'opencode-frozen'
    | 'zen-rate-limit'
    | 'wall-clock-cap'
    | 'commits-cap'
    | 'todos-cap'
    | 'replan-loop-exhausted';
  consecutiveIdle: number;
  idleThreshold: number;
  lastOutcome?:
    | { status: 'picked'; sessionID: string; itemID: string; editedPaths: string[] }
    | { status: 'stale'; sessionID: string; itemID: string; reason: string }
    | { status: 'skipped'; reason: string };
  lastRanAtMs?: number;
  startedAtMs: number;
  // Ambition-ratchet state (server side: SWARM_PATTERNS.md "Tiered
  // execution"). currentTier 1-indexed; tierExhausted means MAX_TIER was
  // attempted and returned zero — next cascade will stop the ticker.
  currentTier: number;
  tierExhausted: boolean;
  maxTier: number;
  // Epoch-ms when a Zen retry-after window ends. Present only on
  // stopReason='zen-rate-limit' runs whose 429 carried a parseable
  // retry-after. UI renders a live countdown chip from this.
  retryAfterEndsAtMs?: number;
}

// Kept as three distinct arms (rather than a combined `active | stopped`)
// so Extract<TickerState, { state: 'active' }> resolves cleanly for helpers
// that only care about one arm — see components/board-rail.tsx TickerChip.
export type TickerState =
  | { state: 'none' }
  | ({ state: 'active' } & TickerSnapshot)
  | ({ state: 'stopped' } & TickerSnapshot);

// Shared hook for the blackboard `/board` stream. Lives in
// `lib/blackboard/` so both the full board page (`/board-preview`) and the
// inline board rail in the run view (`components/board-rail.tsx`) go through
// one code path. Uses SSE at `/board/events` — a handshake `board.snapshot`
// carries the initial item list, subsequent `board.item.inserted` /
// `board.item.updated` frames upsert by id. EventSource reconnects on its
// own if the connection drops; the next snapshot frame on reconnect re-
// bases the item map, so we don't need client-side resync logic.
//
// Shape note: both insert and update collapse to the same upsert — the
// client just keeps one item per id. The server emits distinct types so
// future instrumentation (e.g. "N claims / minute") can disambiguate
// without an extra round-trip.

export interface LiveBoard {
  items: BoardItem[] | null;
  error: string | null;
}

interface BoardSnapshotFrame {
  type: 'board.snapshot';
  items: BoardItem[];
}
interface BoardItemFrame {
  type: 'board.item.inserted' | 'board.item.updated';
  item: BoardItem;
}
type BoardFrame = BoardSnapshotFrame | BoardItemFrame;

// listBoardItems on the server orders by (created_ms DESC, id ASC). Mirror
// that here so incremental upserts don't drift from the shape a fresh GET
// would produce.
function sortBoardItems(items: BoardItem[]): BoardItem[] {
  return [...items].sort((a, b) => {
    if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function useLiveBoard(swarmRunID: string | null): LiveBoard {
  const [items, setItems] = useState<BoardItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!swarmRunID) {
      setItems(null);
      setError(null);
      return;
    }

    // Map kept in a ref-like closure variable so repeated upserts in quick
    // succession aren't serialized through React state — we recompute the
    // array once per frame and hand it to setItems.
    const byId = new Map<string, BoardItem>();

    const es = new EventSource(`/api/swarm/run/${swarmRunID}/board/events`);

    es.onmessage = (ev) => {
      let frame: BoardFrame;
      try {
        frame = JSON.parse(ev.data) as BoardFrame;
      } catch {
        return;
      }
      if (frame.type === 'board.snapshot') {
        byId.clear();
        for (const it of frame.items) byId.set(it.id, it);
      } else {
        byId.set(frame.item.id, frame.item);
      }
      setItems(sortBoardItems([...byId.values()]));
      setError(null);
    };

    es.onerror = () => {
      // EventSource auto-reconnects; surface the error so the UI can hint
      // at a dropped stream, but don't clear items — the last snapshot is
      // still the best view we have.
      setError('board stream disconnected');
    };

    return () => {
      es.close();
    };
  }, [swarmRunID]);

  return { items, error };
}

// Synthesize a BoardAgent from the board's ownerAgentId strings. The live
// store doesn't carry agent metadata (names, glyphs, accents) — those are UI
// sugar — so we derive a deterministic identity per unique owner id. Hashing
// the id for accent keeps the same agent the same color across polls and
// reloads. Falls back gracefully for non-`ag_*` shapes.
const DERIVED_ACCENTS: BoardAgent['accent'][] = ['molten', 'mint', 'iris', 'amber', 'fog'];

// Ticker observability + control. Polls at a slower cadence than the
// board itself (5s vs 2s) because ticker state changes on the tick
// boundary (10s default) — no value in outrunning that.
//
// Migrated to TanStack Query (#109) — multiple consumers (topbar,
// strategy rail, ticker chip) share one cache entry instead of each
// running its own poller.
const TICKER_POLL_MS = 5000;

export interface LiveTicker {
  state: TickerState;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  busy: boolean;
}

const tickerQueryKey = (swarmRunID: string) =>
  ['swarm', 'ticker', swarmRunID] as const;

async function fetchTicker(swarmRunID: string): Promise<TickerState> {
  const r = await fetch(`/api/swarm/run/${swarmRunID}/board/ticker`, {
    cache: 'no-store',
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
  }
  return data as TickerState;
}

export function useLiveTicker(swarmRunID: string | null): LiveTicker {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: swarmRunID ? tickerQueryKey(swarmRunID) : ['swarm', 'ticker', '__none__'],
    queryFn: () => fetchTicker(swarmRunID!),
    enabled: !!swarmRunID,
    refetchInterval: TICKER_POLL_MS,
    placeholderData: (prev) => prev,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: async (action: 'start' | 'stop') => {
      if (!swarmRunID) throw new Error('no swarmRunID');
      const r = await fetch(`/api/swarm/run/${swarmRunID}/board/ticker`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await r.json();
      if (!r.ok) {
        throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
      }
      return data as TickerState;
    },
    onSuccess: (data) => {
      if (swarmRunID) {
        queryClient.setQueryData(tickerQueryKey(swarmRunID), data);
      }
    },
  });

  const state: TickerState = q.data ?? { state: 'none' };
  const errorObj = mutation.error ?? q.error;
  const error = errorObj instanceof Error ? errorObj.message : null;

  return {
    state: swarmRunID ? state : { state: 'none' },
    error,
    start: async () => {
      await mutation.mutateAsync('start').catch(() => undefined);
    },
    stop: async () => {
      await mutation.mutateAsync('stop').catch(() => undefined);
    },
    busy: mutation.isPending,
  };
}

export function deriveBoardAgents(
  items: BoardItem[],
  // Optional mapping from ownerAgentId → role name. When provided, agents
  // with a matching owner ID use the role name (truncated for chip fit)
  // instead of the default numeric label. Builds role visibility on
  // hierarchical patterns (orchestrator-worker, role-differentiated,
  // debate-judge, critic-loop) without changing the fallback behavior
  // for self-organizing runs.
  roleNames?: ReadonlyMap<string, string>,
): BoardAgent[] {
  // Collect unique owner IDs from items, then sort lexicographically so the
  // numeric mapping is deterministic across polls and page reloads (arrival
  // order of items can shift; sorted IDs don't). Session IDs all start with
  // `ses_` so the old `shortName = bare.split('_')[0]` derivation was
  // producing "ses" for every agent — every board chip looked identical.
  // Numeric labels (1..N) give each session a distinct one-character badge;
  // a role-name override (when provided) wins when present.
  const unique = new Set<string>();
  for (const it of items) if (it.ownerAgentId) unique.add(it.ownerAgentId);
  const sortedIds = [...unique].sort();

  const out: BoardAgent[] = [];
  sortedIds.forEach((id, i) => {
    const num = String(i + 1);
    const role = roleNames?.get(id);
    // Chip-fit: role badges can grow long ("architect" → fine at 9px,
    // "generator-2" → fine, but 20-char custom roles would spill). Cap
    // the display at 12 chars via truncation; full role still on the
    // tooltip via the id → full meta chain.
    const name = role ? (role.length > 12 ? role.slice(0, 11) + '…' : role) : num;
    const glyph = role ? role.charAt(0).toUpperCase() : num;
    let h = 0;
    for (let j = 0; j < id.length; j += 1) h = (h * 31 + id.charCodeAt(j)) | 0;
    out.push({
      id,
      name,
      accent: DERIVED_ACCENTS[Math.abs(h) % DERIVED_ACCENTS.length],
      glyph,
    });
  });
  return out;
}

// Re-exported from lib/blackboard/roles.ts so existing callers that
// import from live.ts don't need to update their import paths. The
// shared helper lives in roles.ts because it's both client- and
// server-needed — this file carries 'use client'.
export { roleNamesFromMeta } from './roles';
