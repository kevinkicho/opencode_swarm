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
    | 'replan-loop-exhausted'
    | 'operator-hard-stop';
  consecutiveIdle: number;
  idleThreshold: number;
  lastOutcome?:
    | { status: 'picked'; sessionID: string; itemID: string; editedPaths: string[] }
    | { status: 'stale'; sessionID: string; itemID: string; reason: string }
    | { status: 'skipped'; reason: string };
  lastRanAtMs?: number;
  startedAtMs: number;
  // #7.Q21 — running count of successful 'picked' outcomes (todos
  // committed to done). Monotonic; persists post-stop. Compared
  // server-side to bounds.commitsCap. UI can show "N commits" in the
  // ticker chip / picker / retro.
  totalCommits: number;
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

// Frame types live in board-events-multiplexer.ts now — see that module
// for the full union including ticker.tick + strategy.update folded into
// the same SSE channel.
import { subscribeBoardEvents } from './board-events-multiplexer';

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

    // Subscribe via the multiplexer so this hook shares ONE EventSource
    // with useLiveTicker / useStrategy on the same swarmRunID
    //. Ticker/strategy frames pass through
    // ignored — those hooks own their own derivation.
    const unsubscribe = subscribeBoardEvents(
      swarmRunID,
      (frame) => {
        if (frame.type === 'board.snapshot') {
          byId.clear();
          for (const it of frame.items) byId.set(it.id, it);
          setItems(sortBoardItems([...byId.values()]));
          setError(null);
        } else if (
          frame.type === 'board.item.inserted' ||
          frame.type === 'board.item.updated'
        ) {
          byId.set(frame.item.id, frame.item);
          setItems(sortBoardItems([...byId.values()]));
          setError(null);
        }
        // ticker.tick and strategy.update pass through silently here —
        // the multiplexer fans them out to other subscribers.
      },
      (err) => setError(err),
    );

    return unsubscribe;
  }, [swarmRunID]);

  return { items, error };
}

// Synthesize a BoardAgent from the board's ownerAgentId strings. The live
// store doesn't carry agent metadata (names, glyphs, accents) — those are UI
// sugar — so we derive a deterministic identity per unique owner id. Hashing
// the id for accent keeps the same agent the same color across polls and
// reloads. Falls back gracefully for non-`ag_*` shapes.
const DERIVED_ACCENTS: BoardAgent['accent'][] = ['molten', 'mint', 'iris', 'amber', 'fog'];

// Ticker observability + control. SSE-driven as of 
// (2026-04-26): ticker.tick frames flow through the same /board/events
// EventSource as board mutations and strategy revisions, multiplexed
// client-side so the run page opens ONE connection per swarmRunID. The
// 5s poll the prior implementation kept open is gone.
//
// Cold-start behavior: the SSE channel only emits on transitions, so
// the first subscriber needs an initial state. Two paths:
//   1. The multiplexer caches the most recent ticker.tick frame and
//      replays it to late subscribers — covers the case where the
//      ticker was already running before this hook mounted.
//   2. If no tick has fired yet (run created but ticker hasn't ticked
//      once), useLiveTicker returns { state: 'none' } as before.
//
// Start/stop control still goes through the existing
// /api/swarm/run/:id/board/ticker POST — unchanged from the polling
// implementation. The mutation's onSuccess updates local state
// immediately so the user sees instant feedback before the SSE
// confirms.

export interface LiveTicker {
  state: TickerState;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  busy: boolean;
}

// Convert a TickerSnapshot frame from the wire into a TickerState
// discriminated union. The server emits the snapshot fields flat; the
// client UI wants the `state: 'active' | 'stopped'` arm to drive
// rendering. Matches the prior fetchTicker shape so callers don't churn.
function tickerStateFromSnapshot(snap: TickerSnapshot): TickerState {
  return snap.stopped
    ? { state: 'stopped', ...snap }
    : { state: 'active', ...snap };
}

export function useLiveTicker(swarmRunID: string | null): LiveTicker {
  const [state, setState] = useState<TickerState>({ state: 'none' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!swarmRunID) {
      setState({ state: 'none' });
      setError(null);
      return;
    }
    const unsubscribe = subscribeBoardEvents(
      swarmRunID,
      (frame) => {
        if (frame.type === 'board.ticker.tick') {
          // The wire shape is the TickerSnapshot the server emits; coerce
          // through `unknown` because the multiplexer's TickerState type
          // hint loses the discriminator until tickerStateFromSnapshot
          // re-derives it.
          setState(tickerStateFromSnapshot(frame.snapshot as unknown as TickerSnapshot));
          setError(null);
        }
      },
      (err) => setError(err),
    );
    return unsubscribe;
  }, [swarmRunID]);

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
      // Optimistic local update so the UI reflects the action without
      // waiting for the next SSE tick. The server will emit a fresh
      // snapshot on the next tick that confirms (or corrects) this.
      setState(data);
    },
  });

  const errorObj = mutation.error
    ? (mutation.error instanceof Error
        ? mutation.error.message
        : String(mutation.error))
    : error;

  return {
    state: swarmRunID ? state : { state: 'none' },
    error: errorObj,
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
 // hierarchical patterns (orchestrator-worker,,
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
