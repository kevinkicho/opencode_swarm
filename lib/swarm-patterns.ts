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
