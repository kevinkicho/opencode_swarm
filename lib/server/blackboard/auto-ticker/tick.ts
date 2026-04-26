// Per-tick fan-out logic — the heartbeat that turns the timer fire into
// a per-session tickCoordinator dispatch. Lives separately from the
// timer machinery (lifecycle in index.ts) so the dispatch can be
// reasoned about without the setInterval / state-bootstrap noise.
//
// Extracted from auto-ticker.ts in #106 phase 5.

import { liveExports } from '../../hmr-exports';
import { getRun } from '../../swarm-registry';
import { maybeRunAudit } from './audit';
import { checkHardCaps } from './hard-caps';
import { liveCoordinator } from './live-exports';
import { checkLiveness } from './liveness';
import { checkRoleImbalance } from './policies';
import { tickers } from './state';
import { runPeriodicSweep } from './sweep';
import { attemptTierEscalation } from './tier-escalation';
import {
  AUTO_TICKER_EXPORTS_KEY,
  IDLE_TICKS_BEFORE_EAGER_SWEEP,
  IDLE_TICKS_BEFORE_STOP,
  MIN_MS_BETWEEN_SWEEPS,
  type AutoTickerExports,
  type PerSessionSlot,
  type TickerState,
} from './types';
import type { TickOutcome } from '../coordinator';

// Re-export the AutoTickerExports lookup so the eager-sweep path inside
// tickSession routes through the latest globalThis-published references
// after HMR. Falls back to the direct imports above when nothing has
// published yet (unusual — index.ts publishes at module load).
function liveAutoTicker(): AutoTickerExports {
  return liveExports<AutoTickerExports>(AUTO_TICKER_EXPORTS_KEY, {
    fanout,
    runPeriodicSweep,
    checkLiveness,
  });
}

// Is this outcome quiescent (no forward progress possible right now)?
// `picked` is real progress (a todo committed). Most `stale` outcomes
// are also progress signals — the session attempted work and either
// hit CAS-drift (lost the file race) or had its turn timeout. Both
// reset the idle counter because "the session is still trying".
//
// EXCEPT phantom-no-tools (#7.Q42 #7.Q45): when the worker produced
// only text-only pseudo-tool-XML with zero real tool/patch parts, the
// session is NOT trying — it's emitting placeholder text and burning
// retries. Treating that as progress means the auto-stop threshold
// never trips and the run spins forever. Count phantom-no-tools as
// idle so consecutive bounces eventually trigger auto-stop / tier
// escalation, same as `skipped`.
function isIdleOutcome(o: TickOutcome): boolean {
  if (o.status === 'skipped') return true;
  if (o.status === 'stale' && o.reason.includes('phantom-no-tools')) {
    return true;
  }
  return false;
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

export async function fanout(swarmRunID: string): Promise<void> {
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
