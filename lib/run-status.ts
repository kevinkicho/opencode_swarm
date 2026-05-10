// Swarm run metadata and lifecycle status types.

import type { SwarmPattern } from './swarm-types';
import type { SwarmRunBounds, PipelineConfig } from './run-config';

// --- run metadata (persisted to meta.json) ----------------------------------

// One record per run. Written once at create time; updated only to append
// newly-spawned sessionIDs (future patterns). Never mutated retroactively.
export interface SwarmRunMeta {
  swarmRunID: string;
  pattern: SwarmPattern;
  createdAt: number;          // epoch ms, server clock
  workspace: string;
  sessionIDs: string[];       // component opencode sessions
  source?: string;
  directive?: string;
  title?: string;
  bounds?: SwarmRunBounds;
  // Pattern-specific configs persisted alongside the meta so orchestrator
  // modules can read them on periodic re-sweeps / kickoffs without the
  // HTTP request context. Mirror of the SwarmRunRequest fields.
  teamRoles?: string[];
  criticMaxIterations?: number;
  debateMaxRounds?: number;
  enableCriticGate?: boolean;
  // The ID of the run's dedicated critic opencode session (spawned once
  // at createRun when enableCriticGate is true). NOT included in
  // sessionIDs — this session is outside the worker pool and shouldn't
  // be ticked by the coordinator. Absent when enableCriticGate is false
  // or the critic spawn failed (run continues without the gate).
  criticSessionID?: string;
  // Playwright grounding mirror — see SwarmRunRequest for semantics.
  enableVerifierGate?: boolean;
  workspaceDevUrl?: string;
  // Dedicated verifier session, spawned once at createRun when
  // enableVerifierGate is true. Also NOT in sessionIDs. Absent when
  // the flag is false or spawn failed.
  verifierSessionID?: string;
  // Contract auditor — Stage 2 declared-roles alignment. Mirror of
  // enableVerifierGate/verifierSessionID: flag set when the request
  // opted in; sessionID populated only if the extra session spawn
  // succeeded (absent on spawn failure → run continues without the
  // auditor gate, fail-open).
  enableAuditorGate?: boolean;
  auditorSessionID?: string;
  // Audit cadence (commits between audits). Default 5 when unset and
  // auditor is enabled. See SwarmRunRequest for semantics.
  auditEveryNCommits?: number;
  // Council convergence auto-stop mirror
  autoStopOnConverge?: boolean;
  // Strict role routing mirror
  strictRoleRouting?: boolean;
  // Per-role token-budget caps mirror
  roleBudgets?: Record<string, number>;
  // Partial-map tolerance mirror
  partialMapTolerance?: {
    minMembers: number;
    maxMemberFailures: number;
  };
  // Synthesis-critic mirror
  enableSynthesisCritic?: boolean;
  // Synthesis-model pin mirror
  synthesisModel?: string;
  // Build gate mirror. When true, tsc --noEmit runs before commits.
  enableBuildGate?: boolean;
  // Per-gate model pins mirrored from the request. See SwarmRunRequest
  // for semantics. Each gate's reviewer module reads these from meta
  // and passes as `model` on its postSessionMessageServer calls.
  criticModel?: string;
  verifierModel?: string;
  auditorModel?: string;
  // Ambition ratchet: current escalation tier (1-based). Persists across
  // ticker restarts so the run resumes at the correct ambition level.
  // Bumped by attemptTierEscalation when the board drains at the current
  // tier. The planner prompt reads this to widen scope at higher tiers.
  // Default undefined → treated as tier 1.
  currentTier?: number;
  // Lineage pointer for run chaining. Absent for standalone runs. See
  // SwarmRunRequest.continuationOf for semantics.
  continuationOf?: string;
  // Per-session model pinning. Index-aligned with sessionIDs after
  // partial-spawn-survivor remapping (see route.ts createRun call).
  // Absent → no pinning, opencode picks each session's model.
  teamModels?: string[];
  // Pipeline config mirror. Set when pattern='pipeline'; absent for
  // all other patterns.
  pipelineConfig?: PipelineConfig;
}

// --- run lifecycle status ---------------------------------------------------

// Classification of a run's execution state, derived server-side from the
// tail of the run's primary session messages, then reconciled against the
// auto-ticker's authoritative liveness. Not persisted — this is a live
// derivation, valid only for the moment the list endpoint replies.
//
// The base axis is alive vs stopped. Within "alive" the schema also
// captures attention signals (issue showing, no current activity) that
// the user wants surfaced separately so the picker isn't a guessing game.
//
//   live     — ticker is running AND at least one session is currently
//              producing tokens. The run is actively consuming compute.
//   idle     — ticker is running BUT no session is currently producing.
//              Common between dispatches (planner sweep waiting, all
//              workers between turns). The run is alive but quiet —
//              this is a flag-flavor of live.
//   error    — at least one session reported a real error (not a clean
//              MessageAbortedError). Needs attention. Can layer on top
//              of live OR stale — error wins the priority either way.
//   stale    — ticker is stopped (cap-stop, manual stop, normal completion,
//              cleanly aborted). The run is no longer consuming compute.
//              Includes legacy zombie sessions that hung past the threshold.
//   unknown  — couldn't probe any session, or run has no sessions yet.
//              Not an error — just "we couldn't tell."
//
// Renamed 2026-04-26 (ledger #176): the previous schema had `idle` =
// "completed cleanly" and `stale` = "zombie only". Users reported
// confusion (an "idle" run reads as still-alive, but most idle runs in
// the picker were actually completed). The new mental model: alive vs
// stopped is the primary axis, with `idle`/`error` as flag-flavors.
export type SwarmRunStatus = 'live' | 'idle' | 'completed' | 'error' | 'stale' | 'unknown';

// One row in GET /api/swarm/run's response. `meta` is the persisted record;
// the rest is live-derived from the primary session's messages and may
// change across polls.
export interface SwarmRunListRow {
  meta: SwarmRunMeta;
  status: SwarmRunStatus;
  // Epoch ms of the most recent signal we used to classify — usually the
  // latest message's time.completed or time.created. null when the session
  // has no messages.
  lastActivityTs: number | null;
  // Cumulative dollars and tokens across every assistant message in the
  // run's primary session. Falls back to pricing-derived cost when
  // opencode doesn't report info.cost directly (free tiers, go bundle).
  // Zero when the probe failed or the run has no assistant messages yet.
  costTotal: number;
  tokensTotal: number;
  // Stuck-deliberation detector (#104). Set when the run has crossed
  // both STUCK_TOKEN_FLOOR and STUCK_AGE_FLOOR_MS but has zero board
  // items. Picker uses this to surface a visual warning so the operator
  // can hard-stop a hung run instead of waiting on the wall-clock cap.
  // Absent when not stuck (omitted from the JSON to keep the shape
  // backward-compatible with picker code that doesn't yet read it).
  stuck?: { reason: string };
}
