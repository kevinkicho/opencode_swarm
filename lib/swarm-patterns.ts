// UI metadata for the orchestration-pattern picker in new-run-modal.
// The canonical catalog lives in `` — keep taglines and
// availability flags in sync there when promoting a preset.

import type { SwarmPattern } from './swarm-types';

export interface PatternMeta {
  label: string;
  tagline: string;          // short description shown inside the tile
  // Concrete mechanics — rendered as a second dimmer line under the
  // tagline so users can eyeball "how many sessions / what loop / what
 // ceiling" without reading . Keep ≤ ~55 chars to fit
  // two-line tiles cleanly.
  shape: string;
  // When to reach for it. One line, hover-revealable in the tile or
  // rendered in the recipe preview. Keep concrete; avoid "when you want
  // to solve problem X" hedges.
  fit: string;
  available: boolean;       // drives disabled state + "coming soon" indicator
  accent: 'molten' | 'amber' | 'mint' | 'iris' | 'rust' | 'fog';
  // Empirical recommended teamSize ceiling from the MAXTEAM-2026-04-26
  // stress test (docs/STRESS_TESTS/2026-04-26-max-team-size-8.md).
  // Above this size every pattern except orchestrator-worker degraded
  // to stalls / errors / synth-starvation within a 30-minute cap.
  // Advisory only: the route handler still accepts teamSize up to
  // PATTERN_TEAM_SIZE.maxSize, but emits a console.warn at kickoff
  // (#101) and the new-run picker shades the slider above this point
  // (#103). Re-derive from a fresh stress test if pattern internals
  // change.
  recommendedMax: number;
}

export const patternMeta: Record<SwarmPattern, PatternMeta> = {
  none: {
    label: 'none',
    tagline: 'single opencode session, native task / subtask',
    shape: '1 session · opencode task-tool A2A only',
    fit: 'small focused work; baseline to compare multi-session shapes against',
    available: true,
    accent: 'molten',
    recommendedMax: 1,
  },
  blackboard: {
    label: 'blackboard',
    tagline: 'shared board, claim any unresolved todo',
    shape: 'N sessions · auto-ticker · CAS-safe shared board',
    fit: 'broad parallel work; self-organizing teams on independent todos',
    available: true,
    accent: 'amber',
    recommendedMax: 6,
  },
  'map-reduce': {
    label: 'map-reduce',
    tagline: 'split the tree, synthesize as a claimable phase',
    shape: 'N parallel slices → 1 synthesizer (board-claimed)',
    fit: 'large surveys or surveys-of-surveys where one merge step suffices',
    available: true,
    accent: 'mint',
    recommendedMax: 5,
  },
  council: {
    label: 'council',
    tagline: 'n parallel drafts, human reconciles via permissions',
    shape: 'N parallel drafts · auto R1→R2→R3 · reconcile strip',
    fit: 'design / architecture decisions where divergence beats convergence',
    available: true,
    accent: 'iris',
    recommendedMax: 5,
  },
  'orchestrator-worker': {
    label: 'orchestrator',
    tagline: 'one orchestrator plans, n workers claim and implement',
    shape: '1 orchestrator + N-1 workers · board-driven dispatch',
    fit: 'long missions where a persistent planner owns strategy',
    available: true,
    accent: 'rust',
    recommendedMax: 8,
  },
  'debate-judge': {
    label: 'debate',
    tagline: 'n generators propose, one judge evaluates and picks',
    shape: 'N-1 generators + 1 judge · WINNER/MERGE/REVISE · ≤ 3 rounds',
    fit: 'binary or scored choices between well-framed alternatives',
    available: true,
    accent: 'amber',
    recommendedMax: 4,
  },
  'critic-loop': {
    label: 'critic',
    tagline: 'worker drafts, critic reviews, worker revises (n iterations)',
    shape: '1 worker + 1 critic · APPROVED/REVISE · ≤ 3 iterations',
    fit: 'non-binary quality (copy, architecture, UX) where first pass is rarely right',
    available: true,
    accent: 'mint',
    recommendedMax: 2,
  },
};

// Pure helper. Returns the WARN message to log at kickoff when teamSize
// exceeds the empirical recommendedMax for the pattern; undefined when
// teamSize is within the safe envelope. Centralized here so the route
// handler (#101) and the new-run picker (#103) read from a single
// source of truth, and so the message text is unit-testable in
// isolation. The caller passes the message to console.warn (server)
// or surfaces it inline (client).
export function teamSizeWarningMessage(
  pattern: SwarmPattern,
  teamSize: number,
): string | undefined {
  const meta = patternMeta[pattern];
  if (!meta) return undefined;
  if (teamSize <= meta.recommendedMax) return undefined;
  return (
    `[swarm/run] teamSize=${teamSize} exceeds recommendedMax=${meta.recommendedMax} for pattern '${pattern}' — ` +
    `MAXTEAM-2026-04-26 stress test observed degradation above this size. ` +
    `See docs/STRESS_TESTS/2026-04-26-max-team-size-8.md for failure modes.`
  );
}

// Per-pattern model defaults (2026-04-24 Stage 2 declared-roles). When
// a run request omits teamModels / criticModel / verifierModel /
// auditorModel / teamRoles, the route handler consults this table to
// pre-fill them. Caller-supplied values always win — this only fires
// for unset fields. See route.ts::applyPatternDefaults.
//
// Three ollama-tier models power the defaults after 2026-04-25 evening
// directives:
//   glm-5.1:cloud          — planner seat only (blackboard session[0]);
//                            fast structured-JSON for the planning sweep
//   gemma4:31b-cloud       — every team / critic / verifier / drafter /
//                            judge seat across every pattern
//   nemotron-3-super:cloud — dedicated auditor seat on blackboard runs
//                            (enableAuditorGate default-on for that
//                            pattern). Strongest reasoning tier for the
//                            "is this criterion met?" gate.
//
// `teamModels(n)` returns a length-`n` array; session[0] is planner-
// shaped for blackboard-family patterns, synthesizer for map-reduce,
// orchestrator for orchestrator-worker, judge for debate-judge,
// worker for critic-loop. Convention defined in each pattern's
// orchestrator module; this table matches them.
const GLM = 'ollama/glm-5.1:cloud';
const GEMMA = 'ollama/gemma4:31b-cloud';
const NEMOTRON = 'ollama/nemotron-3-super:cloud';

export interface PatternDefaults {
  teamModels?: (teamSize: number) => string[];
  criticModel?: string;
  verifierModel?: string;
  auditorModel?: string;
  // Map-reduce only: default for `meta.synthesisModel`. Coordinator
  // pins the synth claim to this model regardless of which session
  // claims it. Set when the synthesizer's prompt is heavy enough that
  // a smaller model unreliably produces output. Today's GEMMA on a
  // 3-mapper / ~30K-token synth prompt was the motivating case.
  synthesisModel?: string;
  // Role-differentiated only: default role names the planner's
  // teamRoles uses. Indexed 0..N-1. Array shorter than teamSize
  // cycles; longer arrays are truncated.
  teamRoles?: string[];
  // When true and the request didn't explicitly set enableAuditorGate,
  // the route handler spawns a dedicated auditor opencode session at
  // run creation. Only meaningful for blackboard-family patterns
  // (blackboard / orchestrator-worker) — the route validator rejects
  // it elsewhere.
  enableAuditorGate?: boolean;
}

export const patternDefaults: Record<SwarmPattern, PatternDefaults> = {
  // Baseline pattern: no explicit planner seat, so every session runs on
  // GEMMA per the 2026-04-25 evening directive ("all agents other than
  // planner → gemma4:31b-cloud, all going forward").
  none: {
    teamModels: (n) => Array(n).fill(GEMMA),
  },
  blackboard: {
    // session[0] = planner (display-only role); sessions[1..N-1] = workers.
    // Auditor lives in its own session (enableAuditorGate default-on per
    // 2026-04-25 evening directive). Model assignment per directive:
    //   planner  → GLM     (fast structured-JSON for the planner sweep)
    //   workers  → GEMMA
    //   critic   → GEMMA
    //   verifier → GEMMA
    //   auditor  → NEMOTRON (strongest reasoning tier, batch-rare cadence
    //                        — every K commits + tier escalation + run end
    //                        — so its slower latency is amortized)
    teamModels: (n) => [GLM, ...Array(Math.max(0, n - 1)).fill(GEMMA)],
    criticModel: GEMMA,
    verifierModel: GEMMA,
    auditorModel: NEMOTRON,
    enableAuditorGate: true,
  },
  'map-reduce': {
    // Mappers + synthesizer all on GEMMA per 2026-04-25 evening
    // directive ("all agents other than planner → GEMMA"). Map-reduce
    // has no explicit planner seat — the synth coordinator is closest
    // but still under the rule.
    //
    // Known risk to watch (history): GEMMA reliably produced silent
    // turns when an earlier validation embedded ~30K tokens of mapper
    // drafts in the synth prompt (run_modytfez_frfs8l, 2026-04-25
    // morning). Synth was previously pinned to GLM to skirt that. If
    // synth bounces repeatedly under the new monoculture, override
    // via meta.synthesisModel on a per-run basis or revert this pin.
    teamModels: (n) => Array(n).fill(GEMMA),
    synthesisModel: GEMMA,
  },
  council: {
    // All drafters on GEMMA. Was NEMOTRON — flipped 2026-04-25.
    // Council retest (run_modxga1j_kh4j8k) reproduced the cost
    // pattern: 20 successful nemotron turns in 200s for a 3-sentence
    // directive, each turn 47K input / ~150 output. Drafts were
    // good but the step-loop made the run ~50× more expensive than
    // necessary. GEMMA on the same directive completes in 2-3 turns.
    teamModels: (n) => Array(n).fill(GEMMA),
  },
  'orchestrator-worker': {
    // session[0] = orchestrator (owns strategy + runs the planner sweep);
    // sessions[1..N-1] = workers.
    //
    // Model rationale (2026-04-26 update — Q34 root-cause fix):
    //   orchestrator → GLM (same as blackboard's planner seat)
    //   workers      → GEMMA
    //
    // History: was NEMOTRON pre-2026-04-25 (step-loop cost issue), then
    // all GEMMA per the "all non-planner seats → GEMMA" directive. Q34
    // verify run (run_mog0axza_pzalr8) on 2026-04-26 surfaced the GEMMA
    // failure mode on this seat: GEMMA on the long-context planner
    // sweep prompt (~37K chars: README + board context) emits PSEUDO-
    // TOOL-CALL TEXT instead of invoking the real todowrite tool —
    // `<\|tool>glob{...}<tool\|>` etc. as plain text, parts.tools=[].
    // Same pathology likely caused both prior `opencode-frozen` events
    // (model spinning on pseudo-tool-text until F1 watchdog stops it).
    //
    // The orchestrator IS the planner-equivalent for orchestrator-worker
    // (it runs `runPlannerSweep`), and GLM was empirically proven on
    // blackboard runs to call todowrite reliably on the same prompt
    // shape. Per the "all non-planner seats → GEMMA" directive the
    // orchestrator IS a planner seat; it should match blackboard's
    // session[0] model. Workers stay on GEMMA — they don't run the
    // planner sweep, just claim/implement todos.
    teamModels: (n) => [GLM, ...Array(Math.max(0, n - 1)).fill(GEMMA)],
  },
  'debate-judge': {
    // Judge + generators all on GEMMA per 2026-04-25 evening directive.
    // Generators previously rotated GEMMA / GLM for draft divergence;
    // monoculture risk now exists but the user accepted it as a tradeoff
    // for uniformity. If draft variance collapses noticeably, revisit.
    teamModels: (n) => Array(n).fill(GEMMA),
  },
  'critic-loop': {
    // session[0] = worker, session[1] = critic — both on GEMMA per
    // 2026-04-25 evening directive. Critic was previously GLM for
    // fast iteration cadence; the cost/latency hit of running GEMMA
    // on the critic seat is accepted under the new rule. Pattern
    // requires exactly teamSize=2.
    teamModels: () => [GEMMA, GEMMA],
  },
};

// Static class-name maps so Tailwind's JIT purger keeps these utilities in
// the final bundle. Dynamic `text-${accent}` interpolation would be purged.
export const patternAccentText: Record<PatternMeta['accent'], string> = {
  molten: 'text-molten',
  amber: 'text-amber',
  mint: 'text-mint',
  iris: 'text-iris',
  rust: 'text-rust',
  fog: 'text-fog-400',
};

export const patternAccentBorder: Record<PatternMeta['accent'], string> = {
  molten: 'border-molten/40',
  amber: 'border-amber/40',
  mint: 'border-mint/40',
  iris: 'border-iris/40',
  rust: 'border-rust/40',
  fog: 'border-fog-500/40',
};
