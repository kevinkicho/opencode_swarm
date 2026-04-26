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

import { deriveRunRow, getRun, updateRunMeta } from '../swarm-registry';
import { abortSessionServer } from '../opencode-server';
import {
  detectRecentZen429,
  formatRetryAfter,
} from '../zen-rate-limit-probe';
import { maybeRestartOpencode } from '../opencode-restart';
import { liveExports, publishExports } from '../hmr-exports';
import {
  COORDINATOR_EXPORTS_KEY,
  tickCoordinator,
  waitForSessionIdle,
  type CoordinatorExports,
  type TickOutcome,
} from './coordinator';
import {
  MAX_TIER,
  PLANNER_EXPORTS_KEY,
  runPlannerSweep,
  TIER_LADDER,
  type PlannerExports,
} from './planner';
import { attemptColdFileSeeding } from './cold-file-seed';
import { listBoardItems } from './store';
import { persistTickerSnapshot } from './ticker-snapshots';
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
  snapshot,
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
export { AUTO_TICKER_EXPORTS_KEY, listAutoTickers, getTickerSnapshot };

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
// 2026-04-23 overnight run hit this at ~01:15: every sweep queued to
// stuck sessions, no LLM output, run dead for 4 hours until human
// intervention. Silent because our code-side signals (ticker firing,
// HTTP 200s on reads) all looked fine.
const LIVENESS_CHECK_INTERVAL_MS = 60_000;
// If tokens haven't moved for this long AND we've seen tokens produce
// before, declare frozen. Chosen at 10 min because legitimate long
// turns can go 5-10 min without a token update on slow tool calls;
// shorter thresholds trip false positives.
const FROZEN_TOKENS_THRESHOLD_MS = 10 * 60 * 1000;
// If a brand-new run produces zero tokens for this long, also declare
// frozen. Planner should emit within ~90s; actual worker turns start
// within 2 min. 15 min is generous — any run not making any noise by
// then is broken in a way worth stopping.
const STARTUP_GRACE_MS = 15 * 60 * 1000;

// Stage 2 hard-cap defaults (ollama-swarm spec: "hard caps fire
// whichever first: wall-clock default 8h, 200 commits, 300 todos").
// Effective caps are max(meta.bounds.<cap>, default). Per-run override
// is authoritative when set; defaults keep hands-off runs from running
// forever at MAX_TIER when the ambition ratchet can't self-exhaust
// anymore (Stage 2 removed the tierExhausted → stop path).
const DEFAULT_WALLCLOCK_MINUTES = 8 * 60; // 8h
const DEFAULT_COMMITS_CAP = 200;
const DEFAULT_TODOS_CAP = 300;

// MAX_ORCHESTRATOR_REPLANS now lives in auto-ticker/policies.ts alongside
// orchestratorReplanCapHit (its only consumer outside this file's
// log-message strings).


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

// Tier-escalating planner sweep (ambition ratchet). On auto-idle the
// ticker asks the planner for work at the next tier of ambition rather
// than stopping. If the escalation seeds items → reset idle counters +
// record the new tier. If it produces zero → bump tier anyway so the
// next cascade tries the tier above; at MAX_TIER, flip `tierExhausted`
// so the next cascade stops for real. See SWARM_PATTERNS.md "Tiered
// execution" for the full contract; memory/project_ambition_ratchet.md
// for the design decision context.
async function attemptTierEscalation(state: TickerState): Promise<void> {
  const swarmRunID = state.swarmRunID;

  // PATTERN_DESIGN/orchestrator-worker.md I1 — hard cap on re-plan
  // loops. Only enforced for orchestrator-worker. Self-organizing
  // patterns can re-plan freely. Read meta on the same path we use
  // elsewhere (~ms cost; the cap check is rare).
  if (await orchestratorReplanCapHit(swarmRunID)) {
    console.warn(
      `[board/auto-ticker] ${swarmRunID}: orchestrator hit MAX_ORCHESTRATOR_REPLANS=${MAX_ORCHESTRATOR_REPLANS} — stopping ticker (replan-loop-exhausted)`,
    );
    stopAutoTicker(swarmRunID, 'replan-loop-exhausted');
    return;
  }

  state.lastSweepAtMs = Date.now();
  // `candidate` = what we'd escalate to naturally; `clampedNextTier`
  // is the bounded value used for the actual sweep. At MAX_TIER the
  // two diverge — candidate might be 6 but we re-sweep at 5 again
  // (Stage 2 MAX_TIER continuity — user's 2026-04-24 precedence call).
  const candidate = state.currentTier + 1;
  const clampedNextTier = Math.min(candidate, MAX_TIER);
  const tierLabel =
    TIER_LADDER.find((t) => t.tier === clampedNextTier)?.name ?? `Tier ${clampedNextTier}`;
  try {
    if (clampedNextTier === state.currentTier) {
      console.log(
        `[board/auto-ticker] ${swarmRunID}: at MAX_TIER=${MAX_TIER} — re-sweeping at tier ${MAX_TIER} instead of escalating. Run continues until a hard cap or manual stop.`,
      );
    }
    console.log(
      `[board/auto-ticker] ${swarmRunID}: attempting tier escalation ${state.currentTier} → ${clampedNextTier} (${tierLabel})`,
    );
    // Stage 2 audit: run a pre-escalation audit so the next sweep's
    // prompt context carries fresh verdicts (criteriaSummaries surface
    // MET / UNMET / WONT_DO tags). Await it — the verdicts are an
    // input to the tier-N+1 planner prompt; firing asynchronously
    // would let the sweep run without them.
    await maybeRunAudit(state, 'tier-escalation');

    const beforeOpen = listBoardItems(swarmRunID).filter(
      (i) => i.status === 'open',
    ).length;
    // overwrite: true so the "board already populated" guard in the
    // planner doesn't throw — the board intentionally has items at this
    // point (the drained initial batch). includeBoardContext: true so
    // the planner sees what's already done/pending and proposes new
    // work instead of duplicates. escalationTier routes to the tier-
    // aware prompt variant.
    const result = await livePlanner().runPlannerSweep(swarmRunID, {
      overwrite: true,
      includeBoardContext: true,
      escalationTier: clampedNextTier,
    });
    const afterOpen = listBoardItems(swarmRunID).filter(
      (i) => i.status === 'open',
    ).length;
    const newlyOpen = afterOpen - beforeOpen;
    if (newlyOpen > 0) {
      console.log(
        `[board/auto-ticker] ${swarmRunID}: tier-${clampedNextTier} escalation seeded ${newlyOpen} new todo(s) — resetting idle counters`,
      );
      state.currentTier = clampedNextTier;
      for (const slot of state.slots.values()) slot.consecutiveIdle = 0;
    } else {
      // This tier had nothing to propose. Before bumping or exhausting,
      // try cold-file seeding (PATTERN_DESIGN/stigmergy.md I3) — there
      // may be untouched workspace files the swarm hasn't explored.
      // If that seeds work, keep the run alive at the current tier.
      let coldSeeded = 0;
      try {
        coldSeeded = await attemptColdFileSeeding(swarmRunID);
      } catch (err) {
        console.warn(
          `[board/auto-ticker] ${swarmRunID}: cold-file seeding threw:`,
          err instanceof Error ? err.message : String(err),
        );
      }
      if (coldSeeded > 0) {
        console.log(
          `[board/auto-ticker] ${swarmRunID}: tier-${clampedNextTier} produced no work but cold-file seeder added ${coldSeeded} exploration todo(s) — resetting idle counters`,
        );
        for (const slot of state.slots.values()) slot.consecutiveIdle = 0;
      } else {
        // No tier proposal AND no cold files left. Bump tier to retry
        // higher; at MAX_TIER mark exhausted so the next cascade stops.
        console.log(
          `[board/auto-ticker] ${swarmRunID}: tier-${clampedNextTier} escalation produced no work (planner returned ${result.items.length} item(s) total); cold-file seeder also produced 0`,
        );
        state.currentTier = clampedNextTier;
        if (clampedNextTier >= MAX_TIER) {
          state.tierExhausted = true;
        }
      }
    }
    // Persist the new tier to meta.json so a ticker restart can resume
    // at the current tier instead of dropping back to 1. Fire-and-
    // forget: a failed write isn't worth stalling the ticker for, and
    // the next successful bump will overwrite anyway.
    void updateRunMeta(swarmRunID, { currentTier: state.currentTier }).catch(
      (err) => {
        console.warn(
          `[board/auto-ticker] ${swarmRunID}: tier persist failed:`,
          err instanceof Error ? err.message : String(err),
        );
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[board/auto-ticker] ${swarmRunID}: tier-${clampedNextTier} escalation threw:`,
      message,
    );
    // Don't bump tier on exception — a transient opencode / network error
    // shouldn't burn a tier. The idle cascade will retry on the next
    // tick-cycle subject to MIN_MS_BETWEEN_SWEEPS throttling.
  } finally {
    state.resweepInFlight = false;
  }
}

// Hard-cap check — Stage 2. Called after each successful commit and
// before each tick. Returns true if a cap breached; caller stops the
// ticker. Reads meta lazily (caller paths are hot enough that we
// benefit from not forcing a getRun on every tick).
//
// Three dimensions, any of which triggers stop:
//   - wall-clock (ms since state.startedAtMs) vs minutesCap
//   - totalCommits vs commitsCap
//   - count of kind='todo' board items vs todosCap
//
// All three default to the ollama-swarm spec's values when meta.bounds
// doesn't override; users who want longer / larger runs set per-run
// caps explicitly. costCap is NOT checked here — the opencode proxy
// gate at app/api/opencode/[...path]/route.ts owns that dimension
// (it 402s the prompt before the model turn spends tokens).
async function checkHardCaps(state: TickerState): Promise<boolean> {
  if (state.stopped) return false;
  const meta = await getRun(state.swarmRunID).catch(() => null);
  if (!meta) return false;

  const minutesCap = meta.bounds?.minutesCap ?? DEFAULT_WALLCLOCK_MINUTES;
  const commitsCap = meta.bounds?.commitsCap ?? DEFAULT_COMMITS_CAP;
  const todosCap = meta.bounds?.todosCap ?? DEFAULT_TODOS_CAP;

  const elapsedMs = Date.now() - state.startedAtMs;
  const elapsedMinutes = elapsedMs / 60_000;
  if (elapsedMinutes >= minutesCap) {
    console.log(
      `[board/auto-ticker] ${state.swarmRunID}: wall-clock cap breached — ${Math.round(elapsedMinutes)}min >= ${minutesCap}min. Stopping.`,
    );
    stopAutoTicker(state.swarmRunID, 'wall-clock-cap');
    return true;
  }

  if (state.totalCommits >= commitsCap) {
    console.log(
      `[board/auto-ticker] ${state.swarmRunID}: commits cap breached — ${state.totalCommits} >= ${commitsCap}. Stopping.`,
    );
    stopAutoTicker(state.swarmRunID, 'commits-cap');
    return true;
  }

  // Todos seen = count of kind='todo' board items (any status). Cheap
  // enough at prototype scale (hundreds of items in-memory).
  const todoCount = listBoardItems(state.swarmRunID).filter(
    (i) => i.kind === 'todo',
  ).length;
  if (todoCount >= todosCap) {
    console.log(
      `[board/auto-ticker] ${state.swarmRunID}: todos cap breached — ${todoCount} >= ${todosCap} authored. Stopping.`,
    );
    stopAutoTicker(state.swarmRunID, 'todos-cap');
    return true;
  }

  return false;
}

// Liveness check — the opencode-frozen watchdog. Polls token growth on
// a fresh deriveRunRow call; compares to the last check. Declares frozen
// and stops the ticker in two cases:
//   - tokens > 0 has been observed, but tokens haven't advanced for
//     FROZEN_TOKENS_THRESHOLD_MS (opencode was alive but went silent)
//   - tokens === 0 and the ticker has been running for STARTUP_GRACE_MS
//     (startup freeze — opencode never started producing)
// Fire-and-forget via setInterval; per-run single-flight via the timer.
// Errors inside the check log and exit without stopping the ticker — a
// transient opencode read failure shouldn't kill a healthy run.
async function checkLiveness(state: TickerState): Promise<void> {
  if (state.stopped) return;
  // Stage 2 hard-cap check piggy-backs on the liveness interval. The
  // commit-time check in tickSession covers burst overruns; this
  // catches wall-clock breaches on runs that go quiet (no 'picked'
  // outcomes for an extended window) but have been running long
  // enough to trip the minutes cap.
  if (await checkHardCaps(state)) return;
  try {
    const meta = await getRun(state.swarmRunID);
    if (!meta) return;
    const row = await deriveRunRow(meta);
    const tokens = row.tokensTotal ?? 0;
    const now = Date.now();

    if (tokens === 0) {
      // Nothing produced yet — grace period before calling it frozen.
      const age = now - state.startedAtMs;
      if (age >= STARTUP_GRACE_MS) {
        const rl = await detectRecentZen429();
        if (rl.found) {
          if (rl.retryAfterSec && rl.retryAfterSec > 0) {
            state.retryAfterEndsAtMs = Date.now() + rl.retryAfterSec * 1000;
          }
          console.warn(
            `[board/auto-ticker] ${state.swarmRunID}: zen-rate-limit (startup) — 0 tokens after ${Math.round(age / 60_000)}min; most recent 429 at ${new Date(rl.lastHitAt!).toISOString()}, retry-after ${formatRetryAfter(rl.retryAfterSec)}. Stopping ticker; self-heals once quota clears.`,
          );
          stopAutoTicker(state.swarmRunID, 'zen-rate-limit');
        } else {
          console.warn(
            `[board/auto-ticker] ${state.swarmRunID}: opencode-frozen (startup) — 0 tokens after ${Math.round(age / 60_000)}min, no recent 429 in the log. Stopping ticker. Restart opencode + the ticker to recover.`,
          );
          stopAutoTicker(state.swarmRunID, 'opencode-frozen');
          maybeRestartOpencode(`${state.swarmRunID} (startup freeze)`);
        }
      }
      return;
    }

    if (tokens !== state.lastSeenTokens) {
      // Progress! Reset the clock.
      state.lastSeenTokens = tokens;
      state.lastTokensChangedAtMs = now;
      return;
    }

    // Tokens stuck. If long enough, declare frozen — but first check
    // if the opencode log shows a recent 429. That's self-healing
    // (wait out retry-after) and warrants a different stop reason so
    // the UI can surface a useful "retry 5h" instead of a generic
    // "process dead" message.
    const stuckFor = now - state.lastTokensChangedAtMs;
    if (stuckFor >= FROZEN_TOKENS_THRESHOLD_MS) {
      const rl = await detectRecentZen429();
      if (rl.found) {
        if (rl.retryAfterSec && rl.retryAfterSec > 0) {
          state.retryAfterEndsAtMs = Date.now() + rl.retryAfterSec * 1000;
        }
        console.warn(
          `[board/auto-ticker] ${state.swarmRunID}: zen-rate-limit — no token delta in ${Math.round(stuckFor / 60_000)}min (tokens at ${tokens}); most recent 429 at ${new Date(rl.lastHitAt!).toISOString()}, retry-after ${formatRetryAfter(rl.retryAfterSec)}. Stopping ticker; self-heals once quota clears.`,
        );
        stopAutoTicker(state.swarmRunID, 'zen-rate-limit');
      } else {
        console.warn(
          `[board/auto-ticker] ${state.swarmRunID}: opencode-frozen — no token delta in ${Math.round(stuckFor / 60_000)}min (tokens stuck at ${tokens}), no recent 429 in the log. Stopping ticker. Restart opencode + the ticker to recover.`,
        );
        stopAutoTicker(state.swarmRunID, 'opencode-frozen');
        maybeRestartOpencode(`${state.swarmRunID} (mid-run freeze)`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[board/auto-ticker] ${state.swarmRunID}: liveness check threw:`,
      message,
    );
  }
}

// Long-running cadenced planner sweep. Unlike attemptTierEscalation
// (auto-idle path that bumps tier per attempt), this fires on a timer
// regardless of whether the board is idle — the point is to periodically
// re-examine the repo as it evolves under the workers' edits and seed
// fresh todos the original planner pass couldn't see. Reuses
// `resweepInFlight` as a mutex with the escalation path so the two
// can't collide. Periodic sweeps do NOT bump tier today — they stay
// at whatever `currentTier` the run has reached via escalation. Tying
// periodic-mode to tier escalation is a future layer.
async function runPeriodicSweep(state: TickerState): Promise<void> {
  if (state.stopped) return;
  if (state.resweepInFlight) return;

  // PATTERN_DESIGN/orchestrator-worker.md I1 — same cap as the
  // tier-escalation path. A long-running orchestrator-worker run
  // can rack up sweeps via either path; the cap counts both.
  if (await orchestratorReplanCapHit(state.swarmRunID)) {
    console.warn(
      `[board/auto-ticker] ${state.swarmRunID}: orchestrator hit MAX_ORCHESTRATOR_REPLANS=${MAX_ORCHESTRATOR_REPLANS} — periodic sweep skipped, stopping ticker (replan-loop-exhausted)`,
    );
    stopAutoTicker(state.swarmRunID, 'replan-loop-exhausted');
    return;
  }
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
  // Post-sweep flag: true when the periodic sweep produced no new
  // work AND the board carries no active items. Escalation fires
  // after the mutex is released (see block below) so it can
  // re-acquire cleanly via attemptTierEscalation's own flag handling.
  let shouldTryEscalation = false;
  try {
    const beforeOpen = listBoardItems(swarmRunID).filter(
      (i) => i.status === 'open',
    ).length;
    // overwrite: true bypasses the "board already populated" planner
    // guard. includeBoardContext: true feeds the planner the already-
    // done list so it stops re-proposing stale items — critical over an
    // 8h run where the same things would otherwise get suggested 24×.
    const result = await livePlanner().runPlannerSweep(swarmRunID, {
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
      state.consecutiveDrainedSweeps = 0;
    } else {
      console.log(
        `[board/auto-ticker] ${swarmRunID}: periodic sweep produced no new work (planner returned ${result.items.length} total items)`,
      );
      // Count this as "drained" only if workers are also done — if
      // there's active work, the planner-is-quiet state is normal
      // (workers are still chewing through the last sweep's output).
      //
      // PATTERN_DESIGN/blackboard.md I2 — retry-exhausted ratchet
      // re-kick. Open items carrying a `[retry:N]` note where N≥2
      // are workers-refused-twice, not active work. Treating them as
      // "active" stranded run_mob31bx6_jzdfs2 — the ratchet stayed
      // dormant because the predicate said "work available" while
      // every worker had already declined. Exclude retry-exhausted
      // open items from the active count so the next sweep can
      // either rephrase them at a higher tier or drop them.
      const activeCount = listBoardItems(swarmRunID).filter((i) => {
        if (
          i.status !== 'open' &&
          i.status !== 'claimed' &&
          i.status !== 'in-progress'
        ) {
          return false;
        }
        if (i.status === 'open' && isRetryExhausted(i.note)) {
          return false;
        }
        return true;
      }).length;
      if (activeCount === 0) {
        state.consecutiveDrainedSweeps += 1;
        if (
          state.consecutiveDrainedSweeps >= PERIODIC_DRAIN_TIER_THRESHOLD &&
          !state.tierExhausted
        ) {
          shouldTryEscalation = true;
        }
      } else {
        state.consecutiveDrainedSweeps = 0;
      }
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
  // Periodic-mode tier escalation: fire AFTER the mutex is released so
  // attemptTierEscalation's own flag management (set-at-entry-via-
  // caller convention) doesn't conflict. Resets the drained counter
  // immediately so we don't re-fire on the next sweep if the
  // escalation itself produces empty.
  if (shouldTryEscalation) {
    console.log(
      `[board/auto-ticker] ${swarmRunID}: ${state.consecutiveDrainedSweeps}+ drained periodic sweeps and zero active board items — firing tier escalation from periodic-mode`,
    );
    state.consecutiveDrainedSweeps = 0;
    state.resweepInFlight = true;
    await attemptTierEscalation(state);
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

  // Stage 2 audit: final contract verdict before teardown, so the
  // archived run's board has a clean MET / UNMET / WONT_DO state on
  // every criterion. Fire-and-forget — stop is synchronous and we
  // don't want a slow auditor call to delay the abort cascade. The
  // auditor's per-run mutex will serialize against any in-flight
  // audit; criteria the audit doesn't finish in time stay open for
  // when the run is resumed or archived as-is.
  //
  // Guarded by s.stopped=false check below to avoid firing on a
  // redundant stopAutoTicker call for an already-stopped run.
  void maybeRunAudit(s, 'run-end');

  s.stopped = true;
  s.stoppedAtMs = Date.now();
  s.stopReason = reason;

  // PATTERN_DESIGN/blackboard.md I3 — persist the final snapshot to
  // SQLite so getTickerSnapshot can reconstruct a stopped-state
  // response after dev restart / HMR. Synchronous + cheap (single
  // INSERT/REPLACE); failure here is logged but doesn't block the
  // stop sequence below.
  try {
    persistTickerSnapshot(swarmRunID, s.stoppedAtMs, reason, snapshot(s) as unknown as Record<string, unknown>);
  } catch (err) {
    console.warn(
      `[board/auto-ticker] ${swarmRunID}: ticker snapshot persist failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  if (s.periodicSweepTimer) clearInterval(s.periodicSweepTimer);
  s.periodicSweepTimer = null;
  if (s.livenessTimer) clearInterval(s.livenessTimer);
  s.livenessTimer = null;

  // Fire-and-forget abort on every session associated with this run.
  // Purpose: ensure no opencode assistant turn keeps streaming tokens
  // into the void after the coordinator has given up on it. A turn
  // already completed is a no-op; one in flight gets cancelled.
  //
  // Includes the critic session when present — it's outside sessionIDs
  // (workers-only pool) but equally capable of hanging a turn if a review
  // was in flight when the run was stopped.
  //
  // abortSessionServer is swallowed per-call; if opencode is down or
  // the session no longer exists the stop still completes. We never
  // block the stop path on opencode reachability — that would defeat
  // the point of the liveness watchdog.
  void (async () => {
    const meta = await getRun(swarmRunID).catch(() => null);
    if (!meta) return;
    const targets = [...meta.sessionIDs];
    if (meta.criticSessionID) targets.push(meta.criticSessionID);
    if (meta.verifierSessionID) targets.push(meta.verifierSessionID);
    if (meta.auditorSessionID) targets.push(meta.auditorSessionID);
    await Promise.allSettled(
      targets.map((sid) =>
        abortSessionServer(sid, meta.workspace).catch(() => undefined),
      ),
    );
    console.log(
      `[board/auto-ticker] ${swarmRunID}: stop(${reason}) aborted ${targets.length} session(s)`,
    );
  })();
}


// Publish to globalThis so in-flight setInterval callbacks resolve to
// the latest fanout / runPeriodicSweep / checkLiveness on their next
// tick, even when HMR replaces this module mid-run.
publishExports<AutoTickerExports>(AUTO_TICKER_EXPORTS_KEY, {
  fanout,
  runPeriodicSweep,
  checkLiveness,
});
