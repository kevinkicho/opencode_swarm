// UI metadata for the orchestration-pattern picker in new-run-modal.
// The canonical catalog lives in `SWARM_PATTERNS.md` — keep taglines and
// availability flags in sync there when promoting a preset.

import type { SwarmPattern } from './swarm-types';

export interface PatternMeta {
  label: string;
  tagline: string;          // short description shown inside the tile
  // Concrete mechanics — rendered as a second dimmer line under the
  // tagline so users can eyeball "how many sessions / what loop / what
  // ceiling" without reading SWARM_PATTERNS.md. Keep ≤ ~55 chars to fit
  // two-line tiles cleanly.
  shape: string;
  // When to reach for it. One line, hover-revealable in the tile or
  // rendered in the recipe preview. Keep concrete; avoid "when you want
  // to solve problem X" hedges.
  fit: string;
  available: boolean;       // drives disabled state + "coming soon" indicator
  accent: 'molten' | 'amber' | 'mint' | 'iris' | 'rust' | 'fog';
}

export const patternMeta: Record<SwarmPattern, PatternMeta> = {
  none: {
    label: 'none',
    tagline: 'single opencode session, native task / subtask',
    shape: '1 session · opencode task-tool A2A only',
    fit: 'small focused work; baseline to compare multi-session shapes against',
    available: true,
    accent: 'molten',
  },
  blackboard: {
    label: 'blackboard',
    tagline: 'shared board, claim any unresolved todo',
    shape: 'N sessions · auto-ticker · CAS-safe shared board',
    fit: 'broad parallel work; self-organizing teams on independent todos',
    available: true,
    accent: 'amber',
  },
  'map-reduce': {
    label: 'map-reduce',
    tagline: 'split the tree, synthesize as a claimable phase',
    shape: 'N parallel slices → 1 synthesizer (board-claimed)',
    fit: 'large surveys or surveys-of-surveys where one merge step suffices',
    available: true,
    accent: 'mint',
  },
  council: {
    label: 'council',
    tagline: 'n parallel drafts, human reconciles via permissions',
    shape: 'N parallel drafts · auto R1→R2→R3 · reconcile strip',
    fit: 'design / architecture decisions where divergence beats convergence',
    available: true,
    accent: 'iris',
  },
  'orchestrator-worker': {
    label: 'orchestrator',
    tagline: 'one orchestrator plans, n workers claim and implement',
    shape: '1 orchestrator + N-1 workers · board-driven dispatch',
    fit: 'long missions where a persistent planner owns strategy',
    available: true,
    accent: 'rust',
  },
  'role-differentiated': {
    label: 'roles',
    tagline: 'n workers with pinned roles (architect, tester, …)',
    shape: 'N specialized roles · optional [role:X] soft routing',
    fit: 'work with clear sub-disciplines (frontend/backend, code/docs/tests)',
    available: true,
    accent: 'iris',
  },
  'debate-judge': {
    label: 'debate',
    tagline: 'n generators propose, one judge evaluates and picks',
    shape: 'N-1 generators + 1 judge · WINNER/MERGE/REVISE · ≤ 3 rounds',
    fit: 'binary or scored choices between well-framed alternatives',
    available: true,
    accent: 'amber',
  },
  'critic-loop': {
    label: 'critic',
    tagline: 'worker drafts, critic reviews, worker revises (n iterations)',
    shape: '1 worker + 1 critic · APPROVED/REVISE · ≤ 3 iterations',
    fit: 'non-binary quality (copy, architecture, UX) where first pass is rarely right',
    available: true,
    accent: 'mint',
  },
  'deliberate-execute': {
    label: 'deliberate→execute',
    tagline: 'council deliberation → synthesis → blackboard execution',
    shape: 'council rounds → synthesis → blackboard drain · 15 min turn ceil',
    fit: 'think deeply, then build — framing matters more than execution speed',
    available: true,
    accent: 'fog',
  },
};

// Per-pattern model defaults (2026-04-24 Stage 2 declared-roles). When
// a run request omits teamModels / criticModel / verifierModel /
// auditorModel / teamRoles, the route handler consults this table to
// pre-fill them. Caller-supplied values always win — this only fires
// for unset fields. See route.ts::applyPatternDefaults.
//
// Three ollama-tier models power the defaults (user's 2026-04-24
// recommendation table):
//   glm-5.1:cloud          — balanced, fast, good at structured JSON
//   gemma4:31b-cloud       — instruction-tuned, solid code, parallel-friendly
//   nemotron-3-super:cloud — strongest reasoning tier, slower
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
  // Role-differentiated only: default role names the planner's
  // teamRoles uses. Indexed 0..N-1. Array shorter than teamSize
  // cycles; longer arrays are truncated.
  teamRoles?: string[];
}

export const patternDefaults: Record<SwarmPattern, PatternDefaults> = {
  // Even the baseline pattern gets a default now — without teamModels
  // pinning, the session falls back to opencode.json's root model which
  // is typically a zen/go-tier default. For ollama-only runs we want
  // the baseline on GLM (fastest of the three) for calibration.
  none: {
    teamModels: (n) => Array(n).fill(GLM),
  },
  blackboard: {
    // session[0] = planner (display-only role); sessions[1..N-1] = workers.
    teamModels: (n) => [GLM, ...Array(Math.max(0, n - 1)).fill(GEMMA)],
    criticModel: GLM,
    verifierModel: GEMMA,
    auditorModel: NEMOTRON,
  },
  'map-reduce': {
    // Synthesizer + mappers all on GEMMA. Was [NEMOTRON, ...GEMMA]
    // — flipped 2026-04-25 alongside orchestrator-worker after the
    // step-loop cost behaviour also surfaced on the council retest.
    // See orchestrator-worker comment for full evidence + reasoning.
    teamModels: (n) => Array(n).fill(GEMMA),
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
    // session[0] = orchestrator (owns strategy for long runs);
    // sessions[1..N-1] = workers.
    //
    // Swapped 2026-04-25: orchestrator was NEMOTRON, now GEMMA.
    // Retest with --log-level DEBUG (run_modx3mv5_cpwh93) reproduced
    // a fail mode where nemotron-through-opencode loops on todowrite
    // — 18 successful assistant turns in 200s, each re-emitting the
    // same 10 todo items, board never seeded. Functionally equivalent
    // to the original "silent 14m" symptom (run_mod5dy6n_utsb32) for
    // this pattern's purposes. Direct ollama API works fine for
    // nemotron, so the issue is opencode's wrapper handling of
    // step-tool-step loops on this specific model. GEMMA fills the
    // orchestrator seat without the loop. Other patterns that put
    // nemotron in non-planner seats (council drafters, map-reduce
    // synthesizer, debate judge, role-differentiated architect)
    // were NOT changed — those seats don't use todowrite, so the
    // observed failure mode wouldn't apply. Each gated on its own
    // retest if a problem surfaces.
    teamModels: (n) => Array(n).fill(GEMMA),
  },
  'role-differentiated': {
    // Role-indexed defaults. All roles on GEMMA after 2026-04-25
    // swap — was {architect/reviewer/security: NEMOTRON, ...GEMMA,
    // docs: GLM}. NEMOTRON's step-loop cost behaviour (see
    // orchestrator-worker + council comments) made it expensive in
    // any drafting seat; flipped uniformly here for consistency.
    // teamRoles rotates through the canonical role list when the
    // request doesn't supply its own.
    teamModels: (n) => {
      const roles = ['architect', 'builder', 'tester', 'reviewer', 'security', 'docs', 'ux', 'data'];
      const roleModel: Record<string, string> = {
        architect: GEMMA,
        reviewer: GEMMA,
        security: GEMMA,
        builder: GEMMA,
        tester: GEMMA,
        ux: GEMMA,
        data: GEMMA,
        docs: GLM,
      };
      const out: string[] = [];
      for (let i = 0; i < n; i += 1) {
        const role = roles[i % roles.length];
        out.push(roleModel[role] ?? GEMMA);
      }
      return out;
    },
    teamRoles: ['architect', 'builder', 'tester', 'reviewer', 'security', 'docs', 'ux', 'data'],
  },
  'debate-judge': {
    // Judge on GEMMA, generators rotate GEMMA / GLM. Was NEMOTRON
    // judge + cycle including NEMOTRON — swapped 2026-04-25 to
    // skirt the step-loop cost issue (see orchestrator-worker
    // comment). Two-model rotation still gives draft divergence;
    // monoculture risk is low because judge differs from generators.
    teamModels: (n) => {
      const generatorCycle = [GEMMA, GLM];
      const out: string[] = [GEMMA]; // judge
      for (let i = 1; i < n; i += 1) {
        out.push(generatorCycle[(i - 1) % generatorCycle.length]);
      }
      return out;
    },
  },
  'critic-loop': {
    // session[0] = worker (gemma4 — code), session[1] = critic (glm —
    // fast iteration cycle). Pattern requires exactly teamSize=2.
    teamModels: () => [GEMMA, GLM],
  },
  'deliberate-execute': {
    // Council-style deliberation then blackboard-style execution on
    // the same session pool. All sessions on GEMMA after 2026-04-25
    // swap — was NEMOTRON. Same step-loop cost issue applies (see
    // orchestrator-worker + council comments). Phase-switching
    // model support is still a follow-up; running both phases on
    // GEMMA is the safer cost default until that's built.
    teamModels: (n) => Array(n).fill(GEMMA),
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
