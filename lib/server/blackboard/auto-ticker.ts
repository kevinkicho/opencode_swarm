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
import { liveExports, publishExports } from '../hmr-exports';
import {
  COORDINATOR_EXPORTS_KEY,
  tickCoordinator,
  waitForSessionIdle,
  type CoordinatorExports,
  type TickOutcome,
} from './coordinator';
import {
  PLANNER_EXPORTS_KEY,
  runPlannerSweep,
  type PlannerExports,
} from './planner';
import { listBoardItems } from './store';
import {
  AUTO_TICKER_EXPORTS_KEY,
  DEFAULT_INTERVAL_MS,
  IDLE_TICKS_BEFORE_STOP,
  IDLE_TICKS_BEFORE_EAGER_SWEEP,
  PERIODIC_DRAIN_TIER_THRESHOLD,
  MIN_MS_BETWEEN_SWEEPS,
  type AutoTickerExports,
  type AutoTickerOpts,
  type PerSessionSlot,
  type StopReason,
  type TickerSnapshot,
  type TickerState,
} from './auto-ticker/types';
import {
  tickers,
  listAutoTickers,
  getTickerSnapshot,
} from './auto-ticker/state';
import {
  checkRoleImbalance,
  isRetryExhausted,
  orchestratorReplanCapHit,
  MAX_ORCHESTRATOR_REPLANS,
} from './auto-ticker/policies';
import { maybeRunAudit } from './auto-ticker/audit';
import { stopAutoTicker } from './auto-ticker/stop';
import { checkHardCaps } from './auto-ticker/hard-caps';
import { attemptTierEscalation } from './auto-ticker/tier-escalation';
import { checkLiveness, LIVENESS_CHECK_INTERVAL_MS } from './auto-ticker/liveness';
import { runPeriodicSweep } from './auto-ticker/sweep';

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

// Live-export lookups for cross-module calls. Direct imports above are
// the fallback when the producer module hasn't published yet (unusual
// in practice — publish happens at module load). These closures read
// globalThis at each call, so HMR-reloaded coordinator / planner code
// takes effect on the next tick without needing a ticker restart.
// See lib/server/hmr-exports.ts for the rationale.
function liveCoordinator(): CoordinatorExports {
  return liveExports<CoordinatorExports>(COORDINATOR_EXPORTS_KEY, {
    tickCoordinator,
    waitForSessionIdle,
  });
}
function livePlanner(): PlannerExports {
  return liveExports<PlannerExports>(PLANNER_EXPORTS_KEY, {
    runPlannerSweep,
  });
}

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

// Liveness watchdog — detects the case where opencode accepts prompts
// (HTTP 204 from /prompt_async) but never generates any tokens. The


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
//
// Also hydrates `currentTier` from meta.currentTier if the run has
// persisted tier state from a prior ticker lifecycle (see
// attemptTierEscalation's updateRunMeta call). Lets a ticker restart
// resume at the tier where the previous one left off instead of
// dropping back to tier 1 on every reboot.
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
    // Resume the ambition ratchet from its persisted tier, if any.
    // Only take the persisted value if it's higher than the default —
    // don't accidentally regress from an in-memory bump that happened
    // mid-tick before the first fanout (unlikely but cheap to guard).
    if (
      typeof meta.currentTier === 'number' &&
      meta.currentTier > state.currentTier
    ) {
      state.currentTier = meta.currentTier;
      console.log(
        `[board/auto-ticker] ${state.swarmRunID}: resumed ambition ratchet at persisted tier ${meta.currentTier}`,
      );
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
    const outcome = await liveCoordinator().tickCoordinator(state.swarmRunID, {
      restrictToSessionID: sessionID,
      excludeSessionIDs: state.orchestratorSessionID
        ? [state.orchestratorSessionID]
        : undefined,
    });
    slot.lastOutcome = outcome;
    slot.lastRanAtMs = Date.now();
    if (isIdleOutcome(outcome)) {
      slot.consecutiveIdle += 1;
    } else {
      slot.consecutiveIdle = 0;
    }

    // Stage 2 commit-cadence + hard-cap bookkeeping. 'picked' = a worker
    // successfully committed a todo to done — what "a commit" means in
    // the spec. Increments both the totalCommits (hard-cap signal) and
    // commitsSinceLastAudit (audit-cadence signal) counters. maybeRun-
    // Audit gates on whether the run actually has an auditor configured
    // so runs without the gate pay only the counter increments.
    if (outcome.status === 'picked') {
      state.totalCommits += 1;
      state.commitsSinceLastAudit += 1;
      if (state.commitsSinceLastAudit >= state.auditEveryNCommits) {
        void maybeRunAudit(state, 'cadence');
      }
      // Hard-cap check after every commit — at-commit is when all
      // three dimensions (commits, todos, wall-clock) are most likely
      // to have shifted. Fire-and-forget: if breached, checkHardCaps
      // calls stopAutoTicker itself. Don't race against further ticks
      // — state.stopped gates any subsequent work.
      void checkHardCaps(state);
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
      void liveAutoTicker().runPeriodicSweep(state);
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
      // Ambition ratchet (see SWARM_PATTERNS.md "Tiered execution"). On
      // idle cascade we try a tier-N+1 planner escalation. If it seeds
      // items, the ticker keeps going at the new tier. Stage 2 (user's
      // 2026-04-24 termination-precedence decision): MAX_TIER does NOT
      // stop the ticker — attemptTierEscalation caps nextTier at
      // MAX_TIER, re-sweeps there, and returns. Subsequent cascades
      // re-sweep at MAX_TIER again (throttled by MIN_MS_BETWEEN_SWEEPS).
      // Only hard caps (commitsCap / todosCap / minutesCap) or a manual
      // stop end the run.
      if (!state.resweepInFlight) {
        state.resweepInFlight = true;
        void attemptTierEscalation(state);
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
  // Role-imbalance watchdog (PATTERN_DESIGN/role-differentiated.md I2).
  // Cheap (single SQL read + per-role aggregation); throttled by run-
  // age + last-warn timestamp so a persistent imbalance doesn't spam.
  void checkRoleImbalance(s);
  // Fire per-session ticks without awaiting. Each has its own inFlight
  // guard, so slow sessions don't block fast ones. Orchestrator-worker
  // runs skip the orchestrator — it's the planner, not a worker.
  for (const sessionID of s.sessionIDs) {
    if (s.orchestratorSessionID && sessionID === s.orchestratorSessionID) {
      continue;
    }
    void tickSession(s, sessionID);
  }
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
