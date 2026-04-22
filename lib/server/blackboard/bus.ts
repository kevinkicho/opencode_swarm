// Process-local event bus for blackboard item mutations. The SSE endpoint
// at `/api/swarm/run/:id/board/events` subscribes here; the store emits
// after every successful insert / transition. Keeping the bus in-process
// is fine because the blackboard DB is already singleton-scoped by file
// path (see `./db.ts`) — any code that mutates the board runs inside the
// same Node process that serves the SSE stream.
//
// HMR safety: pin the subscriber map on `globalThis` so route reloads
// don't orphan open streams. Matches the pattern used by `auto-ticker.ts`.

import type { BoardItem } from '@/lib/blackboard/types';

export type BoardEvent =
  | { type: 'item.inserted'; item: BoardItem }
  | { type: 'item.updated'; item: BoardItem };

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
