// HARDENING_PLAN.md#C14 — retro-view decomposition.
//
// Cross-cutting bits used by both the main RetroView (run-level) and
// the AgentRollupCard sub-tree (agent-level). Pulling them out lets
// agent-blocks.tsx import from a sibling file rather than crossing
// back into retro-view.tsx — same pattern as transform/_shared.ts.

export const OUTCOME_TONE: Record<string, { dot: string; text: string }> = {
  completed: { dot: 'bg-mint', text: 'text-mint' },
  merged:    { dot: 'bg-mint', text: 'text-mint' },
  partial:   { dot: 'bg-amber', text: 'text-amber' },
  discarded: { dot: 'bg-fog-500', text: 'text-fog-400' },
  aborted:   { dot: 'bg-rust', text: 'text-rust' },
  failed:    { dot: 'bg-rust', text: 'text-rust' },
};

export function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
