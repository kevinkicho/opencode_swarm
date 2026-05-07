// Per-tick fan-out logic — the heartbeat that turns the timer fire into
// a per-session tickCoordinator dispatch. Lives separately from the
// timer machinery (lifecycle in index.ts) so the dispatch can be
// reasoned about without the setInterval / state-bootstrap noise.
//
// Extracted from auto-ticker.ts in #106 phase 5.

import 'server-only';

import { liveExports } from '../../hmr-exports';
import { getRun } from '../../swarm-registry';
import { emitTickerTick } from '../bus';
import { listBoardItems } from '../store';
import { maybeRunAudit } from './audit';
import { checkHardCaps } from './hard-caps';
import { liveCoordinator } from './live-exports';
import { checkLiveness } from './liveness';
import { snapshot, tickers } from './state';
import { runPeriodicSweep } from './sweep';
import { stopAutoTicker } from './stop';
import {
  AUTO_TICKER_EXPORTS_KEY,
  IDLE_TICKS_BEFORE_EAGER_SWEEP,
  IDLE_TICKS_BEFORE_STOP,
  MIN_MS_BETWEEN_SWEEPS,
  type AutoTickerExports,
  type PerSessionSlot,
  type TickerState,
} from './types';
import { attemptTierEscalation, boardHasWorkInFlight } from './escalation';
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
  // Two concurrent fanout() callers can both pass the first guard, both
  // await getRun, and both reach this block. The inner write of
  // `state.sessionIDs` and `state.slots` is content-deterministic
  // (same meta.sessionIDs, same makeSlot output), so racing produces
  // an identical state. Future edits MUST preserve this property —
  // do not introduce non-idempotent writes (e.g., counters, side-
  // effecting allocations) into this block without an explicit lock.
  if (state.sessionIDs.length === 0) {
    state.sessionIDs = [...meta.sessionIDs];
    for (const sid of state.sessionIDs) {
      if (!state.slots.has(sid)) state.slots.set(sid, makeSlot(sid));
    }
  }
  // Hydrate currentTier from persisted meta so a ticker restart resumes
  // at the tier where the previous one left off.
  if (typeof meta.currentTier === 'number' && meta.currentTier > state.currentTier) {
    state.currentTier = meta.currentTier;
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
    // Two paths now (refined 2026-04-27 after live OW test ran to
    // wall-clock cap with 5/5 todos done):
    //
    // (a) Plain auto-idle — periodicSweepMs === 0. Original path:
    //     every session idle for IDLE_TICKS_BEFORE_STOP ticks → stop.
    //
    // (b) Drained-and-idle — periodicSweepMs > 0 BUT the board has zero
    //     work-class items in flight (no open todos, no claims, no
    //     in-progress). Without this, OW with persistent re-sweeps
    //     keeps the ticker alive after the planner's todos are all
    //     done, even though no re-sweep would dispatch new work
    //     before the wall-clock cap fires. The drained check requires
    //     the same idle-threshold so a transient gap between two
    //     workers' commits doesn't trigger a premature stop.
    // The orchestrator slot in OW runs never ticks (excluded from
    // worker dispatch via state.orchestratorSessionID), so its
    // consecutiveIdle stays at 0 forever. Including it in the
    // every() check means auto-idle never fires for OW. Exclude.
    const tickingSlots = state.orchestratorSessionID
      ? slots.filter((s) => s.sessionID !== state.orchestratorSessionID)
      : slots;
    const allSessionsIdle =
      tickingSlots.length > 0 &&
      tickingSlots.every((s) => s.consecutiveIdle >= IDLE_TICKS_BEFORE_STOP);

    if (state.periodicSweepMs === 0 && allSessionsIdle) {
      // Even short runs (no periodic sweep) get one shot at escalation.
      // If the board is drained at the current tier, attempt to bump.
      const hasWork = boardHasWorkInFlight(state.swarmRunID);
      if (!hasWork) {
        const escalated = await attemptTierEscalation(state).catch(() => false);
        if (!escalated) {
          stopAutoTicker(state.swarmRunID, 'auto-idle');
        }
      } else {
        stopAutoTicker(state.swarmRunID, 'auto-idle');
      }
    } else if (state.periodicSweepMs > 0 && allSessionsIdle) {
      // Periodic-sweep mode: board-drained check with ambition ratchet,
      // BUT do NOT auto-stop. A zero-work board means the workers finished
      // their batch — the next periodic sweep will produce fresh work.
      //
      // The only stop signals in persistent mode are:
      //   - explicit operator stop (POST /stop)
      //   - process shutdown (parent-signal kill)
      //   - commits-cap / wall-clock-cap enforcement (future)
      //
      // Attempt tier escalation — if the planner produces fresh work at a
      // higher tier, workers pick it up on the next tick. If not (or
      // already at max tier), we just stay idle until the periodic sweep
      // timer fires.
      const escalated = await attemptTierEscalation(state).catch(() => false);
      if (!escalated) {
        // Not an error — the board is just empty for now. The periodic
        // sweep timer will fire and re-evaluate.
        console.log(
          `[board/auto-ticker] ${state.swarmRunID}: board drained, all sessions idle, but periodicSweepMs=${state.periodicSweepMs} — staying alive for next sweep`,
        );
      }
      // If escalated, the next tick cycle will see fresh open items
      // and reset idle counters, so the run continues at the new tier.
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
    // Emit a ticker tick so the run page's `useLiveTicker` SSE consumer
    // can update without polling /board/ticker. Skip if the ticker has
    // already been stopped (stopAutoTicker emits its own final snapshot,
    // and hard-caps can stop mid-tick — this avoids a duplicate emission).
    if (!state.stopped) {
      emitTickerTick(state.swarmRunID, snapshot(state));
    }
  }
}

export async function fanout(swarmRunID: string): Promise<void> {
  const s = tickers().get(swarmRunID);
  if (!s || s.stopped) return;
  const ready = await ensureSlots(s);
  if (!ready) return;
  // Re-check after the await — could have been stopped while resolving run.
  if (s.stopped) return;
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
