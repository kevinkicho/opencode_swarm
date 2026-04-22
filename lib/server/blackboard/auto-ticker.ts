// Auto-ticker — step 3d of SWARM_PATTERNS.md §1.
//
// Per-run heartbeat that calls tickCoordinator on an interval so a
// blackboard run makes progress without an external driver. Starts when
// the run is created, stops itself once the board is quiet for long enough
// that ticking is just wasted I/O.
//
// Design choices:
//   - setInterval per run. At prototype scale (dozens of runs) the
//     bookkeeping is trivial; if we ever need to run hundreds of runs
//     concurrently, switch to a single global loop iterating a priority
//     queue. Not today.
//   - inFlight guard on each ticker. A tick can take 5+ minutes when the
//     assistant turn runs long; during that window the interval keeps
//     firing but we swallow re-entrant invocations rather than stack them
//     up or run them concurrently (which would break the "single
//     coordinator per run" contract tickCoordinator relies on).
//   - Auto-stop after N consecutive fully-skipped ticks. "Skipped" means
//     either no open todos or no idle sessions — both are quiescent
//     states. 6 skips at 10s cadence = 60s of quiet; after that we assume
//     the run is done and stop polling. Any new board activity (manual
//     /board POST, new sweep) can re-arm the ticker through startAutoTicker.
//   - `globalThis`-pinned state map. Matches the pattern used by the DB
//     singletons (see blackboard/db.ts::globalThis pinning) so Next.js
//     dev module reloads don't double-register timers. Old timer handles
//     from reloaded modules become orphaned — we log and move on rather
//     than chase them.
//
// Server-only. Not imported from client code.

import { tickCoordinator, type TickOutcome } from './coordinator';

const DEFAULT_INTERVAL_MS = 10_000;
const IDLE_TICKS_BEFORE_STOP = 6;

export type StopReason = 'auto-idle' | 'manual';

interface TickerState {
  swarmRunID: string;
  intervalMs: number;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  stopped: boolean;
  stoppedAtMs?: number;
  stopReason?: StopReason;
  consecutiveIdle: number;
  lastOutcome?: TickOutcome;
  lastRanAtMs?: number;
  startedAtMs: number;
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

async function tickOnce(swarmRunID: string): Promise<void> {
  const s = tickers().get(swarmRunID);
  if (!s || s.stopped) return;
  if (s.inFlight) return; // re-entrancy guard; previous tick still running
  s.inFlight = true;
  try {
    const outcome = await tickCoordinator(swarmRunID);
    s.lastOutcome = outcome;
    s.lastRanAtMs = Date.now();
    if (isIdleOutcome(outcome)) {
      s.consecutiveIdle += 1;
      if (s.consecutiveIdle >= IDLE_TICKS_BEFORE_STOP) {
        console.log(
          `[board/auto-ticker] ${swarmRunID}: idle for ${IDLE_TICKS_BEFORE_STOP} ticks — stopping`,
        );
        stopAutoTicker(swarmRunID, 'auto-idle');
      }
    } else {
      s.consecutiveIdle = 0;
    }
  } catch (err) {
    // tickCoordinator's declared return type is TickOutcome (it wraps its
    // own failures as { status: 'stale' }), so reaching this catch means
    // something outside the coordinator threw — registry read failure,
    // opencode offline, etc. Log and keep the timer alive; the next tick
    // might succeed, and stopping here would strand the run.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[board/auto-ticker] ${swarmRunID}: tick threw:`,
      message,
    );
  } finally {
    s.inFlight = false;
  }
}

export interface AutoTickerOpts {
  intervalMs?: number;
}

// Start (or re-arm) the ticker for a run. Idempotent: if a ticker is
// already running, reset its idle counter so new activity can restart a
// run that had auto-stopped. The interval on the existing timer is left
// alone — changing cadence means stopping and starting fresh.
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
    existing.consecutiveIdle = 0;
    return;
  }

  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timer = setInterval(() => {
    void tickOnce(swarmRunID);
  }, intervalMs);
  // Node-only: don't keep the event loop alive for a ticker. The Next.js
  // server process has its own reasons to stay up; a ticker shouldn't
  // block clean shutdown.
  if (typeof (timer as NodeJS.Timeout).unref === 'function') {
    (timer as NodeJS.Timeout).unref();
  }

  tickers().set(swarmRunID, {
    swarmRunID,
    intervalMs,
    timer,
    inFlight: false,
    stopped: false,
    stoppedAtMs: undefined,
    stopReason: undefined,
    consecutiveIdle: 0,
    // Preserve lastOutcome / lastRanAtMs if we're restarting a previously
    // stopped ticker — it's useful context in the UI ("restarted, last
    // activity was 2m ago"). startedAtMs always reflects *this* run.
    lastOutcome: existing?.lastOutcome,
    lastRanAtMs: existing?.lastRanAtMs,
    startedAtMs: Date.now(),
  });
}

// Stop the ticker but KEEP the map entry so observers can distinguish
// "never started" (no entry) from "ran and stopped" (stopped: true).
// `reason` records why: 'auto-idle' after the idle-ticks threshold;
// 'manual' from an explicit user action through the control route.
// Entries persist for the life of the process — at prototype scale
// (dozens of runs per session) this is a few hundred bytes total.
export function stopAutoTicker(swarmRunID: string, reason: StopReason = 'manual'): void {
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
  return {
    swarmRunID: s.swarmRunID,
    intervalMs: s.intervalMs,
    inFlight: s.inFlight,
    stopped: s.stopped,
    stoppedAtMs: s.stoppedAtMs,
    stopReason: s.stopReason,
    consecutiveIdle: s.consecutiveIdle,
    idleThreshold: IDLE_TICKS_BEFORE_STOP,
    lastOutcome: s.lastOutcome,
    lastRanAtMs: s.lastRanAtMs,
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
