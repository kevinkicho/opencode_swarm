// Wire contracts for the swarm-run backend (Tier 2 of the roadmap).
//
// A "swarm run" is one logical run that wraps N opencode sessions under a
// single coordinator. At v1 N=1 and the pattern is always 'none' — the
// shape generalizes to N when blackboard / map-reduce / council backends
// ship (see SWARM_PATTERNS.md §"Backend gap").
//
// Ownership: these types are shared between the browser (POST body, event
// consumer) and the Next.js route handler. Keep server-only types in
// `lib/server/` so this file stays import-safe from 'use client' modules.

import type { SwarmPattern } from './swarm-types';

// --- POST /api/swarm/run ----------------------------------------------------

// Body accepted by the run endpoint. `pattern` and `workspace` are the only
// non-aspirational fields at v1 — the rest are recorded in meta.json for
// later replay / analytics but don't drive runtime routing yet.
export interface SwarmRunRequest {
  pattern: SwarmPattern;
  workspace: string;          // → opencode ?directory=
  source?: string;            // GitHub URL; recorded for provenance
  directive?: string;         // first prompt posted to the root session
  title?: string;             // session title seed; falls back to directive line 1
  teamSize?: number;          // aspirational — ignored for pattern='none'
  bounds?: SwarmRunBounds;    // costCap is enforced by the proxy gate (DESIGN.md §9); minutesCap still aspirational
  // Blackboard-only (and orchestrator-worker). When > 0, the auto-ticker
  // fires a fresh planner sweep every N minutes for the life of the run
  // and disables its auto-idle stop. Intended for long-running (hours+)
  // runs where new refactoring opportunities surface as the workers edit
  // the codebase. Omit / set to 0 for the default short-run shape.
  persistentSweepMinutes?: number;
  // Role-differentiated pattern only. One role name per session. When
  // provided, must have exactly `teamSize` entries. Names become each
  // session's `agent` field (visible in roster) + seed the role-framed
  // intro prompt. Omit to default to numeric role names ("member-1", ...).
  teamRoles?: string[];
  // Critic-loop pattern only. Maximum iterations (worker → critic →
  // worker revise) before shipping the current draft regardless of
  // critic approval. Default 3.
  criticMaxIterations?: number;
  // Debate-judge pattern only. Maximum debate rounds (generators →
  // judge → possible revision prompts to losers) before the judge's
  // verdict is final. Default 2.
  debateMaxRounds?: number;
  // Anti-busywork critic gate (companion layer to the ambition ratchet).
  // When true, the run creates one extra opencode session at launch
  // (the "critic") and the coordinator reviews every committed diff
  // against it before marking the item done. Busywork verdicts bounce
  // the item back to stale with a `[critic-rejected]` note. Default
  // false — opt-in until behavior is validated on real runs.
  // Only applies to blackboard-family patterns (the other patterns
  // don't route commits through the board coordinator).
  enableCriticGate?: boolean;
  // Playwright grounding (companion layer #2 to the ambition ratchet).
  // When true AND workspaceDevUrl is set, the run creates a dedicated
  // "verifier" opencode session. For board items the planner flags
  // `requiresVerification: true`, the coordinator consults the verifier
  // AFTER the critic gate approves. The verifier uses Playwright (via
  // opencode's bash tool) to navigate the running target app and
  // assert on DOM / screenshot / flow. NOT_VERIFIED verdicts send the
  // item back to stale with `[verifier-rejected]` note. Default false.
  // Also blackboard-family only.
  enableVerifierGate?: boolean;
  // Base URL of the target repo's running dev server (e.g.,
  // "http://localhost:3000"). User is responsible for running the dev
  // server — we don't manage its lifecycle. Required when
  // enableVerifierGate is true; ignored otherwise.
  workspaceDevUrl?: string;
  // Contract auditor gate (companion layer #3 to the ambition ratchet,
  // Stage 2 declared-roles alignment). When true, the run creates a
  // dedicated "auditor" opencode session at launch. The auto-ticker
  // invokes it every `auditEveryNCommits` commits + on tier escalation
  // + at run-end to verdict pending criteria (kind='criterion' board
  // items) as MET / UNMET / WONT_DO. Criteria verdicts feed back into
  // the planner's re-sweep context so new todos target unmet items.
  // Default false — opt-in until the contract flow is validated on
  // real runs (see docs/VALIDATION.md). Blackboard-family only.
  enableAuditorGate?: boolean;
  // Audit cadence in commits. Auditor runs every N successful
  // `done` transitions on todos (criteria excluded from the count so
  // adding new criteria doesn't trigger premature audit). Default 5.
  // Also runs on tier escalation + run-end regardless of counter.
  // Ignored when enableAuditorGate is false.
  auditEveryNCommits?: number;
  // Per-session model pinning. One model ID per session in
  // new-run-modal picker order; length must equal the resolved
  // teamSize. When set, each session's dispatch opcodes carry the
  // corresponding model — the coordinator / non-ticker orchestrators
  // pass it as `model` on opencode's prompt endpoint, so a team of
  // ["ollama/glm-5.1:cloud", "opencode/claude-sonnet-4-6"] actually
  // dispatches session 0 to ollama-glm and session 1 to zen-sonnet.
  //
  // When unset → current behavior: opencode picks each session's
  // model from its default agent config (opencode.json). Partial
  // spawn failures remap the array to surviving slots before persist
  // — see app/api/swarm/run/route.ts.
  //
  // Model IDs follow the catalog shape (`opencode/<model>` for zen,
  // `ollama/<model>:cloud` for ollama; go-tier uses `opencode/<model>`
  // + an opencode.json agent configured to route it there). IDs not
  // in the catalog are passed through verbatim — opencode is
  // authoritative for "does this model exist?"
  teamModels?: string[];
  // Run-chaining pointer. When set, the new run inherits from a prior
  // run:
  //   - workspace (must match if req.workspace is also set, else
  //     auto-inherits when req.workspace is omitted — silent-fork
  //     prevention keeps commits landing on the intended checkout)
  //   - source (provenance continuity)
  //   - starting tier for the ambition ratchet (prior run's currentTier
  //     carries into the new run's first planner sweep — no "reset to
  //     tier 1" after a pattern switch or a rate-limit bounce)
  // Pattern / directive / teamSize / bounds / team roles are NOT
  // inherited — those are deliberate per-run choices. Unlocks the
  // "unleash a swarm on this repo for a week, bouncing through
  // different patterns as needed" usage pattern.
  continuationOf?: string;
}

export interface SwarmRunBounds {
  costCap?: number;
  minutesCap?: number;
}

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
  // Ambition-ratchet persisted tier state. Set by attemptTierEscalation
  // after each successful tier bump (via updateRunMeta) so a ticker
  // restart mid-run doesn't drop the ratchet back to tier 1. Absent
  // until the first escalation succeeds; interpreted as tier 1 then.
  // Also seeded at createRun when continuationOf is set — the new run
  // inherits the prior run's currentTier so the first planner sweep
  // targets the right ambition layer.
  currentTier?: number;
  // Lineage pointer for run chaining. Absent for standalone runs. See
  // SwarmRunRequest.continuationOf for semantics.
  continuationOf?: string;
  // Per-session model pinning. Index-aligned with sessionIDs after
  // partial-spawn-survivor remapping (see route.ts createRun call).
  // Absent → no pinning, opencode picks each session's model.
  teamModels?: string[];
}

// --- response shape ---------------------------------------------------------

export interface SwarmRunResponse {
  swarmRunID: string;
  sessionIDs: string[];
  meta: SwarmRunMeta;
}

// --- run lifecycle status ---------------------------------------------------

// Classification of a run's execution state, derived server-side from the
// tail of the run's primary session messages. Not persisted — this is a
// live derivation, valid only for the moment the list endpoint replies.
//
//   live     — most recent assistant turn is in-flight (no completed, no
//              error, recent activity). The run is actively producing.
//   idle     — most recent assistant turn completed cleanly. The run is
//              between turns; may still accept more prompts.
//   error    — most recent assistant turn carries an error. Needs
//              attention; not automatically retried.
//   stale    — in-flight assistant turn older than the staleness threshold.
//              Opencode can leave zombie turns (no completed, no error) if
//              a session crashes mid-turn; we surface these separately so
//              users know the run isn't actually progressing.
//   unknown  — primary session has no messages yet, or the status probe
//              itself failed. Not an error — just "we couldn't tell."
export type SwarmRunStatus = 'live' | 'idle' | 'error' | 'stale' | 'unknown';

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
}

// --- multiplexed event shape (out of /api/swarm/run/:id/events) -------------

// Each line the multiplexer emits tags the raw opencode event with the
// originating sessionID plus a server-receive timestamp. The opencode event
// body — `type` + `properties` — is forwarded verbatim so clients can reuse
// the same part-handling logic they use for single-session streams.
export interface SwarmRunEvent {
  swarmRunID: string;
  sessionID: string;
  ts: number;                 // epoch ms, server clock on receipt
  type: string;               // opencode event type (e.g. 'message.part.updated')
  properties: unknown;        // opencode event properties, untouched
}
