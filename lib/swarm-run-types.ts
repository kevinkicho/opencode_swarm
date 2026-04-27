// Wire contracts for the swarm-run backend (Tier 2 of the roadmap).
//
// A "swarm run" is one logical run that wraps N opencode sessions under a
// single coordinator. At v1 N=1 and the pattern is always 'none' — the
// shape generalizes to N when blackboard / map-reduce / council backends
// ship.
//
// Ownership: these types are shared between the browser (POST body, event
// consumer) and the Next.js route handler. Keep server-only types in
// `lib/server/` so this file stays import-safe from 'use client' modules.

import type { SwarmPattern } from './swarm-types';

// --- POST /api/swarm/run ----------------------------------------------------

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
}

export interface SwarmRunBounds {
  costCap?: number;
  // Wall-clock cap in minutes. Default 480 (8h) for blackboard-family
  // ticker-driven runs — the ollama-swarm spec's "hard caps fire
  // whichever first: wall-clock (default 8h), 200 commits, 300 todos."
  // Set to a number > 0 to override; set to a very large number for
  // "effectively unbounded" (no sentinel value; just pick 10000+).
  minutesCap?: number;
  // Max number of successful commits (todos transitioned to done) before
  // the ticker auto-stops with stopReason='commits-cap'. Default 200.
  // Criteria status-transitions via auditor don't count toward this —
  // only worker-completed todos. Stage 2 declared-roles alignment.
  commitsCap?: number;
  // Max number of todos ever authored on the board (planner
  // todowrite outputs) before the ticker auto-stops. Default 300.
  // Criteria are excluded from the count. Prevents runaway planner
  // sweeps from flooding the board with work neither the user nor
  // the auditor asked for.
  todosCap?: number;
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
  // Per-gate model pins mirrored from the request. See SwarmRunRequest
  // for semantics. Each gate's reviewer module reads these from meta
  // and passes as `model` on its postSessionMessageServer calls.
  criticModel?: string;
  verifierModel?: string;
  auditorModel?: string;
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
  // Critic / verifier / auditor sessions are spawned best-effort:
  // a failure used to fall through to undefined silently, so a run
  // with `enableAuditorGate: true` could launch with no auditor
  // session and the user had no signal. Now each failure's reason
  // appears here. Absent when all enabled gate-spawns succeeded.
  gateFailures?: {
    critic?: string;
    verifier?: string;
    auditor?: string;
  };
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
  // Stuck-deliberation detector (#104). Set when the run has crossed
  // both STUCK_TOKEN_FLOOR and STUCK_AGE_FLOOR_MS but has zero board
  // items. Picker uses this to surface a visual warning so the operator
  // can hard-stop a hung run instead of waiting on the wall-clock cap.
  // Absent when not stuck (omitted from the JSON to keep the shape
  // backward-compatible with picker code that doesn't yet read it).
  stuck?: { reason: string };
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
