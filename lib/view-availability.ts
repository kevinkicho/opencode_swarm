// Single source of truth for which view tabs are available given a
// run's pattern + board state. Used by:
//
//   - app/page.tsx — toolbar render (renders ALL tabs; disabled state
//     for those whose gate fails) + switch fallback to EmptyViewState
//   - components/view-availability-matrix.tsx — the patterns × views
//     reference chart shown inside non-applicable empty states
//
// Pre-2026-04-28 the gate predicates lived inline in app/page.tsx as
// VIEW_PATTERN_GATES; the matrix component would have had to duplicate
// the per-pattern rules. Lifting them here keeps both surfaces in
// sync.

import type { SwarmPattern } from './swarm-types';

export type RunView =
  | 'timeline'
  | 'chat'
  | 'cards'
  | 'board'
  | 'contracts'
  | 'iterations'
  | 'debate'
  | 'map'
  | 'council'
  | 'strategy';

export interface ViewGateContext {
  pattern: SwarmPattern | undefined;
  boardSwarmRunID: string | null;
}

export interface ViewMeta {
  // One-line hint for the toolbar tooltip.
  hint: string;
  // Predicate: enabled given the active run's pattern + board state.
  enabled: (ctx: ViewGateContext) => boolean;
  // Concrete description for the empty-state card. Should answer
  // "what does this view show me?" in one sentence.
  description: string;
  // The patterns under which this view is data-bound. Used by the
  // empty state ("available when running: …") + the reference matrix.
  // Empty array = always available (timeline / chat / cards).
  availablePatterns: readonly SwarmPattern[];
}

// Patterns that orchestrate via a shared blackboard. The board +
// contracts views are gated on this; today only blackboard +
// orchestrator-worker. Update both this list and the gates in
// app/page.tsx::boardPatterns when expanding.
export const BOARD_PATTERNS: readonly SwarmPattern[] = [
  'blackboard',
  'orchestrator-worker',
];

export const VIEW_META: Record<RunView, ViewMeta> = {
  timeline: {
    hint: 'cross-lane event flow with A2A wires',
    enabled: () => true,
    description: 'Cross-lane event flow — every part fired by every agent, A2A wires showing handoffs.',
    availablePatterns: [],
  },
  chat: {
    hint: 'chronological per-agent bubble stream · tool calls fold as chips',
    enabled: () => true,
    description: 'Chronological per-agent bubbles. Tool calls fold into chips so the conversation reads naturally.',
    availablePatterns: [],
  },
  cards: {
    hint: 'per-turn conversation cards · collapses tool calls into chips',
    enabled: () => true,
    description: 'Per-turn cards. One card per assistant turn — best when scanning for what each turn produced.',
    availablePatterns: [],
  },
  board: {
    hint: 'full blackboard kanban · todos / claims / findings',
    enabled: (ctx) => !!ctx.boardSwarmRunID,
    description: 'Full blackboard kanban — todos, claims, findings, criteria. The shared work surface for board-orchestrated runs.',
    availablePatterns: BOARD_PATTERNS,
  },
  contracts: {
    hint: 'auditor verdicts against acceptance criteria',
    enabled: (ctx) => !!ctx.boardSwarmRunID,
    description: 'Auditor verdicts against acceptance criteria. CAS-drift, busywork-rejected, retry budgets — the contractual lens of a board run.',
    availablePatterns: BOARD_PATTERNS,
  },
  iterations: {
    hint: 'critic-loop: worker draft → critic review → revise',
    enabled: (ctx) => ctx.pattern === 'critic-loop',
    description: 'Per-iteration draft → critic review → revise loop. Each row tracks one round of refinement.',
    availablePatterns: ['critic-loop'],
  },
  debate: {
    hint: 'debate-judge: N generators propose, judge picks',
    enabled: (ctx) => ctx.pattern === 'debate-judge',
    description: 'Debate matrix — N generators propose per round, judge verdict (WINNER / MERGE / REVISE). Each row is one round.',
    availablePatterns: ['debate-judge'],
  },
  map: {
    hint: 'map-reduce: per-mapper drafts + synthesis claim',
    enabled: (ctx) => ctx.pattern === 'map-reduce',
    description: 'MAP per-session drafts followed by the REDUCE synthesis row. Phase-transition banner when MAP completes.',
    availablePatterns: ['map-reduce'],
  },
  council: {
    hint: "council members' drafts + reconciliation",
    enabled: (ctx) => ctx.pattern === 'council',
    description: 'Per-round member drafts + convergence chip (token-jaccard across drafts). Tracks consensus per round.',
    availablePatterns: ['council'],
  },
  strategy: {
    hint: 'orchestrator-worker: planner sweeps + re-plan history',
    enabled: (ctx) => ctx.pattern === 'orchestrator-worker',
    description: 'Planner sweeps + re-plan history. Each entry is one strategic decision the orchestrator made about the workers.',
    availablePatterns: ['orchestrator-worker'],
  },
};

export const RUN_VIEW_KEYS = Object.keys(VIEW_META) as RunView[];

// Stable order matching the toolbar render. Keeps the reference matrix
// readable (no shuffling between renders).
export const ALL_PATTERNS: readonly SwarmPattern[] = [
  'none',
  'blackboard',
  'map-reduce',
  'council',
  'orchestrator-worker',
  'debate-judge',
  'critic-loop',
];
