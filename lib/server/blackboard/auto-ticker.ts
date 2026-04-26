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

import { liveExports, publishExports } from '../hmr-exports';
import {
  AUTO_TICKER_EXPORTS_KEY,
  DEFAULT_INTERVAL_MS,
  type AutoTickerExports,
  type AutoTickerOpts,
  type PerSessionSlot,
  type StopReason,
  type TickerSnapshot,
} from './auto-ticker/types';
import {
  tickers,
  listAutoTickers,
  getTickerSnapshot,
} from './auto-ticker/state';
import { stopAutoTicker } from './auto-ticker/stop';
import { checkLiveness, LIVENESS_CHECK_INTERVAL_MS } from './auto-ticker/liveness';
import { runPeriodicSweep } from './auto-ticker/sweep';
import { fanout } from './auto-ticker/tick';

// Re-export public types + state APIs so external imports keep working
// unchanged (`from '@/lib/server/blackboard/auto-ticker'` continues to
// resolve these). Phases 1-2 of #106 — types and state extracted;
// remaining logic still lives below.
export type {
  StopReason,
  AutoTickerOpts,
  TickerSnapshot,
  AutoTickerExports,
};
export {
  AUTO_TICKER_EXPORTS_KEY,
  listAutoTickers,
  getTickerSnapshot,
  stopAutoTicker,
};

// Self-publish so this module's own setInterval callbacks resolve to
// fresh code after an HMR reload. Callbacks captured at setInterval
// time route through liveAutoTicker() which reads globalThis, so any
// edit to fanout / runPeriodicSweep / checkLiveness propagates to the
// existing ticker on its next tick.
function liveAutoTicker(): AutoTickerExports {
  return liveExports<AutoTickerExports>(AUTO_TICKER_EXPORTS_KEY, {
    fanout,
    runPeriodicSweep,
    checkLiveness,
  });
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
  const orchestratorSessionID = opts.orchestratorSessionID ?? '';
  // All three setInterval callbacks route via liveAutoTicker() so HMR
  // reloads of this module (new fanout / runPeriodicSweep / checkLiveness
  // implementations) propagate to existing tickers without needing
  // stopAutoTicker + startAutoTicker cycles. See hmr-exports.ts.
  const timer = setInterval(() => {
    void liveAutoTicker().fanout(swarmRunID);
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
      void liveAutoTicker().runPeriodicSweep(s);
    }, periodicSweepMs);
    if (typeof (periodicSweepTimer as NodeJS.Timeout).unref === 'function') {
      (periodicSweepTimer as NodeJS.Timeout).unref();
    }
    console.log(
      `[board/auto-ticker] ${swarmRunID}: periodic sweep enabled at ${Math.round(periodicSweepMs / 60000)}-min cadence`,
    );
  }

  // Liveness watchdog. Always-on for every ticker regardless of short-run
  // vs long-run mode — detects opencode silent-freeze on any run shape.
  const livenessTimer = setInterval(() => {
    const s = tickers().get(swarmRunID);
    if (!s || s.stopped) return;
    void liveAutoTicker().checkLiveness(s);
  }, LIVENESS_CHECK_INTERVAL_MS);
  if (typeof (livenessTimer as NodeJS.Timeout).unref === 'function') {
    (livenessTimer as NodeJS.Timeout).unref();
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

  const nowMs = Date.now();
  tickers().set(swarmRunID, {
    swarmRunID,
    intervalMs,
    timer,
    stopped: false,
    stoppedAtMs: undefined,
    stopReason: undefined,
    startedAtMs: nowMs,
    sessionIDs,
    slots,
    resweepInFlight: false,
    currentTier: 1,
    tierExhausted: false,
    consecutiveDrainedSweeps: 0,
    commitsSinceLastAudit: 0,
    auditInFlight: false,
    // Cadence default: 5 commits between audits. Can be overridden
    // per-run via SwarmRunRequest.auditEveryNCommits; the meta read
    // happens lazily in maybeRunAudit so a run without an auditor
    // doesn't pay the getRun() cost.
    auditEveryNCommits: 5,
    totalCommits: 0,
    periodicSweepMs,
    periodicSweepTimer,
    orchestratorSessionID,
    // The initial planner sweep just ran before startAutoTicker was
    // called, so seeding lastSweepAtMs to now prevents the eager-idle
    // check from firing a redundant sweep in the first MIN_MS window.
    lastSweepAtMs: nowMs,
    // Liveness watchdog state. 0 tokens at start is expected — the
    // STARTUP_GRACE_MS window governs whether that stays OK.
    livenessTimer,
    lastSeenTokens: 0,
    lastTokensChangedAtMs: nowMs,
  });
}



// Publish to globalThis so in-flight setInterval callbacks resolve to
// the latest fanout / runPeriodicSweep / checkLiveness on their next
// tick, even when HMR replaces this module mid-run.
publishExports<AutoTickerExports>(AUTO_TICKER_EXPORTS_KEY, {
  fanout,
  runPeriodicSweep,
  checkLiveness,
});
