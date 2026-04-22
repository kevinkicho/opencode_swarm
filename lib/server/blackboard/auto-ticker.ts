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

interface TickerState {
  swarmRunID: string;
  intervalMs: number;
  timer: NodeJS.Timeout;
  inFlight: boolean;
  stopped: boolean;
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
        stopAutoTicker(swarmRunID);
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
    consecutiveIdle: 0,
    startedAtMs: Date.now(),
  });
}

export function stopAutoTicker(swarmRunID: string): void {
  const s = tickers().get(swarmRunID);
  if (!s) return;
  s.stopped = true;
  clearInterval(s.timer);
  tickers().delete(swarmRunID);
}

// Observability: surface current tickers for a debug route / smoke script.
// Read-only; mutating the returned objects is not supported.
export function listAutoTickers(): Array<{
  swarmRunID: string;
  intervalMs: number;
  inFlight: boolean;
  consecutiveIdle: number;
  lastOutcome?: TickOutcome;
  lastRanAtMs?: number;
  startedAtMs: number;
}> {
  return [...tickers().values()].map((s) => ({
    swarmRunID: s.swarmRunID,
    intervalMs: s.intervalMs,
    inFlight: s.inFlight,
    consecutiveIdle: s.consecutiveIdle,
    lastOutcome: s.lastOutcome,
    lastRanAtMs: s.lastRanAtMs,
    startedAtMs: s.startedAtMs,
  }));
}
