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

// Eager re-sweep threshold. When every session has been idle for this many
// ticks AND we're in long-running mode (periodicSweepMs > 0) AND the last
// sweep was long enough ago, fire a fresh planner sweep immediately
// instead of waiting for the periodic timer. Practical effect: 10-15 todos
// drain in ~5 min, sessions go idle, 30s later a new batch lands — no more
// sitting idle for 15 min waiting for the 20-min periodic tick.
const IDLE_TICKS_BEFORE_EAGER_SWEEP = 3;

// Floor on how frequently sweeps fire. Even if the board drains instantly,
// the planner needs ~60-90s per sweep, and stacking sweeps back-to-back
// would burn tokens on constant re-planning and race the "overwrite guard"
// in runPlannerSweep. 2 minutes gives the previous sweep time to fully
// land its new todos before the next one starts reasoning about them.
const MIN_MS_BETWEEN_SWEEPS = 2 * 60 * 1000;

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
  // Periodic re-sweep cadence for long-running runs. When > 0, fires a
  // fresh planner sweep every N ms so an overnight run keeps producing
  // work as the codebase evolves. When > 0, the auto-idle stop logic is
  // *disabled* — the ticker only stops via explicit stopAutoTicker or
  // process shutdown. A short (< periodicSweepMs) run that drains once
  // is expected to look idle-but-alive until the human shuts it down.
  // Default 0 preserves the original short-run single-sweep behavior.
  periodicSweepMs: number;
  periodicSweepTimer: NodeJS.Timeout | null;
  // Timestamp of the most recent sweep (initial, periodic, or eager). Used
  // as the MIN_MS_BETWEEN_SWEEPS floor so rapid-drain runs don't stack
  // planner calls faster than they can land.
  lastSweepAtMs: number;
}

type TickerMap = Map<string, TickerState>;

const globalTickerKey = Symbol.for('opencode_swarm.boardAutoTickers');
const globalShutdownHookKey = Symbol.for('opencode_swarm.boardAutoTickers.shutdownHook');
type GlobalWithTickers = typeof globalThis & {
  [globalTickerKey]?: TickerMap;
  [globalShutdownHookKey]?: boolean;
};

function tickers(): TickerMap {
  const g = globalThis as GlobalWithTickers;
  if (!g[globalTickerKey]) g[globalTickerKey] = new Map();
  // Install shutdown hook once per process so a dev-server Ctrl+C or
  // a parent-signal kill cleanly stops every live ticker — clearInterval
  // on each, flip state.stopped=true. Without this, SIGTERM dumps the
  // ticker map mid-tick with no trace. Guarded by a symbol so HMR
  // reloads don't re-register 200 listeners.
  if (!g[globalShutdownHookKey]) {
    g[globalShutdownHookKey] = true;
    const shutdown = (signal: string) => {
      const map = g[globalTickerKey];
      if (!map || map.size === 0) return;
      console.log(
        `[board/auto-ticker] ${signal}: stopping ${map.size} ticker(s) before exit`,
      );
      for (const state of map.values()) {
        if (!state.stopped) {
          if (state.timer) clearInterval(state.timer);
          state.timer = null;
          if (state.periodicSweepTimer) clearInterval(state.periodicSweepTimer);
          state.periodicSweepTimer = null;
          state.stopped = true;
          state.stoppedAtMs = Date.now();
          state.stopReason = 'manual';
        }
      }
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('beforeExit', () => shutdown('beforeExit'));
  }
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
    const slots = [...state.slots.values()];

    // Eager re-sweep (long-running mode only). When every session has
    // been idle past IDLE_TICKS_BEFORE_EAGER_SWEEP and MIN_MS_BETWEEN_SWEEPS
    // has elapsed, fire a fresh planner sweep immediately instead of
    // waiting for the periodic timer. This turns the "board drained,
    // sessions idle 15min waiting for timer" dead zone into "board
    // drained, 30s later a new batch lands."
    // `state.lastSweepAtMs ?? 0` is defensive: an existing ticker created
    // before this field was added won't have it. Treating missing as "long
    // ago" lets in-flight HMR'd runs pick up eager-sweep behavior without
    // needing a restart.
    if (
      state.periodicSweepMs > 0 &&
      !state.resweepInFlight &&
      slots.length > 0 &&
      slots.every((s) => s.consecutiveIdle >= IDLE_TICKS_BEFORE_EAGER_SWEEP) &&
      Date.now() - (state.lastSweepAtMs ?? 0) >= MIN_MS_BETWEEN_SWEEPS
    ) {
      console.log(
        `[board/auto-ticker] ${state.swarmRunID}: all ${slots.length} sessions idle ${IDLE_TICKS_BEFORE_EAGER_SWEEP}+ ticks and ≥${MIN_MS_BETWEEN_SWEEPS / 1000}s since last sweep — firing eager re-sweep`,
      );
      void runPeriodicSweep(state);
    }

    // Auto-stop when every session is simultaneously idle-past-threshold.
    // A single active session (consecutiveIdle == 0) holds the run open.
    //
    // Skipped entirely when periodicSweepMs > 0: the run has opted into
    // "keep going until told to stop," so steady-state idle between
    // sweeps is a normal phase, not a shutdown signal. Without this
    // skip, a long-running run would auto-stop on the first drain
    // before the first periodic sweep ever fired.
    if (
      state.periodicSweepMs === 0 &&
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
  state.lastSweepAtMs = Date.now();
  try {
    const beforeOpen = listBoardItems(swarmRunID).filter(
      (i) => i.status === 'open',
    ).length;
    // overwrite: true so the "board already populated" guard in the
    // planner doesn't throw — the board intentionally has items at this
    // point (the drained initial batch). includeBoardContext: true so
    // the planner sees what's already done/pending and proposes new work
    // instead of duplicates.
    const result = await runPlannerSweep(swarmRunID, {
      overwrite: true,
      includeBoardContext: true,
    });
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

// Long-running cadenced planner sweep. Unlike attemptReSweep (end-of-life
// one-shot), this fires on a timer regardless of whether the board is
// idle — the point is to periodically re-examine the repo as it evolves
// under the workers' edits and seed fresh todos the original planner
// pass couldn't see. Reuses `resweepInFlight` as a mutex with the
// auto-idle one-shot so the two can't collide.
async function runPeriodicSweep(state: TickerState): Promise<void> {
  if (state.stopped) return;
  if (state.resweepInFlight) return;
  // Floor to prevent stacking: if a sweep just fired, skip this one.
  // Both the periodic timer and the eager-idle check route here, so
  // whichever one wins the race first is the one that runs.
  const sinceLast = Date.now() - (state.lastSweepAtMs ?? 0);
  if (sinceLast < MIN_MS_BETWEEN_SWEEPS) {
    console.log(
      `[board/auto-ticker] ${state.swarmRunID}: sweep requested ${Math.round(sinceLast / 1000)}s after last — under ${MIN_MS_BETWEEN_SWEEPS / 1000}s floor, skipping`,
    );
    return;
  }
  const swarmRunID = state.swarmRunID;
  state.resweepInFlight = true;
  state.lastSweepAtMs = Date.now();
  try {
    const beforeOpen = listBoardItems(swarmRunID).filter(
      (i) => i.status === 'open',
    ).length;
    // overwrite: true bypasses the "board already populated" planner
    // guard. includeBoardContext: true feeds the planner the already-
    // done list so it stops re-proposing stale items — critical over an
    // 8h run where the same things would otherwise get suggested 24×.
    const result = await runPlannerSweep(swarmRunID, {
      overwrite: true,
      includeBoardContext: true,
    });
    const afterOpen = listBoardItems(swarmRunID).filter(
      (i) => i.status === 'open',
    ).length;
    const newlyOpen = afterOpen - beforeOpen;
    if (newlyOpen > 0) {
      console.log(
        `[board/auto-ticker] ${swarmRunID}: periodic sweep seeded ${newlyOpen} new open todo(s) — resetting idle counters`,
      );
      for (const slot of state.slots.values()) slot.consecutiveIdle = 0;
    } else {
      console.log(
        `[board/auto-ticker] ${swarmRunID}: periodic sweep produced no new work (planner returned ${result.items.length} total items)`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[board/auto-ticker] ${swarmRunID}: periodic sweep threw:`,
      message,
    );
  } finally {
    state.resweepInFlight = false;
  }
}

export interface AutoTickerOpts {
  intervalMs?: number;
  // When > 0, fires a fresh planner sweep every N ms for the life of the
  // run. Also disables the auto-idle stop logic — the ticker keeps going
  // until explicitly stopped. Intended for long-running (hours+) runs
  // where new refactoring opportunities surface as the codebase evolves.
  // Omit / set to 0 for the original "drain once, maybe re-sweep, stop"
  // shape used by short smokes and the battle tests.
  periodicSweepMs?: number;
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
  const periodicSweepMs = opts.periodicSweepMs ?? 0;
  const timer = setInterval(() => {
    void fanout(swarmRunID);
  }, intervalMs);
  // Node-only: don't keep the event loop alive for a ticker. The Next.js
  // server process has its own reasons to stay up; a ticker shouldn't
  // block clean shutdown.
  if (typeof (timer as NodeJS.Timeout).unref === 'function') {
    (timer as NodeJS.Timeout).unref();
  }

  // Periodic planner re-sweep timer for long-running runs. Independent of
  // the tick timer — cadence is measured in minutes/hours, not seconds.
  let periodicSweepTimer: NodeJS.Timeout | null = null;
  if (periodicSweepMs > 0) {
    periodicSweepTimer = setInterval(() => {
      const s = tickers().get(swarmRunID);
      if (!s || s.stopped) return;
      void runPeriodicSweep(s);
    }, periodicSweepMs);
    if (typeof (periodicSweepTimer as NodeJS.Timeout).unref === 'function') {
      (periodicSweepTimer as NodeJS.Timeout).unref();
    }
    console.log(
      `[board/auto-ticker] ${swarmRunID}: periodic sweep enabled at ${Math.round(periodicSweepMs / 60000)}-min cadence`,
    );
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
    periodicSweepMs,
    periodicSweepTimer,
    // The initial planner sweep just ran before startAutoTicker was
    // called, so seeding lastSweepAtMs to now prevents the eager-idle
    // check from firing a redundant sweep in the first MIN_MS window.
    lastSweepAtMs: Date.now(),
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
  if (s.periodicSweepTimer) clearInterval(s.periodicSweepTimer);
  s.periodicSweepTimer = null;
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
