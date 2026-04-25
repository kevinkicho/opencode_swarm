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

import { deriveRunRow, getRun, listRuns, updateRunMeta } from '../swarm-registry';
import { abortSessionServer } from '../opencode-server';
import {
  detectRecentZen429,
  formatRetryAfter,
} from '../zen-rate-limit-probe';
import { pruneDemoLog } from '../demo-log-retention';
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
import { listBoardItems, transitionStatus } from './store';
import { listPlanRevisions } from './plan-revisions';
import {
  persistTickerSnapshot,
  readTickerSnapshot,
} from './ticker-snapshots';
import { auditCriteria } from './auditor';
import { prewarmModels } from './model-prewarm';

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
const AUTO_TICKER_EXPORTS_KEY = Symbol.for(
  'opencode_swarm.auto_ticker.exports',
);
interface AutoTickerExports {
  fanout: (swarmRunID: string) => Promise<void>;
  runPeriodicSweep: (state: TickerState) => Promise<void>;
  checkLiveness: (state: TickerState) => Promise<void>;
}
function liveAutoTicker(): AutoTickerExports {
  return liveExports<AutoTickerExports>(AUTO_TICKER_EXPORTS_KEY, {
    fanout,
    runPeriodicSweep,
    checkLiveness,
  });
}

const DEFAULT_INTERVAL_MS = 10_000;
const IDLE_TICKS_BEFORE_STOP = 6;

// Eager re-sweep threshold. When every session has been idle for this many
// ticks AND we're in long-running mode (periodicSweepMs > 0) AND the last
// sweep was long enough ago, fire a fresh planner sweep immediately
// instead of waiting for the periodic timer. Practical effect: 10-15 todos
// drain in ~5 min, sessions go idle, 30s later a new batch lands — no more
// sitting idle for 15 min waiting for the 20-min periodic tick.
const IDLE_TICKS_BEFORE_EAGER_SWEEP = 3;

// How many consecutive periodic sweeps must produce "no new work AND
// no active board items" before we escalate tiers in periodic-mode.
// At the default 20-min sweep cadence, 2 means ~40 min of drained
// quiet before the ratchet climbs. 1 would trigger on a single
// transient quiet; 2 requires the planner to really be out of ideas
// AND workers to genuinely have nothing left.
const PERIODIC_DRAIN_TIER_THRESHOLD = 2;

// Floor on how frequently sweeps fire. Even if the board drains instantly,
// the planner needs ~60-90s per sweep, and stacking sweeps back-to-back
// would burn tokens on constant re-planning and race the "overwrite guard"
// in runPlannerSweep. 2 minutes gives the previous sweep time to fully
// land its new todos before the next one starts reasoning about them.
const MIN_MS_BETWEEN_SWEEPS = 2 * 60 * 1000;

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

export type StopReason =
  | 'auto-idle'
  | 'manual'
  | 'opencode-frozen'
  | 'zen-rate-limit'
  // Stage 2 hard-cap enforcement (wall-clock / commits / todos). The
  // ollama-swarm spec's "hard caps fire whichever first" — a ceiling
  // above which the run stops regardless of what the auditor or
  // planner say. Absent per-run overrides default to 8h / 200 / 300.
  | 'hard-cap'
  // PATTERN_DESIGN/orchestrator-worker.md I1. The orchestrator pattern
  // can loop forever if every re-plan sweep proposes work that workers
  // stale out (file contention, complexity underestimation). This cap
  // bounds the loop at MAX_ORCHESTRATOR_REPLANS sweeps; the run stops
  // with this reason and the run-health banner surfaces it for human
  // intervention. Self-organizing patterns are uncapped — they don't
  // exhibit this failure mode.
  | 'replan-loop-exhausted';

// PATTERN_DESIGN/orchestrator-worker.md I1. The cap counts ALL planner
// sweeps for the run (initial + re-plans), so MAX_ORCHESTRATOR_REPLANS
// = 6 means 1 initial + 5 re-plans before forced stop. Tuned generous
// because legit orchestrator runs do iterate plans as workers reveal
// scope; the cap exists for the pathological loop, not normal use.
const MAX_ORCHESTRATOR_REPLANS = 6;

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
  // Re-sweep bookkeeping / ambition ratchet state. When every session hits
  // the idle threshold we don't just stop — we try a tier-escalation
  // planner sweep first. `resweepInFlight` guards against re-entrant
  // planner calls from concurrent session ticks all hitting idle at once
  // (also used as the mutex by runPeriodicSweep so the two can't stack).
  // `currentTier` tracks where the ambition ratchet is — starts at 1
  // (the initial sweep's tier); each auto-idle escalation tries tier+1.
  // `tierExhausted` goes true when an escalation at MAX_TIER produced
  // zero items — then the next idle cascade actually stops. See
  // SWARM_PATTERNS.md "Tiered execution" for the full semantics.
  resweepInFlight: boolean;
  currentTier: number;
  tierExhausted: boolean;
  // Audit cadence state (Stage 2 declared-roles). Counts successful
  // 'picked' outcomes (todo committed to done) since the last audit;
  // when it hits state.auditEveryNCommits, maybeRunAudit fires a
  // batch audit pass across pending criteria and resets. auditInFlight
  // guards against re-entrant audit calls (the per-run mutex in
  // auditor.ts would serialize them anyway, but this avoids queueing
  // redundant audits while one is already running).
  commitsSinceLastAudit: number;
  auditInFlight: boolean;
  auditEveryNCommits: number;
  // Stage 2 hard-cap counters. totalCommits is a monotonic counter of
  // successful 'picked' outcomes (todos landed as done) across the run
  // — the signal for bounds.commitsCap. The todos-seen cap reads
  // directly from listBoardItems (cheaper to compute on-demand than
  // cache) so no counter field is needed for it.
  totalCommits: number;
  // Count of back-to-back periodic sweeps that produced zero new work
  // AND found the board devoid of active (open/claimed/in-progress)
  // items. Incremented in runPeriodicSweep; resets when a sweep seeds
  // items OR the board still has active work. Once this hits
  // PERIODIC_DRAIN_TIER_THRESHOLD, periodic-mode fires a tier
  // escalation — without this counter, persistent-mode runs would
  // stay at tier 1 forever since they never hit the auto-idle path.
  consecutiveDrainedSweeps: number;
  // When the liveness watchdog declared zen-rate-limit, this holds the
  // epoch-ms at which the retry-after window opencode reported in the
  // 429 response ends. Surfaced via TickerSnapshot so the UI can show
  // a live-countdown chip ("retry 3h 47m") on rate-limited runs.
  // Absent on any other stop reason.
  retryAfterEndsAtMs?: number;
  // PATTERN_DESIGN/role-differentiated.md I2 — role-imbalance watchdog
  // last-fire timestamp. Throttles repeated WARN logs to once per
  // ROLE_IMBALANCE_REPEAT_MS window so a persistent imbalance doesn't
  // spam the dev console. Absent until the first imbalance fires.
  roleImbalanceWarnedAtMs?: number;
  // Periodic re-sweep cadence for long-running runs. When > 0, fires a
  // fresh planner sweep every N ms so an overnight run keeps producing
  // work as the codebase evolves. When > 0, the auto-idle stop logic is
  // *disabled* — the ticker only stops via explicit stopAutoTicker or
  // process shutdown. A short (< periodicSweepMs) run that drains once
  // is expected to look idle-but-alive until the human shuts it down.
  // Default 0 preserves the original short-run single-sweep behavior.
  periodicSweepMs: number;
  periodicSweepTimer: NodeJS.Timeout | null;
  // Orchestrator-worker: session ID that's exempt from worker dispatch.
  // Empty string when not in orchestrator-worker mode — all sessions
  // are workers on self-organizing patterns.
  orchestratorSessionID: string;
  // Timestamp of the most recent sweep (initial, periodic, or eager). Used
  // as the MIN_MS_BETWEEN_SWEEPS floor so rapid-drain runs don't stack
  // planner calls faster than they can land.
  lastSweepAtMs: number;
  // Liveness watchdog state. livenessTimer polls opencode token growth
  // every LIVENESS_CHECK_INTERVAL_MS. lastSeenTokens / lastTokensChangedAtMs
  // detect the "opencode accepts prompts but produces nothing" failure mode
  // that killed the 2026-04-23 overnight run.
  livenessTimer: NodeJS.Timeout | null;
  lastSeenTokens: number;
  lastTokensChangedAtMs: number;
}

type TickerMap = Map<string, TickerState>;

const globalTickerKey = Symbol.for('opencode_swarm.boardAutoTickers');
const globalShutdownHookKey = Symbol.for('opencode_swarm.boardAutoTickers.shutdownHook');
const globalBootCleanupKey = Symbol.for('opencode_swarm.boardAutoTickers.bootCleanup');
type GlobalWithTickers = typeof globalThis & {
  [globalTickerKey]?: TickerMap;
  [globalShutdownHookKey]?: boolean;
  [globalBootCleanupKey]?: boolean;
};

// Horizon for startup cleanup: only runs created in the last 48 h get
// audited. Anything older is near-certainly settled (Zen 429s time out
// well before this) and aborting sessions on it just spams opencode.
// If we ever see actual bleed from older runs, widen this; for now it's
// the noise / safety tradeoff that fits the size of our registry.
const STARTUP_CLEANUP_HORIZON_MS = 48 * 60 * 60 * 1000;

// Skip-cleanup threshold: if a run shows activity within this window we
// treat it as live + hands-off, leaving the orphan-cleanup to wait for
// the next dev restart. Catches the case observed 2026-04-24 where
// dev restart fired the cleanup mid-run (planner had ~1 min idle), the
// cleanup aborted the live planner, and the user lost their actively-
// generating run. STATUS.md "auto-ticker startup-cleanup too aggressive"
// queue item.
const STARTUP_CLEANUP_RECENT_ACTIVITY_MS = 5 * 60 * 1000;

function tickers(): TickerMap {
  const g = globalThis as GlobalWithTickers;
  if (!g[globalTickerKey]) g[globalTickerKey] = new Map();
  // Startup orphan-session cleanup. Covers the SIGKILL / crash / reboot
  // gap where no shutdown handler ran and any in-flight opencode turns
  // were left burning tokens. Fires once per process, early, before the
  // user can launch a new run on top of the orphans. Restricted to runs
  // created within STARTUP_CLEANUP_HORIZON_MS so we don't spray opencode
  // with aborts on long-dead runs.
  if (!g[globalBootCleanupKey]) {
    g[globalBootCleanupKey] = true;
    void (async () => {
      try {
        const all = await listRuns();
        const cutoff = Date.now() - STARTUP_CLEANUP_HORIZON_MS;
        const recent = all.filter((m) => m.createdAt >= cutoff);
        if (recent.length > 0) {
          // Filter out runs with recent activity — those are healthy
          // (probably actively running) and aborting their sessions
          // would kill live planners. We check via deriveRunRow for
          // each recent run's lastActivityTs; if it falls inside
          // STARTUP_CLEANUP_RECENT_ACTIVITY_MS, skip. The check is
          // sequential rather than parallel because at startup there
          // are usually only a handful of recent runs and we don't
          // want to flood opencode with N parallel session lookups
          // before the actual cleanup work.
          const recentActivityCutoff =
            Date.now() - STARTUP_CLEANUP_RECENT_ACTIVITY_MS;
          const orphans: typeof recent = [];
          let skippedAlive = 0;
          for (const meta of recent) {
            try {
              const row = await deriveRunRow(meta);
              const lastActive = row.lastActivityTs ?? meta.createdAt;
              if (lastActive >= recentActivityCutoff) {
                skippedAlive += 1;
                continue;
              }
            } catch {
              // If we can't compute status (opencode unreachable for
              // this run's sessions, etc.), be conservative — fall
              // through and treat as an orphan. Status-unknown is
              // closer to dead than alive.
            }
            orphans.push(meta);
          }
          if (skippedAlive > 0) {
            console.log(
              `[board/auto-ticker] startup: skipped ${skippedAlive} run(s) with recent activity (< ${Math.round(STARTUP_CLEANUP_RECENT_ACTIVITY_MS / 60000)}m) — orphan-cleanup leaves them alone`,
            );
          }
          if (orphans.length > 0) {
            let targets = 0;
            await Promise.allSettled(
              orphans.flatMap((meta) => {
                const sids = [...meta.sessionIDs];
                if (meta.criticSessionID) sids.push(meta.criticSessionID);
                if (meta.verifierSessionID) sids.push(meta.verifierSessionID);
                if (meta.auditorSessionID) sids.push(meta.auditorSessionID);
                targets += sids.length;
                return sids.map((sid) =>
                  abortSessionServer(sid, meta.workspace).catch(() => undefined),
                );
              }),
            );
            console.log(
              `[board/auto-ticker] startup: aborted ${targets} session(s) across ${orphans.length} orphan run(s) (< ${Math.round(STARTUP_CLEANUP_HORIZON_MS / 3600000)}h old, > ${Math.round(STARTUP_CLEANUP_RECENT_ACTIVITY_MS / 60000)}m idle)`,
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[board/auto-ticker] startup cleanup failed: ${message}`);
      }
      // Demo-log retention: always-safe compress, opt-in delete. Runs
      // in the same startup pass so users don't have to remember to
      // invoke scripts/prune_demo_log.mjs manually. See
      // lib/server/demo-log-retention.ts.
      try {
        const s = await pruneDemoLog();
        if (s.scanned > 0) {
          console.log(
            `[board/auto-ticker] startup: demo-log retention — scanned=${s.scanned} compressed=${s.compressed} deleted=${s.deleted} errors=${s.errors}`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[board/auto-ticker] startup demo-log prune failed: ${message}`);
      }
    })();
  }
  // Install shutdown hook once per process so a dev-server Ctrl+C or
  // a parent-signal kill cleanly stops every live ticker — clearInterval
  // on each, flip state.stopped=true. Without this, SIGTERM dumps the
  // ticker map mid-tick with no trace. Guarded by a symbol so HMR
  // reloads don't re-register 200 listeners.
  if (!g[globalShutdownHookKey]) {
    g[globalShutdownHookKey] = true;
    // Guard so repeated signals don't re-enter the shutdown. Also
    // prevents the `beforeExit` handler from firing a second time
    // after our own async work unblocks it.
    let shuttingDown = false;
    // Hard cap on how long we'll wait for the abort HTTP calls to
    // resolve before forcing exit. Important: if opencode itself is
    // hung (the very state that often triggers a shutdown), the
    // abort calls can take the full opencode timeout. 5s keeps exit
    // snappy while still giving the quick path (opencode alive and
    // reachable) a realistic budget to finish N parallel aborts.
    const ABORT_BUDGET_MS = 5_000;
    const shutdown = async (signal: string, exitCode?: number) => {
      if (shuttingDown) return;
      shuttingDown = true;
      const map = g[globalTickerKey];
      if (!map || map.size === 0) {
        if (exitCode !== undefined) process.exit(exitCode);
        return;
      }
      console.log(
        `[board/auto-ticker] ${signal}: stopping ${map.size} ticker(s) + aborting sessions before exit`,
      );
      // Clear timers synchronously first — they'd otherwise keep the
      // event loop alive past our exit call. Then collect abort work
      // and await it with a budget so we don't hang an interactive
      // shell. fire-and-forget (our pre-b70d594 approach) loses the
      // HTTP responses when the process exits; this version actually
      // waits for opencode to acknowledge each abort.
      const aborts: Promise<unknown>[] = [];
      for (const state of map.values()) {
        if (state.stopped) continue;
        if (state.timer) clearInterval(state.timer);
        state.timer = null;
        if (state.periodicSweepTimer) clearInterval(state.periodicSweepTimer);
        state.periodicSweepTimer = null;
        if (state.livenessTimer) clearInterval(state.livenessTimer);
        state.livenessTimer = null;
        state.stopped = true;
        state.stoppedAtMs = Date.now();
        state.stopReason = 'manual';
        const swarmRunID = state.swarmRunID;
        aborts.push(
          (async () => {
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
          })(),
        );
      }
      await Promise.race([
        Promise.allSettled(aborts),
        new Promise((r) => setTimeout(r, ABORT_BUDGET_MS)),
      ]);
      console.log(
        `[board/auto-ticker] ${signal}: shutdown complete (${aborts.length} run(s) aborted or budget-timed-out)`,
      );
      if (exitCode !== undefined) process.exit(exitCode);
    };
    // SIGINT=130, SIGTERM=143 are the conventional "user interrupted"
    // exit codes. `beforeExit` fires for natural (no-signal) exits and
    // we let Node finish on its own — calling process.exit inside its
    // handler is an anti-pattern.
    process.on('SIGINT', () => void shutdown('SIGINT', 130));
    process.on('SIGTERM', () => void shutdown('SIGTERM', 143));
    process.on('beforeExit', () => void shutdown('beforeExit'));
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

// PATTERN_DESIGN/role-differentiated.md I2 — role-imbalance watchdog.
// After 15 min of run wallclock, check whether any pinned role has
// claimed zero items while another has claimed ≥ 5. Log WARN once
// per ROLE_IMBALANCE_REPEAT_MS so a persistent imbalance produces
// signal but not spam. Pattern-gated: only fires for
// `role-differentiated` runs where roles are pinned per session.
const ROLE_IMBALANCE_GRACE_MS = 15 * 60 * 1000; // 15 min wallclock
const ROLE_IMBALANCE_REPEAT_MS = 30 * 60 * 1000; // 30 min between repeats
const ROLE_IMBALANCE_BUSY_THRESHOLD = 5;
async function checkRoleImbalance(state: TickerState): Promise<void> {
  const meta = await getRun(state.swarmRunID).catch(() => null);
  if (!meta || meta.pattern !== 'role-differentiated') return;
  const ageMs = Date.now() - state.startedAtMs;
  if (ageMs < ROLE_IMBALANCE_GRACE_MS) return;
  const lastWarn = state.roleImbalanceWarnedAtMs ?? 0;
  if (Date.now() - lastWarn < ROLE_IMBALANCE_REPEAT_MS) return;

  // Aggregate per-role claimed-or-done counts from the board.
  const items = listBoardItems(state.swarmRunID);
  const byRole = new Map<string, number>();
  for (const sid of meta.sessionIDs) {
    const role = (meta.teamRoles ?? [])[meta.sessionIDs.indexOf(sid)];
    if (!role) continue;
    if (!byRole.has(role)) byRole.set(role, 0);
  }
  for (const it of items) {
    if (it.kind !== 'todo') continue;
    if (it.status === 'open') continue;
    const role = it.preferredRole;
    if (!role) continue;
    if (!byRole.has(role)) byRole.set(role, 0);
    byRole.set(role, (byRole.get(role) ?? 0) + 1);
  }
  if (byRole.size < 2) return;

  const counts = [...byRole.entries()];
  const idle = counts.filter(([, n]) => n === 0).map(([r]) => r);
  const busy = counts.filter(([, n]) => n >= ROLE_IMBALANCE_BUSY_THRESHOLD);
  if (idle.length === 0 || busy.length === 0) return;

  const ageMin = Math.round(ageMs / 60_000);
  const summary = counts.map(([r, n]) => `${r}=${n}`).join(' · ');
  console.warn(
    `[role-imbalance] run ${state.swarmRunID} (${ageMin}m): ` +
      `idle role(s) [${idle.join(', ')}] while busy role(s) ` +
      `[${busy.map(([r, n]) => `${r}=${n}`).join(', ')}]; ` +
      `consider a manual re-prompt to surface work for the idle role(s). ` +
      `Per-role claimed counts: ${summary}. ` +
      `(PATTERN_DESIGN/role-differentiated.md I2)`,
  );
  state.roleImbalanceWarnedAtMs = Date.now();
}

// PATTERN_DESIGN/blackboard.md I2 — detect items that workers refused
// at least twice. The retryOrStale path tags these with a `[retry:N]`
// note; once N≥2 the item should not count as "active work" for the
// ratchet's drained-board predicate. Exported so other ratchet-style
// callers (eager-sweep, audit) can apply the same exclusion if they
// add work-available checks later.
const RETRY_EXHAUSTED_RE = /^\[retry:(\d+)\]/;
const RETRY_EXHAUSTED_THRESHOLD = 2;
function isRetryExhausted(note: string | null | undefined): boolean {
  if (!note) return false;
  const m = RETRY_EXHAUSTED_RE.exec(note);
  if (!m) return false;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= RETRY_EXHAUSTED_THRESHOLD;
}

// PATTERN_DESIGN/orchestrator-worker.md I1 — pattern-conditional
// re-plan cap. Returns true when the orchestrator-worker run has hit
// MAX_ORCHESTRATOR_REPLANS planner sweeps and should be stopped.
// Self-organizing runs return false (uncapped). Counted via
// plan_revisions ledger (the same source feeding the strategy tab),
// so initial sweeps + re-plans + no-op sweeps all count uniformly.
async function orchestratorReplanCapHit(swarmRunID: string): Promise<boolean> {
  const meta = await getRun(swarmRunID).catch(() => null);
  if (!meta || meta.pattern !== 'orchestrator-worker') return false;
  // Cheap synchronous read against the SQLite ledger. listPlanRevisions
  // returns the full delta history; we only need the count, but the
  // call cost is negligible at run scale (≤ 6 rows by the time the
  // cap fires).
  const revisions = listPlanRevisions(swarmRunID);
  return revisions.length >= MAX_ORCHESTRATOR_REPLANS;
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
      // This tier had nothing to propose. Bump current tier so the next
      // cascade attempts the tier above. If we just attempted MAX_TIER
      // and got nothing, there's nowhere higher — mark exhausted.
      console.log(
        `[board/auto-ticker] ${swarmRunID}: tier-${clampedNextTier} escalation produced no work (planner returned ${result.items.length} item(s) total)`,
      );
      state.currentTier = clampedNextTier;
      if (clampedNextTier >= MAX_TIER) {
        state.tierExhausted = true;
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
      `[board/auto-ticker] ${state.swarmRunID}: hard-cap breached — wall-clock ${Math.round(elapsedMinutes)}min >= ${minutesCap}min. Stopping.`,
    );
    stopAutoTicker(state.swarmRunID, 'hard-cap');
    return true;
  }

  if (state.totalCommits >= commitsCap) {
    console.log(
      `[board/auto-ticker] ${state.swarmRunID}: hard-cap breached — commits ${state.totalCommits} >= ${commitsCap}. Stopping.`,
    );
    stopAutoTicker(state.swarmRunID, 'hard-cap');
    return true;
  }

  // Todos seen = count of kind='todo' board items (any status). Cheap
  // enough at prototype scale (hundreds of items in-memory).
  const todoCount = listBoardItems(state.swarmRunID).filter(
    (i) => i.kind === 'todo',
  ).length;
  if (todoCount >= todosCap) {
    console.log(
      `[board/auto-ticker] ${state.swarmRunID}: hard-cap breached — todos authored ${todoCount} >= ${todosCap}. Stopping.`,
    );
    stopAutoTicker(state.swarmRunID, 'hard-cap');
    return true;
  }

  return false;
}

// Audit trigger — Stage 2 declared-roles contract gate.
//
// Invoked from three places in the ticker's lifecycle:
//   - 'cadence'          : after every Nth 'picked' outcome (default N=5)
//   - 'tier-escalation'  : before the planner re-sweeps at tier+1 so the
//                          new sweep sees fresh verdicts in its prompt
//   - 'run-end'          : before stopAutoTicker so the archived run has
//                          a final verdict on every pending criterion
//
// Fail-open on every path: a missing auditor session, a read error, or
// an in-flight re-entrancy → log and skip. Resets the cadence counter
// even when the audit is skipped for re-entrancy so the counter doesn't
// permanently leak past K.
//
// Verdict → status mapping:
//   MET      → done     (criterion satisfied; sticky unless re-audited)
//   UNMET    → blocked  (not yet; may flip to done on a later audit)
//   WONT_DO  → stale    (criterion misguided or out of scope now)
//   unclear  → (no transition; leave open/blocked as-is for next pass)
async function maybeRunAudit(
  state: TickerState,
  reason: 'cadence' | 'tier-escalation' | 'run-end',
): Promise<void> {
  if (state.stopped && reason !== 'run-end') return;
  if (state.auditInFlight) {
    if (reason === 'cadence') state.commitsSinceLastAudit = 0;
    return;
  }

  const { swarmRunID } = state;
  const meta = await getRun(swarmRunID).catch(() => null);
  if (!meta) return;
  if (!meta.enableAuditorGate || !meta.auditorSessionID) return;

  // Lazily sync the cadence setting from meta. A user-supplied
  // auditEveryNCommits lands on the TickerState here (rather than at
  // startAutoTicker) so HMR-reloads pick up meta changes without a
  // restart.
  if (typeof meta.auditEveryNCommits === 'number' && meta.auditEveryNCommits > 0) {
    state.auditEveryNCommits = meta.auditEveryNCommits;
  }

  const items = listBoardItems(swarmRunID);
  const pending = items.filter(
    (i) =>
      i.kind === 'criterion' &&
      (i.status === 'open' || i.status === 'blocked'),
  );

  // Cadence skip without an audit still resets the counter so the next
  // commit doesn't immediately re-trigger. Other reasons (tier-escalation,
  // run-end) are single-shot and don't gate on the counter.
  if (pending.length === 0) {
    if (reason === 'cadence') state.commitsSinceLastAudit = 0;
    console.log(
      `[board/auto-ticker] ${swarmRunID}: audit (${reason}) skipped — no pending criteria`,
    );
    return;
  }

  state.auditInFlight = true;
  try {
    const doneSummaries = items
      .filter((i) => i.status === 'done' && i.kind !== 'criterion')
      .slice(-30)
      .map((i) => i.content);
    console.log(
      `[board/auto-ticker] ${swarmRunID}: audit (${reason}) — judging ${pending.length} pending criteria`,
    );
    // Re-warm the auditor's ollama model. Auditor cadence is 5-20 min
    // apart; ollama cloud evicts warm models between calls, and we've
    // observed nemotron hanging opencode's prompt client when cold.
    // A per-audit prewarm is cheap (~1s on a recently-warm model,
    // up to 60s on truly cold). Non-ollama pins no-op.
    if (meta.auditorModel) {
      await prewarmModels([meta.auditorModel]).catch((err) => {
        console.warn(
          `[board/auto-ticker] ${swarmRunID}: auditor prewarm threw:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    }
    const result = await auditCriteria({
      swarmRunID,
      auditorSessionID: meta.auditorSessionID,
      workspace: meta.workspace,
      directive: meta.directive,
      criteria: pending,
      recentDoneSummaries: doneSummaries,
      currentTier: state.currentTier,
      auditorModel: meta.auditorModel,
    });

    let metCount = 0;
    let unmetCount = 0;
    let wontDoCount = 0;
    let unclearCount = 0;
    for (const v of result.verdicts) {
      if (v.verdict === 'unclear') {
        unclearCount += 1;
        continue;
      }
      const toStatus =
        v.verdict === 'met'
          ? ('done' as const)
          : v.verdict === 'unmet'
            ? ('blocked' as const)
            : ('stale' as const);
      // Allow transition from either 'open' or 'blocked' — criteria
      // can oscillate: a prior UNMET (blocked) can later become MET
      // if subsequent work satisfies it.
      const note = `[audit:${reason}] ${v.reason}`.slice(0, 200);
      const t = transitionStatus(swarmRunID, v.criterionID, {
        from: ['open', 'blocked'],
        to: toStatus,
        note,
        setCompletedAt: toStatus === 'done',
      });
      if (t.ok) {
        if (v.verdict === 'met') metCount += 1;
        else if (v.verdict === 'unmet') unmetCount += 1;
        else wontDoCount += 1;
      }
      // CAS loss is acceptable — a concurrent audit or manual
      // transition moved the criterion; this run's verdict for it is
      // stale and we drop it.
    }
    console.log(
      `[board/auto-ticker] ${swarmRunID}: audit (${reason}) done — met=${metCount} unmet=${unmetCount} wont-do=${wontDoCount} unclear=${unclearCount}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[board/auto-ticker] ${swarmRunID}: audit (${reason}) threw: ${message}`,
    );
  } finally {
    state.auditInFlight = false;
    if (reason === 'cadence') state.commitsSinceLastAudit = 0;
  }
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

export interface AutoTickerOpts {
  intervalMs?: number;
  // When > 0, fires a fresh planner sweep every N ms for the life of the
  // run. Also disables the auto-idle stop logic — the ticker keeps going
  // until explicitly stopped. Intended for long-running (hours+) runs
  // where new refactoring opportunities surface as the codebase evolves.
  // Omit / set to 0 for the original "drain once, maybe re-sweep, stop"
  // shape used by short smokes and the battle tests.
  periodicSweepMs?: number;
  // The orchestrator's session ID for `orchestrator-worker` runs. Excluded
  // from the dispatch picker so the orchestrator stays focused on planning
  // rather than claiming worker todos. Also skipped by the per-session
  // tick fanout. Omit for self-organizing patterns — every session is a
  // worker by default.
  orchestratorSessionID?: string;
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
  // Ambition-ratchet state (see SWARM_PATTERNS.md "Tiered execution").
  // currentTier is 1-indexed and starts at 1; auto-idle cascades try
  // tier+1 via attemptTierEscalation. tierExhausted means MAX_TIER was
  // tried and produced zero items — next cascade will stop the ticker.
  currentTier: number;
  tierExhausted: boolean;
  maxTier: number;
  // Epoch-ms when the Zen retry-after window ends (only present when
  // stopReason is 'zen-rate-limit' AND the 429 response carried a
  // parseable retry-after header). UI shows a live countdown chip.
  retryAfterEndsAtMs?: number;
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
    currentTier: s.currentTier ?? 1,
    tierExhausted: s.tierExhausted ?? false,
    maxTier: MAX_TIER,
    retryAfterEndsAtMs: s.retryAfterEndsAtMs,
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
  if (s) return snapshot(s);

  // PATTERN_DESIGN/blackboard.md I3 — fallback to the persisted
  // snapshot when no in-memory state exists. After dev restart the
  // tickers map is empty; without this hydration the UI sees
  // "ticker never ran" instead of the original stop reason.
  // Only fires when in-memory is empty — running tickers always
  // win.
  const persisted = readTickerSnapshot(swarmRunID);
  if (!persisted) return null;
  // The persisted snapshot was written by snapshot() so the shape
  // matches TickerSnapshot exactly — return as-is. Defensive cast
  // because the read path stores it as Record<string, unknown> to
  // stay decoupled from this module's type.
  return persisted.snapshot as unknown as TickerSnapshot;
}

// Publish to globalThis so in-flight setInterval callbacks resolve to
// the latest fanout / runPeriodicSweep / checkLiveness on their next
// tick, even when HMR replaces this module mid-run.
publishExports<AutoTickerExports>(AUTO_TICKER_EXPORTS_KEY, {
  fanout,
  runPeriodicSweep,
  checkLiveness,
});
