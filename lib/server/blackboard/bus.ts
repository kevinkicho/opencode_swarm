// Process-local event bus for per-run state mutations. The SSE endpoint
// at `/api/swarm/run/:id/board/events` subscribes here; emit sites in
// the store, auto-ticker, and plan-revisions push events through.
//
// Three event families share one bus:
//   - item.{inserted,updated} — board mutations (store.ts)
//   - ticker.tick             — auto-ticker fanout settled (auto-ticker)
//   - strategy.update         — new plan-revision row (plan-revisions.ts)
//
// 2026-04-26 so the run page only opens ONE EventSource per swarmRunID
// instead of polling /board/ticker (5s) and /strategy (5s) on top of
// the SSE board stream.
//
// Keeping the bus in-process is fine because the blackboard DB is
// already singleton-scoped by file path (see `./db.ts`) — any code
// that mutates the board / ticker / plan-revisions runs inside the
// same Node process that serves the SSE stream.
//
// HMR safety: pin the subscriber map on `globalThis` so route reloads
// don't orphan open streams. Matches the pattern used by `auto-ticker.ts`.

import 'server-only';

import type { BoardItem } from '@/lib/blackboard/types';
import type { PlanRevisionWire } from '@/lib/blackboard/strategy';
import type { TickerSnapshot } from './auto-ticker/types';

export type BoardEvent =
  | { type: 'item.inserted'; item: BoardItem }
  | { type: 'item.updated'; item: BoardItem }
  | { type: 'ticker.tick'; snapshot: TickerSnapshot }
  | { type: 'strategy.update'; revision: PlanRevisionWire };

type Listener = (event: BoardEvent) => void;

interface BusState {
  // swarmRunID -> set of listeners
  subscribers: Map<string, Set<Listener>>;
}

const BUS_KEY = Symbol.for('opencode_swarm.blackboard.bus.v1');

function bus(): BusState {
  const slot = (globalThis as { [BUS_KEY]?: BusState })[BUS_KEY];
  if (slot && slot.subscribers instanceof Map) return slot;
  const next: BusState = { subscribers: new Map() };
  (globalThis as { [BUS_KEY]?: BusState })[BUS_KEY] = next;
  return next;
}

export function emitBoardEvent(swarmRunID: string, event: BoardEvent): void {
  const listeners = bus().subscribers.get(swarmRunID);
  if (!listeners || listeners.size === 0) return;
  // Snapshot before firing so a listener unsubscribing itself during dispatch
  // doesn't mutate the set we're iterating over.
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      // Swallow listener errors — one broken SSE stream shouldn't stall
      // the coordinator write path. The listener itself is responsible
      // for closing its own stream on failure.
      console.warn('[blackboard/bus] listener threw:', (err as Error).message);
    }
  }
}

/** Convenience emitter for ticker-state changes. No-op when no subscribers. */
export function emitTickerTick(swarmRunID: string, snapshot: TickerSnapshot): void {
  emitBoardEvent(swarmRunID, { type: 'ticker.tick', snapshot });
}

/** Convenience emitter for plan-revision writes. No-op when no subscribers. */
export function emitStrategyUpdate(swarmRunID: string, revision: PlanRevisionWire): void {
  emitBoardEvent(swarmRunID, { type: 'strategy.update', revision });
}

export function subscribeBoardEvents(
  swarmRunID: string,
  listener: Listener,
): () => void {
  const subs = bus().subscribers;
  let set = subs.get(swarmRunID);
  if (!set) {
    set = new Set();
    subs.set(swarmRunID, set);
  }
  set.add(listener);
  return () => {
    const current = bus().subscribers.get(swarmRunID);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) bus().subscribers.delete(swarmRunID);
  };
}
