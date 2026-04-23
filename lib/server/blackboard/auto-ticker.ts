// Auto-ticker — step 3d of SWARM_PATTERNS.md §1.
//
// Per-run heartbeat that calls tickCoordinator on an interval so a
// blackboard run makes progress without an external driver. Starts when
// the run is created, stops itself once the board is quiet for long enough
// that ticking is just wasted I/O.
//
// Parallelism model (2026-04-22). Originally one tick per run, dispatching
// to the first idle session and awaiting the whole claim→work→commit
// cycle before returning. That serialized everything: with N sessions and
// M todos, one session did all M claims sequentially while the others sat
// idle (see SWARM_PATTERNS.md §1 Open questions → Blackboard parallelism
// for the incident record). Now: one timer per run, but each fire dispatches
// a per-session tick via `void tickSession(...)`. Each session has its own
// inFlight guard, so a slow session (5-min assistant turn) doesn't block
// its siblings. CAS in the store layer protects against two sessions
// racing on the same todo — the loser records a `skipped: claim lost race`
// outcome and picks a different todo next tick.
//
// Design choices:
//   - setInterval per run. At prototype scale (dozens of runs) the
//     bookkeeping is trivial; if we ever need to run hundreds of runs
//     concurrently, switch to a single global loop iterating a priority
//     queue. Not today.
//   - Per-session inFlight guard. A session's tick can take 5+ minutes
//     when the assistant turn runs long; during that window the interval
//     keeps firing. We swallow re-entrant invocations per-session rather
//     than stack them up. Other sessions' ticks run normally — that's the
//     whole point of the split.
//   - Auto-stop fires only when EVERY session's consecutiveIdle reaches
//     the threshold. A single session making progress keeps the run alive.
//     6 idle ticks at 10s cadence = 60s of whole-run quiet before stop.
//   - `globalThis`-pinned state map. Matches the pattern used by the DB
//     singletons (see blackboard/db.ts::globalThis pinning) so Next.js
//     dev module reloads don't double-register timers. Old timer handles
//     from reloaded modules become orphaned — we log and move on rather
//     than chase them.
//
// Server-only. Not imported from client code.

import { getRun } from '../swarm-registry';
import { tickCoordinator, type TickOutcome } from './coordinator';
import { runPlannerSweep } from './planner';
import { listBoardItems } from './store';

const DEFAULT_INTERVAL_MS = 10_000;
const IDLE_TICKS_BEFORE_STOP = 6;

export type StopReason = 'auto-idle' | 'manual';

interface PerSessionSlot {
  sessionID: string;
  inFlight: boolean;
  consecutiveIdle: number;
  lastOutcome?: TickOutcome;
  lastRanAtMs?: number;
}

interface TickerState {
  swarmRunID: string;
  intervalMs: number;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  stoppedAtMs?: number;
  stopReason?: StopReason;
  startedAtMs: number;
  // sessionIDs are captured once (first fanout) from run meta; sessions
  // aren't added mid-run in today's model. Empty until first fanout populates.
  sessionIDs: string[];
  slots: Map<string, PerSessionSlot>;
  // Re-sweep bookkeeping. Before auto-idling we give the planner ONE
  // more chance to emit follow-up todos — e.g. the first batch's work
  // surfaced new refactoring opportunities. `resweepInFlight` guards
  // against re-entrant re-sweep calls from concurrent session ticks
  // all hitting the auto-idle threshold at once; `resweepAttempted`
  // keeps us from re-sweeping forever if the second batch also
  // completes without discovering new work.
  resweepInFlight: boolean;
  resweepAttempted: boolean;
}

type TickerMap = Map<string, TickerState>;

const globalTickerKey = Symbol.for('opencode_swarm.boardAutoTickers');
type GlobalWithTickers = typeof globalThis & {
  [globalTickerKey]?: TickerMap;
};

function tickers(): TickerMap {
  const g = globalThis as GlobalWithTickers;
  if (!g[globalTickerKey]) g[globalTickerKey] = new Map();
  return g[globalTickerKey]!;
}

// Is this outcome quiescent (no forward progress possible right now)?
// `picked` and `stale` are progress signals — real work ran; reset the
// idle counter. `skipped` is a no-op tick.
function isIdleOutcome(o: TickOutcome): boolean {
  return o.status === 'skipped';
}

function makeSlot(sessionID: string): PerSessionSlot {
  return { sessionID, inFlight: false, consecutiveIdle: 0 };
}

// Ensure sessionIDs + slots are populated. Called once per run lifecycle
// (cached after first fanout). Returns false when the run can't be resolved
// — caller should skip the tick.
async function ensureSlots(state: TickerState): Promise<boolean> {
  if (state.sessionIDs.length > 0) return true;
  const meta = await getRun(state.swarmRunID);
  if (!meta) return false;
  // Double-check after the await: a second fanout may have populated
  // concurrently. Initialize only if still empty.
  if (state.sessionIDs.length === 0) {
    state.sessionIDs = [...meta.sessionIDs];
    for (const sid of state.sessionIDs) {
      if (!state.slots.has(sid)) state.slots.set(sid, makeSlot(sid));
    }
  }
  return true;
}

async function tickSession(
  state: TickerState,
  sessionID: string,
): Promise<void> {
  if (state.stopped) return;
  const slot = state.slots.get(sessionID);
  if (!slot) return;
  if (slot.inFlight) return; // per-session re-entrancy guard
  slot.inFlight = true;
  try {
    const outcome = await tickCoordinator(state.swarmRunID, {
      restrictToSessionID: sessionID,
    });
    slot.lastOutcome = outcome;
    slot.lastRanAtMs = Date.now();
    if (isIdleOutcome(outcome)) {
      slot.consecutiveIdle += 1;
    } else {
      slot.consecutiveIdle = 0;
    }
    // Auto-stop when every session is simultaneously idle-past-threshold.
    // A single active session (consecutiveIdle == 0) holds the run open.
    const slots = [...state.slots.values()];
    if (
      slots.length > 0 &&
      slots.every((s) => s.consecutiveIdle >= IDLE_TICKS_BEFORE_STOP)
    ) {
      // Before stopping, give the planner one more chance to emit new
      // todos based on current repo state. A typical smoke: the first
      // batch of 8 todos drains, idle ticks accumulate, we'd normally
      // stop — but the work may have surfaced refactoring opportunities
      // the planner now sees. If the re-sweep produces open items, the
      // idle counters reset and the ticker keeps going. If not, stop.
      if (!state.resweepAttempted && !state.resweepInFlight) {
        state.resweepInFlight = true;
        console.log(
          `[board/auto-ticker] ${state.swarmRunID}: all ${slots.length} sessions idle — triggering one re-sweep before stopping`,
        );
        // Fire-and-forget so this tick doesn't block. The background
        // re-sweep reads board state and either seeds new todos or
        // confirms the run is genuinely complete.
        void attemptReSweep(state);
      } else if (state.resweepAttempted) {
        console.log(
          `[board/auto-ticker] ${state.swarmRunID}: all ${slots.length} sessions idle post-resweep — stopping`,
        );
        stopAutoTicker(state.swarmRunID, 'auto-idle');
      }
    }
  } catch (err) {
    // tickCoordinator's declared return type is TickOutcome (it wraps its
    // own failures as { status: 'stale' }), so reaching this catch means
    // something outside the coordinator threw — registry read failure,
    // opencode offline, etc. Log and keep the timer alive; the next tick
    // might succeed, and stopping here would strand the run.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[board/auto-ticker] ${state.swarmRunID}/${sessionID.slice(-8)}: tick threw:`,
      message,
    );
  } finally {
    slot.inFlight = false;
  }
}

async function fanout(swarmRunID: string): Promise<void> {
  const s = tickers().get(swarmRunID);
  if (!s || s.stopped) return;
  const ready = await ensureSlots(s);
  if (!ready) return;
  // Re-check after the await — could have been stopped while resolving run.
  if (s.stopped) return;
  // Fire per-session ticks without awaiting. Each has its own inFlight
  // guard, so slow sessions don't block fast ones.
  for (const sessionID of s.sessionIDs) {
    void tickSession(s, sessionID);
  }
}

// Run planner sweep once. If it seeds new open items, reset every
// slot's idle counter so the next tick picks them up. If not, mark
// resweepAttempted so the next auto-idle cascade stops for real.
async function attemptReSweep(state: TickerState): Promise<void> {
  const swarmRunID = state.swarmRunID;
  try {
    const beforeOpen = listBoardItems(swarmRunID).filter(
      (i) => i.status === 'open',
    ).length;
    const result = await runPlannerSweep(swarmRunID);
    const afterOpen = listBoardItems(swarmRunID).filter(
      (i) => i.status === 'open',
    ).length;
    const newlyOpen = afterOpen - beforeOpen;
    if (newlyOpen > 0) {
      console.log(
        `[board/auto-ticker] ${swarmRunID}: re-sweep seeded ${newlyOpen} new open todo(s) — resetting idle counters`,
      );
      for (const slot of state.slots.values()) slot.consecutiveIdle = 0;
    } else {
      console.log(
        `[board/auto-ticker] ${swarmRunID}: re-sweep produced no new work (planner returned ${result.items.length} total items)`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[board/auto-ticker] ${swarmRunID}: re-sweep threw:`,
      message,
    );
  } finally {
    state.resweepAttempted = true;
    state.resweepInFlight = false;
  }
}

export interface AutoTickerOpts {
  intervalMs?: number;
}

// Start (or re-arm) the ticker for a run. Idempotent: if a ticker is
// already running, reset per-session idle counters so new activity can
// restart a run that had auto-stopped.
//
// On restart after a stopped entry, we reuse the map slot rather than
// dropping the historical state — this way counters like startedAtMs
// reset to wall-clock now but the caller still reads a coherent single
// state (not "deleted then re-created" across a brief window).
export function startAutoTicker(
  swarmRunID: string,
  opts: AutoTickerOpts = {},
): void {
  const existing = tickers().get(swarmRunID);
  if (existing && !existing.stopped) {
    for (const slot of existing.slots.values()) {
      slot.consecutiveIdle = 0;
    }
    return;
  }

  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timer = setInterval(() => {
    void fanout(swarmRunID);
  }, intervalMs);
  // Node-only: don't keep the event loop alive for a ticker. The Next.js
  // server process has its own reasons to stay up; a ticker shouldn't
  // block clean shutdown.
  if (typeof (timer as NodeJS.Timeout).unref === 'function') {
    (timer as NodeJS.Timeout).unref();
  }

  // Preserve slot history across restart so the UI can show "last activity
  // 2m ago" instead of "never". inFlight and consecutiveIdle reset — the
  // old values belong to the previous run instance.
  const slots = new Map<string, PerSessionSlot>();
  const sessionIDs = existing?.sessionIDs ?? [];
  for (const sid of sessionIDs) {
    const old = existing?.slots.get(sid);
    slots.set(sid, {
      sessionID: sid,
      inFlight: false,
      consecutiveIdle: 0,
      lastOutcome: old?.lastOutcome,
      lastRanAtMs: old?.lastRanAtMs,
    });
  }

  tickers().set(swarmRunID, {
    swarmRunID,
    intervalMs,
    timer,
    stopped: false,
    stoppedAtMs: undefined,
    stopReason: undefined,
    startedAtMs: Date.now(),
    sessionIDs,
    slots,
    resweepInFlight: false,
    resweepAttempted: false,
  });
}

// Stop the ticker but KEEP the map entry so observers can distinguish
// "never started" (no entry) from "ran and stopped" (stopped: true).
// `reason` records why: 'auto-idle' after the idle-ticks threshold;
// 'manual' from an explicit user action through the control route.
// Entries persist for the life of the process — at prototype scale
// (dozens of runs per session) this is a few hundred bytes total.
export function stopAutoTicker(
  swarmRunID: string,
  reason: StopReason = 'manual',
): void {
  const s = tickers().get(swarmRunID);
  if (!s || s.stopped) return;
  s.stopped = true;
  s.stoppedAtMs = Date.now();
  s.stopReason = reason;
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}

// Shape handed to clients via /api/swarm/run/:id/ticker. Keep this in
// sync with components/board-rail.tsx's TickerChip expectations.
// Per-session detail is rolled up: inFlight=any, consecutiveIdle=min,
// last* from the most recently active session. The UI contract predates
// per-session fan-out and we keep it single-valued so the chip stays
// readable at a glance.
export interface TickerSnapshot {
  swarmRunID: string;
  intervalMs: number;
  inFlight: boolean;
  stopped: boolean;
  stoppedAtMs?: number;
  stopReason?: StopReason;
  consecutiveIdle: number;
  idleThreshold: number;
  lastOutcome?: TickOutcome;
  lastRanAtMs?: number;
  startedAtMs: number;
}

function snapshot(s: TickerState): TickerSnapshot {
  // Defensive: state entries written before the 2026-04-22 per-session
  // refactor carry `inFlight`/`consecutiveIdle` directly on the object
  // with no `slots` Map. After the new module loads over the old one via
  // Next.js HMR the globalThis map still holds those entries. Returning
  // them as "stopped-looking" keeps the ticker API from 500ing for runs
  // the user opened before the reload — fresh runs from startAutoTicker
  // always use the new shape.
  const slotMap = s.slots;
  const slots =
    slotMap && typeof slotMap.values === 'function' ? [...slotMap.values()] : [];
  const inFlight = slots.some((sl) => sl.inFlight);
  // min(consecutiveIdle): auto-stop fires when EVERY slot >= threshold,
  // so the UI's countdown tracks the slot closest to keeping the run alive.
  // Empty slots (pre-first-fanout) report 0, matching the original semantics.
  const consecutiveIdle =
    slots.length === 0 ? 0 : Math.min(...slots.map((sl) => sl.consecutiveIdle));
  // Most recent outcome across any session is the one worth surfacing.
  let lastRanAtMs: number | undefined;
  let lastOutcome: TickOutcome | undefined;
  for (const sl of slots) {
    if (sl.lastRanAtMs == null) continue;
    if (lastRanAtMs == null || sl.lastRanAtMs > lastRanAtMs) {
      lastRanAtMs = sl.lastRanAtMs;
      lastOutcome = sl.lastOutcome;
    }
  }
  return {
    swarmRunID: s.swarmRunID,
    intervalMs: s.intervalMs,
    inFlight,
    stopped: s.stopped,
    stoppedAtMs: s.stoppedAtMs,
    stopReason: s.stopReason,
    consecutiveIdle,
    idleThreshold: IDLE_TICKS_BEFORE_STOP,
    lastOutcome,
    lastRanAtMs,
    startedAtMs: s.startedAtMs,
  };
}

// Observability: surface current tickers for a debug route / smoke script.
export function listAutoTickers(): TickerSnapshot[] {
  return [...tickers().values()].map(snapshot);
}

// Single-run observability — feeds the board-rail ticker chip. Returns
// null when no ticker has ever run for this id (vs. stopped, which keeps
// an entry in the map with stopped: true).
export function getTickerSnapshot(swarmRunID: string): TickerSnapshot | null {
  const s = tickers().get(swarmRunID);
  return s ? snapshot(s) : null;
}
