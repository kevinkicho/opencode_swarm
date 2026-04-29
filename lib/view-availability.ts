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

// Order matters: this is the order RUN_VIEW_KEYS surfaces in the
// toolbar AND the default-view fallback. `chat` leads because it's
// the universally-familiar lens — most users coming in from any
// agent product expect chat first, timeline second. 2026-04-28 swap.
export type RunView =
  | 'chat'
  | 'timeline'
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

// Coarse "is there data to show in this view right now?" predicate.
// The toolbar uses this to pick brightness — bright when content is
// available for that view on the active run, dim otherwise. Pattern
// applicability is a necessary precondition; per-view data signals
// (messages / board items / slots) confirm there's actually something
// to render.
export interface ViewContentContext extends ViewGateContext {
  messageCount: number;
  turnCardCount: number;
  boardItemCount: number;
  // Per-session assistant-message count for the active run's slots.
  // Used by the per-pattern rails (iterations/debate/map/council) to
  // tell "session created but nothing produced yet" from "session
  // produced ≥1 assistant turn." Order is the slot order — same order
  // the rail components read.
  slotAssistantCounts: readonly number[];
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
  chat: {
    hint: 'chronological per-agent bubble stream · tool calls fold as chips',
    enabled: () => true,
    description: 'Chronological per-agent bubbles. Tool calls fold into chips so the conversation reads naturally — the universally-familiar agent lens.',
    availablePatterns: [],
  },
  timeline: {
    hint: 'cross-lane event flow with A2A wires',
    enabled: () => true,
    description: 'Cross-lane event flow — every part fired by every agent, A2A wires showing handoffs. Best for understanding multi-agent coordination at a glance.',
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

export function viewHasContent(view: RunView, ctx: ViewContentContext): boolean {
  // Always-applicable views (timeline / chat / cards) — bound when
  // any messages have arrived. messageCount being > 0 is the cleanest
  // signal because it covers loading-from-snapshot + live-streaming.
  if (view === 'timeline' || view === 'chat') return ctx.messageCount > 0;
  if (view === 'cards') return ctx.turnCardCount > 0;

  // Board-pattern views — board exists AND has items. `contracts`
  // could narrow further to criterion items only, but the rail's own
  // empty-state already handles "no contracts yet"; bright vs dim at
  // the tab level is fine on the coarser "any items" signal.
  if (view === 'board' || view === 'contracts') return ctx.boardItemCount > 0;

  // Pattern-specific rails — first check pattern matches, then check
  // there's actually slot content. `iterations` / `debate` / `council`
  // need ≥1 assistant message somewhere. `map` reads scope text from
  // user prompts so any non-empty slot count works. `strategy` needs
  // both the board (for plan items) and the orchestrator-worker pattern.
  if (view === 'iterations') {
    return ctx.pattern === 'critic-loop' && ctx.slotAssistantCounts.some((n) => n > 0);
  }
  if (view === 'debate') {
    return ctx.pattern === 'debate-judge' && ctx.slotAssistantCounts.some((n) => n > 0);
  }
  if (view === 'map') {
    return ctx.pattern === 'map-reduce' && ctx.slotAssistantCounts.length > 0;
  }
  if (view === 'council') {
    return ctx.pattern === 'council' && ctx.slotAssistantCounts.some((n) => n > 0);
  }
  if (view === 'strategy') {
    return ctx.pattern === 'orchestrator-worker' && !!ctx.boardSwarmRunID;
  }
  return false;
}
