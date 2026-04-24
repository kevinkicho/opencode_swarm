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
  none: {},
  blackboard: {
    // session[0] = planner (display-only role); sessions[1..N-1] = workers.
    teamModels: (n) => [GLM, ...Array(Math.max(0, n - 1)).fill(GEMMA)],
    criticModel: GLM,
    verifierModel: GEMMA,
    auditorModel: NEMOTRON,
  },
  'map-reduce': {
    // session[0] = synthesizer (reuses the same session for the later
    // synth phase via a 'synthesize' board item); sessions[1..N-1] =
    // mappers. Upgrade session[0] to nemotron — merging is the hard
    // part. Mappers stay on gemma4.
    teamModels: (n) => [NEMOTRON, ...Array(Math.max(0, n - 1)).fill(GEMMA)],
  },
  council: {
    // All drafters strongest tier — each owns a full proposal and
    // divergence is the whole point. Mixing is a user override.
    teamModels: (n) => Array(n).fill(NEMOTRON),
  },
  'orchestrator-worker': {
    // session[0] = orchestrator (owns strategy for long runs);
    // sessions[1..N-1] = workers.
    teamModels: (n) => [NEMOTRON, ...Array(Math.max(0, n - 1)).fill(GEMMA)],
  },
  'role-differentiated': {
    // Role-indexed defaults. Architect / reviewer / security carry
    // strongest reasoning; builder / tester / ux / data are worker-
    // shaped; docs is balanced. teamRoles rotates through this list
    // when the request doesn't supply its own.
    teamModels: (n) => {
      const roles = ['architect', 'builder', 'tester', 'reviewer', 'security', 'docs', 'ux', 'data'];
      const roleModel: Record<string, string> = {
        architect: NEMOTRON,
        reviewer: NEMOTRON,
        security: NEMOTRON,
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
    // session[0] = judge (authoritative verdict); sessions[1..N-1] =
    // generators. Mix generators for divergence: rotate through
    // nemotron, gemma, glm so multi-draft runs get different
    // reasoning styles instead of a monoculture.
    teamModels: (n) => {
      const generatorCycle = [NEMOTRON, GEMMA, GLM];
      const out: string[] = [NEMOTRON]; // judge
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
    // the same session pool. Current code structure can't switch
    // models mid-run, so we pin all sessions to nemotron — the
    // council phase is the most important, and gemma-range tasks in
    // the execution phase are acceptable on a stronger model.
    // Phase-switching model support is a follow-up.
    teamModels: (n) => Array(n).fill(NEMOTRON),
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
