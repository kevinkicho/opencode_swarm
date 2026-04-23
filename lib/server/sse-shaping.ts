// SSE forwarding shape helpers. Three transformations sit between
// opencode's raw event stream and the browser's EventSource:
//
//   1. reshapeForForward  — strip the redundant summary.diffs patches
//                           from message.updated frames
//   2. PartCoalescer      — per-partID debounce on message.part.updated
//                           frames for tool/reasoning parts
//   3. dedupeReplay       — collapse historical message.updated /
//                           message.part.updated frames to latest-per-id
//                           during L0 replay on reconnect
//
// All three are independent and composable — apply any subset safely.
// Purpose: the browser EventSource + setEvents([...prev, row]) pattern
// scales as O(events × events) in re-render cost. A 10-min three-session
// run emits thousands of 5–10 KB full-state snapshots, which chokes the
// tab. These shapers preserve observable end-state while collapsing the
// update-frequency and per-frame payload.

import type { SwarmRunEvent } from '@/lib/swarm-run-types';

const MESSAGE_UPDATED = 'message.updated';
const MESSAGE_PART_UPDATED = 'message.part.updated';

// Default coalesce window for tool/reasoning parts. Chosen so the "first
// activity" signal reaches the browser instantly (part arrives → emit)
// while mid-flight token-by-token re-snapshots collapse to ~4 frames/sec
// per part. Tuning room: 150 ms feels snappier but gives less compression
// on long tool calls; 400 ms starts to feel laggy on the first state flip.
export const PART_COALESCE_MS = 250;

// Narrow type for message.updated event shape — we only touch the
// summary.diffs nested field, so a shallow subset is enough.
interface MessageUpdatedProps {
  info?: {
    id?: string;
    summary?: {
      diffs?: Array<{ file?: string; patch?: string }>;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface PartUpdatedProps {
  part?: {
    id?: string;
    type?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

// Reshape an event for persistence + forwarding. Today the only transform
// is stripping `info.summary.diffs[].patch` from message.updated frames —
// the patch text is already carried by session.diff events and the
// /session/:id/diff endpoint, so emitting it again inside message.updated
// adds up to 10 KB per frame with zero UI consumer (verified no component
// reads summary.diffs.patch). Other event types pass through untouched.
export function reshapeForForward(ev: SwarmRunEvent): SwarmRunEvent {
  if (ev.type !== MESSAGE_UPDATED) return ev;
  const props = ev.properties as MessageUpdatedProps | undefined;
  const diffs = props?.info?.summary?.diffs;
  if (!Array.isArray(diffs) || diffs.length === 0) return ev;
  // Keep the file list so any future consumer can see what changed without
  // the patch text bloat. Drop every other summary.diffs entry field since
  // `patch` is the only heavy one currently shipped.
  return {
    ...ev,
    properties: {
      ...props,
      info: {
        ...props!.info,
        summary: {
          ...props!.info!.summary,
          diffs: diffs.map((d) => ({ file: d.file })),
        },
      },
    } as unknown,
  };
}

// Tool and reasoning parts update token-by-token during long operations.
// Text parts *also* update frequently but users expect streaming text to
// feel responsive, so we deliberately exclude them from coalescing.
// patch / step-start / step-finish / file parts are one-shot so coalescing
// is a no-op for them — leaving them in the "forward immediately" path
// keeps the shaper logic tight.
function isCoalesceable(ev: SwarmRunEvent): boolean {
  if (ev.type !== MESSAGE_PART_UPDATED) return false;
  const props = ev.properties as PartUpdatedProps | undefined;
  const partType = props?.part?.type;
  return partType === 'tool' || partType === 'reasoning';
}

function partIDFor(ev: SwarmRunEvent): string | null {
  if (ev.type !== MESSAGE_PART_UPDATED) return null;
  const props = ev.properties as PartUpdatedProps | undefined;
  return typeof props?.part?.id === 'string' ? props.part.id : null;
}

// Per-connection coalescer. Not shared across browsers — each SSE stream
// instantiates its own. Stateful:
//
//   - first `message.part.updated` for a part emits immediately and starts
//     a cooldown window
//   - subsequent updates within the window replace the pending frame
//   - when the window expires, the latest pending frame (if any) is
//     emitted and a new window opens, so a sustained burst caps at
//     1 emit / cooldownMs per part
//
// On stream close, call flushAll() so the browser never misses the final
// in-flight state.
export class PartCoalescer {
  private pending = new Map<string, SwarmRunEvent>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly cooldownMs: number,
    private readonly emit: (ev: SwarmRunEvent) => void,
  ) {}

  // Try to coalesce. Returns true if handled (emitted or buffered), false
  // if the event should be forwarded by the caller directly.
  accept(ev: SwarmRunEvent): boolean {
    if (!isCoalesceable(ev)) return false;
    const partID = partIDFor(ev);
    if (!partID) return false;

    if (this.timers.has(partID)) {
      this.pending.set(partID, ev);
      return true;
    }

    this.emit(ev);
    this.timers.set(
      partID,
      setTimeout(() => this.onCooldownExpire(partID), this.cooldownMs),
    );
    return true;
  }

  private onCooldownExpire(partID: string): void {
    this.timers.delete(partID);
    const buffered = this.pending.get(partID);
    if (!buffered) return;
    this.pending.delete(partID);
    this.emit(buffered);
    // New cooldown — continuous bursts cap at one emit per window.
    this.timers.set(
      partID,
      setTimeout(() => this.onCooldownExpire(partID), this.cooldownMs),
    );
  }

  flushAll(): void {
    for (const ev of this.pending.values()) this.emit(ev);
    this.pending.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

// Dedupe an L0 replay buffer: keep only the latest `message.updated` per
// message.id and latest `message.part.updated` per part.id. All other
// event types pass through verbatim in arrival order.
//
// Rationale: the point of L0 replay is to reconstruct current state so
// the browser renders what a live-connected client would. Intermediate
// snapshots in between the final state add no observable information —
// the derived views (toLiveTurns, toFileHeat, etc.) only care about the
// most recent version of each entity. Dropping intermediates shrinks a
// 22 MB replay to a few hundred KB on reconnect, removes most of the
// tab-freeze on reload, and preserves every non-update event verbatim so
// transitional signals (session.status, session.diff, message.part.removed)
// still arrive in order.
export function dedupeReplay(events: SwarmRunEvent[]): SwarmRunEvent[] {
  const latestMsg = new Map<string, number>();
  const latestPart = new Map<string, number>();
  const drop = new Uint8Array(events.length);

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === MESSAGE_UPDATED) {
      const id = (ev.properties as MessageUpdatedProps | undefined)?.info?.id;
      if (typeof id === 'string') {
        const prev = latestMsg.get(id);
        if (prev !== undefined) drop[prev] = 1;
        latestMsg.set(id, i);
      }
    } else if (ev.type === MESSAGE_PART_UPDATED) {
      const id = partIDFor(ev);
      if (id) {
        const prev = latestPart.get(id);
        if (prev !== undefined) drop[prev] = 1;
        latestPart.set(id, i);
      }
    }
  }

  const out: SwarmRunEvent[] = [];
  for (let i = 0; i < events.length; i++) if (!drop[i]) out.push(events[i]);
  return out;
}
