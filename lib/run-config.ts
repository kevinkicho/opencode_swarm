// Swarm run request and pipeline configuration types.

import type { SwarmPattern } from './swarm-types';

// --- Pipeline phase definition ------------------------------------------------

// A pipeline chains 2–4 existing pattern phases sequentially. Each phase
// is a standalone swarm run linked via continuationOf. The pipeline
// coordinator waits for each phase to complete, synthesizes its output
// into the next phase's directive, and creates the next run.
//
// Presets (sensible combinations — users pick one; power users can write
// a custom array):
//   'explore-then-execute'  map-reduce → blackboard
//   'deliberate-then-execute' council → orchestrator-worker
//   'explore-deliberate-execute' map-reduce → council → orchestrator-worker
//   'explore-and-validate' map-reduce → critic-loop
//   'explore-judge-execute' map-reduce → debate-judge → blackboard
//
// Custom pipelines pass a phases[] array directly.

export type PipelinePreset =
  | 'explore-then-execute'
  | 'deliberate-then-execute'
  | 'explore-deliberate-execute'
  | 'explore-and-validate'
  | 'explore-judge-execute';

export interface PipelinePhase {
  pattern: Exclude<SwarmPattern, 'none' | 'pipeline'>;
  teamSize?: number;
  directive?: string;
  workspace?: string;
}

export interface PipelineConfig {
  preset?: PipelinePreset;
  phases?: PipelinePhase[];
}

export interface SwarmRunBounds {
  costCap?: number;
  // Wall-clock cap in minutes. Default 0 (disabled / unbounded) — the
  // auto-ticker runs indefinitely, stopped only by explicit operator
  // action or tier exhaustion at MAX_TIER. Set to a number > 0 to cap
  // at that many minutes. Non-ticker patterns default to 60m.
  minutesCap?: number;
  // Max number of successful commits before the ticker auto-stops with
  // stopReason='commits-cap'. Default 0 (disabled). Criteria status-
  // transitions via auditor don't count — only worker-completed todos.
  commitsCap?: number;
  // Max number of todos ever authored on the board before the ticker
  // auto-stops. Default 0 (disabled). Criteria are excluded from the
  // count. Set > 0 to prevent runaway planner sweeps from flooding the
  // board with work neither the user nor the auditor asked for.
  todosCap?: number;
}

// Body accepted by the run endpoint. `pattern` and `workspace` are required;
// most other fields below now drive runtime routing (teamModels per slot,
// criticModel/verifierModel/auditorModel for gates, partialMapTolerance,
// enableSynthesisCritic, roleBudgets, strictRoleRouting, autoStopOnConverge,
// synthesisModel, etc.). The few that are still meta-only (provenance: source,
// title, continuationOf) are flagged on their definitions.
export interface SwarmRunRequest {
  pattern: SwarmPattern;
  workspace: string;          // → opencode ?directory=
  source?: string;            // GitHub URL; recorded for provenance
  directive?: string;         // first prompt posted to the root session
  title?: string;             // session title seed; falls back to directive line 1
  teamSize?: number;          // aspirational — ignored for pattern='none'
  bounds?: SwarmRunBounds;    // costCap is enforced by the proxy gate (DESIGN.md §9); minutesCap still aspirational
  // Blackboard-only (and orchestrator-worker). Re-sweep cadence in minutes.
  // Default 5 = periodic sweep every 5 minutes with ambition ratchet (infinite
  // run). Set to 0 for single-sweep mode (run stops when board drains).
  // Omitting the field defaults to 5 for blackboard-family patterns.
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
  // Council convergence auto-stop.
  // When true AND mean-pairwise-token-jaccard convergence on any
  // round ≥ COUNCIL_CONVERGENCE_THRESHOLD (0.85), the council loop
  // skips remaining rounds and proceeds to synthesis/handoff.
  // Saves tokens on high-consensus missions. Default false — opt-in.
  // Council pattern only.
  autoStopOnConverge?: boolean;
  // When set, the coordinator forces this model for any board item
  // with `kind === 'synthesize'` regardless of which session claims
  // it. Reason: synthesis quality varies sharply across models, and
  // map-reduce's "any idle session claims" lottery makes the
  // synthesizer choice random. Pinning a specific model produces
  // consistent results across runs. Format: same shape as teamModels
  // entries (`ollama/<model>` or `opencode/<model>`). Defaults to
  // undefined → use whatever the claiming session's model would be.
  // Map-reduce pattern only — ignored by other patterns.
  synthesisModel?: string;
  // Strict role routing.
  // When true, the coordinator picker filters out items whose
  // `preferredRole` doesn't match the picked session's role. Default
  // false (soft bias only — mismatched items are still claimable but
  // de-prioritized). Set true to impose tactical constraints like
  // "only the security role should touch authentication code."
  // Role-differentiated pattern only.
  strictRoleRouting?: boolean;
  // Map of role-name → total-token ceiling. When a role's accumulated
  // assistant-message tokens reach the ceiling, the coordinator picker
  // refuses to dispatch new work to that role's session(s). Other
  // roles continue. Useful with mixed-model teams (e.g. an architect
  // on a premium model + builders on cheaper ones — cap the architect
  // at a fraction of the run budget so a verbose planner can't soak
  // the run). Soft cutoff — already-claimed work runs to completion;
  // only future claims are denied. Default undefined → no caps.
  // Role-differentiated pattern only (other patterns ignore).
  roleBudgets?: Record<string, number>;
  // When set, the synthesis-wait stage tolerates per-member failures
  // by proceeding with whatever drafts arrived as long as at least
  // `minMembers` succeeded AND at most `maxMemberFailures` errored.
  // Without this, a single hung member stalls the entire run for the
  // full SESSION_WAIT_MS (25 min). Defaults to undefined → wait for
  // every member as before. Map-reduce pattern only.
  partialMapTolerance?: {
    minMembers: number;
    maxMemberFailures: number;
  };
  // When true, after the synthesizer completes, a peer session
  // (any non-synthesizer member) reviews the synthesis against the
  // original member drafts and returns APPROVED or REVISE + feedback.
  // On REVISE the synthesizer is re-prompted with the feedback;
  // capped at 2 revisions. No new session spawn — reuses an idle
  // peer to keep the infrastructure simple (matches deliberate-
  // execute I1 pattern). Default false. Map-reduce pattern only.
  enableSynthesisCritic?: boolean;
  // Build conformance gate. When true, after the critic and verifier
  // gates pass, the coordinator runs `tsc --noEmit` in the workspace
  // before marking a todo done. Items that fail typecheck bounce to
  // stale with a `[build-failed]` note; the planner can rephrase or
  // the worker retries. Fail-open on timeout or tsc not found. Only
  // applies to items with at least one edited file (text-only and
  // skip items are exempt). Default false — opt-in. Blackboard-family
  // only (other patterns don't route through the coordinator).
  enableBuildGate?: boolean;
  // Per-gate model pins (2026-04-24). Each gate's dedicated opencode
  // session spawns without a model hint (opencode picks default);
  // when set, the session's prompts carry `model: <id>` so the gate
  // runs on a specific provider/model. Same contract as teamModels
  // for workers. IDs follow the catalog shape (`opencode/<model>` or
  // `ollama/<model>:cloud`). Absent → opencode default. Typical
  // use: a lightweight model for the critic (cheap, fast verdicts),
  // a smarter model for the auditor (holistic contract judgment).
  criticModel?: string;
  verifierModel?: string;
  auditorModel?: string;
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
  // Pattern / directive / teamSize / bounds / team roles are NOT
  // inherited — those are deliberate per-run choices.
  continuationOf?: string;
  // Pipeline configuration. When pattern='pipeline', this drives the
  // multi-phase coordinator: each phase runs as a separate swarm run
  // linked via continuationOf. Either preset or phases must be provided.
  // Ignored for all other patterns.
  pipelineConfig?: PipelineConfig;
}
