'use client';

// Client-side EventSource multiplexer for /board/events.
//
// HARDENING_PLAN.md#E4 — pre-fold, the run page opened three separate
// poll/stream connections per swarmRunID:
//   1. EventSource at /board/events (useLiveBoard)
//   2. 5s poll on /board/ticker (useLiveTicker)
//   3. 5s poll on /strategy (useStrategy)
//
// Post-fold the server emits ticker.tick + strategy.update on the same
// SSE bus. To make hooks share ONE EventSource per page (per the
// verification gate "Network panel shows 1 SSE connection"), this
// module owns the EventSource lifecycle and multiplexes frames to
// subscribers.
//
// Refcount semantics: opens an EventSource on first subscribe, closes
// it on the last unsubscribe. Multiple hooks for the same swarmRunID
// share the connection. A snapshot-cache lets late subscribers receive
// the most recent board.snapshot frame without waiting for the server
// to re-send.

import type { BoardItem } from './types';
import type { TickerState } from './live';
import type { PlanRevisionWire } from './strategy';

export interface BoardSnapshotFrame {
  type: 'board.snapshot';
  items: BoardItem[];
}
export interface BoardItemFrame {
  type: 'board.item.inserted' | 'board.item.updated';
  item: BoardItem;
}
export interface BoardTickerFrame {
  type: 'board.ticker.tick';
  snapshot: TickerState; // wire shape matches TickerState's 'active' / 'stopped' arms
}
export interface BoardStrategyFrame {
  type: 'board.strategy.update';
  revision: PlanRevisionWire;
}
export type BoardFrame =
  | BoardSnapshotFrame
  | BoardItemFrame
  | BoardTickerFrame
  | BoardStrategyFrame;

type FrameListener = (frame: BoardFrame) => void;
type ErrorListener = (error: string) => void;

interface ConnectionEntry {
  es: EventSource;
  listeners: Set<FrameListener>;
  errors: Set<ErrorListener>;
  /** Most recent board.snapshot — replayed on late-subscribe. */
  lastSnapshot: BoardSnapshotFrame | null;
  /** Most recent ticker.tick — replayed on late-subscribe. */
  lastTicker: BoardTickerFrame | null;
}

const connections = new Map<string, ConnectionEntry>();

function ensureConnection(swarmRunID: string): ConnectionEntry {
  const existing = connections.get(swarmRunID);
  if (existing) return existing;

  const es = new EventSource(`/api/swarm/run/${swarmRunID}/board/events`);
  const entry: ConnectionEntry = {
    es,
    listeners: new Set(),
    errors: new Set(),
    lastSnapshot: null,
    lastTicker: null,
  };
  connections.set(swarmRunID, entry);

  es.onmessage = (ev) => {
    let frame: BoardFrame;
    try {
      frame = JSON.parse(ev.data) as BoardFrame;
    } catch {
      return;
    }
    // Cache snapshot + ticker frames so late subscribers (e.g., the
    // strategy rail mounting after the board) get the current state
    // without waiting for the server to re-send.
    if (frame.type === 'board.snapshot') {
      entry.lastSnapshot = frame;
    } else if (frame.type === 'board.ticker.tick') {
      entry.lastTicker = frame;
    }
    for (const listener of [...entry.listeners]) {
      try {
        listener(frame);
      } catch (err) {
        // Listener errors shouldn't propagate to other listeners.
        console.warn('[board-events] listener threw:', err);
      }
    }
  };

  es.onerror = () => {
    // EventSource auto-reconnects; surface the error so consumers can
    // hint at a dropped stream, but don't tear down — the last snapshot
    // is still our best view.
    for (const onError of [...entry.errors]) {
      try {
        onError('board stream disconnected');
      } catch (err) {
        console.warn('[board-events] error-listener threw:', err);
      }
    }
  };

  return entry;
}

/**
 * Subscribe to board-events frames for a swarmRunID. The handler receives
 * every frame the SSE stream emits (board.snapshot / item / ticker /
 * strategy). Late subscribers immediately receive the cached snapshot +
 * ticker frames if any have arrived, so they don't have to wait for a
 * fresh server emit.
 *
 * Returns an unsubscribe function. The underlying EventSource closes
 * automatically when the last subscriber for the swarmRunID unsubscribes.
 */
export function subscribeBoardEvents(
  swarmRunID: string,
  onFrame: FrameListener,
  onError?: ErrorListener,
): () => void {
  const entry = ensureConnection(swarmRunID);
  entry.listeners.add(onFrame);
  if (onError) entry.errors.add(onError);

  // Replay cached frames so late-subscribers don't have to wait for a
  // fresh server emit. Run in a microtask so the caller can finish
  // wiring up state before frames land.
  queueMicrotask(() => {
    if (!entry.listeners.has(onFrame)) return; // unsubscribed before microtask fired
    if (entry.lastSnapshot) {
      try {
        onFrame(entry.lastSnapshot);
      } catch (err) {
        console.warn('[board-events] cached-snapshot replay threw:', err);
      }
    }
    if (entry.lastTicker) {
      try {
        onFrame(entry.lastTicker);
      } catch (err) {
        console.warn('[board-events] cached-ticker replay threw:', err);
      }
    }
  });

  return () => {
    entry.listeners.delete(onFrame);
    if (onError) entry.errors.delete(onError);
    if (entry.listeners.size === 0 && entry.errors.size === 0) {
      entry.es.close();
      connections.delete(swarmRunID);
    }
  };
}
