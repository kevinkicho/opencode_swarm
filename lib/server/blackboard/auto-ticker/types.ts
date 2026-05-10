// Auto-ticker types + cross-policy constants.
//
// Extracted from the monolithic `auto-ticker.ts` (#106) so the policy
// modules (sweep, tier-escalation, hard-caps, etc.) can share the
// central state shape without circular imports. Each policy keeps its
// own local constants co-located with the function that consumes them;
// only constants read by multiple modules (or by the public snapshot
// surface) live here.

import 'server-only';

import type { TickOutcome } from '../coordinator';

// ─── Cross-module constants ──────────────────────────────────────────

// Default ticker interval. 10s gives sessions plenty of time to claim,
// work, and commit a single todo without stacking dispatches.
export const DEFAULT_INTERVAL_MS = 10_000;

// Per-session idle threshold before auto-stop fires. 6 ticks at 10s
// cadence = 60s of whole-run quiet before the ticker tears down.
// Auto-stop only fires when EVERY session crosses this threshold —
// a single still-active session keeps the run alive.
export const IDLE_TICKS_BEFORE_STOP = 6;

// Eager re-sweep threshold. When every session has been idle for this
// many ticks AND we're in long-running mode (periodicSweepMs > 0) AND
// the last sweep was long enough ago, fire a fresh planner sweep
// immediately instead of waiting for the periodic timer. Practical
// effect: 10-15 todos drain in ~5 min, sessions go idle, 20s later a
// new batch lands — no more sitting idle for 15 min waiting for the
// 20-min periodic tick.
export const IDLE_TICKS_BEFORE_EAGER_SWEEP = 2;

// 2026-05-07: Consecutive no-claimable-work threshold for persistent-
// sweep mode. When every tick's pickClaim returns "no claimable todos"
// for this many consecutive ticks, the ticker stops regardless of
// periodic-sweep mode — the board has zombie items (retry-exhausted
// but status=open) and the planner isn't producing fresh work.
export const NO_CLAIMABLE_WORK_TICKS = 18;

// Floor on how frequently sweeps fire. Even if the board drains
// instantly, the planner needs ~60-90s per sweep, and stacking sweeps
// back-to-back would burn tokens on constant re-planning and race the
// "overwrite guard" in runPlannerSweep. 60s gives the previous sweep
// enough time to fully land its new todos while keeping the idle gap
// short. Combined with sweep-after-claim (item 4), workers should
// never wait >1 sweep duration for a fresh batch.
export const MIN_MS_BETWEEN_SWEEPS = 60 * 1000;

// Consecutive sweeps where the planner called todowrite but every proposed
// item was filtered (vague criteria + dedup). After this many in a row,
// the ticker stops to avoid burning tokens re-proposing the same items.
export const MAX_CONSECUTIVE_FILTERED_ALL_SWEEPS = 4;

// ─── Ambition ratchet ────────────────────────────────────────────────

// Tier escalation ladder. Each tier expands the planner's scope.
export const TIER_LADDER = [
  'Fix bugs, polish, and small improvements — the obvious loose ends.',
  'Refactor, extract, and enhance — missing features the README promises.',
  'Cross-cutting, architectural, and multi-file improvements — wiring up gaps.',
  'Integrations, end-to-end features, and spec claims the code doesn\'t deliver yet.',
  'Ambitious bets: multi-area improvements, new subsystems, or design-level changes.',
] as const;

export const MAX_TIER = TIER_LADDER.length;

// ─── StopReason ──────────────────────────────────────────────────────

export type StopReason =
  | 'auto-idle'
  // Same shape as 'auto-idle' but specifically when periodicSweepMs > 0
  // (long-running mode with re-sweeps) — the run is idle AND the board
  // has 0 work-class items in flight, so no future re-sweep would have
  // anything to dispatch. Distinct reason so the ledger can show
  // "stopped because work ran out, not because the ticker timed out."
  | 'auto-idle-drained'
  | 'manual'
  | 'opencode-frozen'
  | 'zen-rate-limit'
  // Stage 2 hard-cap enforcement (#65 Phase A) — three granular reasons
  // replace the old generic 'hard-cap'. The ollama-swarm spec's "hard
  // caps fire whichever first" — a ceiling above which the run stops
  // regardless of what the auditor or planner say. Absent per-run
  // overrides default to 8h / 200 / 300. Granular reasons let the
  // run-health banner say WHICH ceiling was hit without re-deriving
  // it from logs.
  | 'wall-clock-cap'
  | 'commits-cap'
  | 'todos-cap'
  // can loop forever if every re-plan sweep proposes work that workers
  // stale out (file contention, complexity underestimation). This cap
  // bounds the loop at MAX_ORCHESTRATOR_REPLANS sweeps; the run stops
  // with this reason and the run-health banner surfaces it for human
  // intervention. Self-organizing patterns are uncapped — they don't
  // exhibit this failure mode.
  | 'replan-loop-exhausted'
  // #105 — operator clicked the force-stop button. Distinct from
  // 'manual' (which means the operator stopped the auto-ticker via
  // the ticker control endpoint, leaving sessions alive). hard-stop
  // tears down the whole run: ticker + every session + records a
  // partial-outcome finding so the board carries the operator-action
  // evidence. Used when a run is wedged with a turn that's still
  // emitting parts (silent watchdog can't fire) but isn't producing
  // useful output.
   | 'operator-hard-stop'
   | 'operator-abort'
   | 'filtered-all-todos'
   | 'stuck-deliberation'
   // 2026-05-07: persistent-sweep runs that have zero claimable work
   // for too many consecutive ticks (retry-exhausted zombies with no
   // fresh planner output) burn tokens without progress. This stop
   // fires independently of hard caps and idle-stop.
   | 'no-claimable-work';
 
 // ─── State shape ─────────────────────────────────────────────────────


export interface PerSessionSlot {
  sessionID: string;
  inFlight: boolean;
  consecutiveIdle: number;
  lastOutcome?: TickOutcome;
  lastRanAtMs?: number;
}

export interface TickerState {
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
  // Re-sweep bookkeeping. `resweepInFlight` guards against re-entrant
  // planner calls from concurrent session ticks all hitting at once
  // (also used as the mutex by runPeriodicSweep so the two can't stack).
  resweepInFlight: boolean;
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
  // When the liveness watchdog declared zen-rate-limit, this holds the
  // epoch-ms at which the retry-after window opencode reported in the
  // 429 response ends. Surfaced via TickerSnapshot so the UI can show
  // a live-countdown chip ("retry 3h 47m") on rate-limited runs.
  // Absent on any other stop reason.
  retryAfterEndsAtMs?: number;
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
  // Ambition ratchet: current escalation tier (1-based). Starts at 1.
  // Each tier expands the planner's scope — from bug fixes (1) up to
  // architectural and cross-cutting changes (4+). Bumped when the board
  // drains at the current tier and persisted via updateRunMeta so a
  // ticker restart resumes at the correct level.
  currentTier: number;
  // Consecutive planner sweeps where the planner called todowrite but every
  // proposed item was filtered (vague criteria + dedup). Reset to 0 on any
  // sweep that produces new work. When this reaches
  // MAX_CONSECUTIVE_FILTERED_ALL_SWEEPS, the ticker stops with reason
  // 'filtered-all-todos'.
  consecutiveFilteredAllTodos: number;
  // 2026-05-07: Counts consecutive ticks where pickClaim returned
  // "no claimable todos" because of retry-exhausted zombie items. When
  // this reaches NO_CLAIMABLE_WORK_TICKS, the ticker stops even in
  // persistent-sweep mode. Reset to 0 whenever a claim succeeds or
  // the planner adds fresh work.
  consecutiveNoClaimableWork: number;
  // Monotonic counter of planner sweep errors. Tracks how many times
  // a sweep (periodic, eager, or tier-escalation) threw. Surfaced via
  // TickerSnapshot so the UI can surface planner health.
  plannerErrors: number;
  // Auto-pilot: cost cap from bounds.costCap, hydrated once at startup.
  // Default undefined → no cap set; the auto-pilot rules 3/4 won't fire.
  costCap?: number;
}

export type TickerMap = Map<string, TickerState>;

// Minimal per-session slot exposure for client-side status derivation.
// The UI only needs to know which sessions have an in-flight tick so agents
// aren't marked "idle" when the ticker just dispatched work to them.
export interface TickerSlotSnapshot {
  sessionID: string;
  inFlight: boolean;
}

// Shape handed to clients via /api/swarm/run/:id/ticker. Keep this in
// sync with components/board-rail.tsx's TickerChip expectations.
// Per-session detail is rolled up: inFlight=any, consecutiveIdle=min,
// last* from the most recently active session. The UI contract predates
// per-session fan-out and we keep it single-valued so the chip stays
// readable at a glance. Per-session inFlight slots are now exposed via
// the `slots` field for agent status derivation.
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
  totalCommits: number;
  retryAfterEndsAtMs?: number;
  currentTier: number;
  // Re-sweep cadence. 0 = single-sweep (auto-stop on idle).
  // > 0 = periodic re-sweep every N ms with ambition ratchet.
  periodicSweepMs: number;
  // Monotonic counter of planner sweep errors. Incremented in every
  // catch block (periodic sweep, eager sweep, tier escalation).
  plannerErrors: number;
  // Per-session inFlight state. Used by the client to override agent
  // status: a session with inFlight=true should show as "thinking"
  // even if another agent spoke more recently.
  slots: TickerSlotSnapshot[];
}

// ─── Public lifecycle options ────────────────────────────────────────

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

// ─── HMR + global registry plumbing ──────────────────────────────────

// Re-published from the auto-ticker index so in-flight setInterval
// callbacks resolve to the latest fanout / runPeriodicSweep /
// checkLiveness on their next tick, even when HMR replaces the
// individual policy modules mid-run. The publish lives in index.ts so
// every module's load order is deterministic.
export const AUTO_TICKER_EXPORTS_KEY = Symbol.for(
  'opencode_swarm.auto_ticker.exports',
);
export interface AutoTickerExports {
  fanout: (swarmRunID: string) => Promise<void>;
  runPeriodicSweep: (state: TickerState) => Promise<void>;
  checkLiveness: (state: TickerState) => Promise<void>;
}

export const globalTickerKey = Symbol.for('opencode_swarm.boardAutoTickers');
export const globalShutdownHookKey = Symbol.for(
  'opencode_swarm.boardAutoTickers.shutdownHook',
);
export const globalBootCleanupKey = Symbol.for(
  'opencode_swarm.boardAutoTickers.bootCleanup',
);
export type GlobalWithTickers = typeof globalThis & {
  [globalTickerKey]?: TickerMap;
  [globalShutdownHookKey]?: boolean;
  [globalBootCleanupKey]?: boolean;
};
