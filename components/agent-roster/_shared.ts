//
// Cross-cutting bits used by both the main AgentRoster (table-level)
// and the AgentRow sub-tree (row-level). Lifted into a sibling so the
// row file imports without back-importing the parent.

import type { Agent, AgentStatus } from '@/lib/swarm-types';

export const accentStripe: Record<Agent['accent'], string> = {
  molten: 'bg-molten',
  mint: 'bg-mint',
  iris: 'bg-iris',
  amber: 'bg-amber',
  fog: 'bg-fog-500',
};

export const accentText: Record<Agent['accent'], string> = {
  molten: 'text-molten',
  mint: 'text-mint',
  iris: 'text-iris',
  amber: 'text-amber',
  fog: 'text-fog-400',
};

export const statusMeta: Record<AgentStatus, { label: string; color: string }> = {
  idle: { label: 'idle', color: 'text-mint' },
  thinking: { label: 'thinking', color: 'text-molten' },
  working: { label: 'working', color: 'text-molten' },
  waiting: { label: 'waiting', color: 'text-amber' },
  paused: { label: 'paused', color: 'text-fog-500' },
  done: { label: 'done', color: 'text-sky' },
  error: { label: 'error', color: 'text-rust' },
};

export type AttentionKind = 'error' | 'pending' | 'retry';

export const kindTone: Record<AttentionKind, { text: string; label: string }> = {
  error: { text: 'text-rust', label: 'error' },
  pending: { text: 'text-amber', label: 'perm' },
  retry: { text: 'text-iris', label: 'retry' },
};
