'use client';

import clsx from 'clsx';
import { useMemo, useState } from 'react';
import type { Agent, AgentMessage, TodoItem } from '@/lib/swarm-types';
import { Tooltip } from './ui/tooltip';
import { IconPlus } from './icons';
import { computeAttention, type Attention } from '@/lib/agent-status';
// HARDENING_PLAN.md#C14 — accent / status / attention lookup tables
// lifted to ./agent-roster/_shared.ts so AgentRow + ActiveTodoChip +
// AttentionBadge can import them without crossing back into this file.
import { kindTone, type AttentionKind } from './agent-roster/_shared';
import { AgentRow } from './agent-roster/agent-row';

export function AgentRoster({
  agents,
  messages,
  todos,
  selectedId,
  onSelect,
  onInspect,
  onFocus,
  onSpawn,
  embedded = false,
}: {
  agents: Agent[];
  messages: AgentMessage[];
  todos: TodoItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onInspect: (id: string) => void;
  onFocus: (id: string) => void;
  onSpawn?: () => void;
  embedded?: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const active = agents.filter((a) => a.status === 'working' || a.status === 'thinking').length;

  const attentionByAgent = useMemo(() => {
    const map = new Map<string, Attention>();
    for (const a of agents) map.set(a.id, computeAttention(a, messages));
    return map;
  }, [agents, messages]);

  // Owned-in-progress todos per agent. Surfaced as a row-level "→ item X"
  // chip so the roster answers "what is this agent doing right now?" without
  // requiring a tab switch to the plan. Binding source is transform.ts's
  // hash-match; see DESIGN.md §8.
  const todosByAgent = useMemo(() => {
    const map = new Map<string, TodoItem[]>();
    for (const t of todos) {
      if (!t.ownerAgentId || t.status !== 'in_progress') continue;
      const arr = map.get(t.ownerAgentId) ?? [];
      arr.push(t);
      map.set(t.ownerAgentId, arr);
    }
    return map;
  }, [todos]);

  const body = (
    <ul className="flex-1 overflow-y-auto py-1.5">
      {agents.map((a) => (
        <AgentRow
          key={a.id}
          agent={a}
          attention={attentionByAgent.get(a.id)!}
          activeTodos={todosByAgent.get(a.id) ?? []}
          selected={selectedId === a.id}
          expanded={expandedId === a.id}
          onToggleExpand={() => setExpandedId((p) => (p === a.id ? null : a.id))}
          onSelect={() => onSelect(a.id)}
          onInspect={() => onInspect(a.id)}
          onFocus={onFocus}
        />
      ))}
    </ul>
  );

  if (embedded) return body;

  return (
    <section className="relative flex flex-col min-w-0 min-h-0 bg-ink-850 hairline-r">
      <div className="h-10 hairline-b px-4 flex items-center gap-2 bg-ink-850/80 backdrop-blur">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          roster
        </span>
        <Tooltip
          content={`${active} of ${agents.length} agents are live`}
          side="bottom"
        >
          <span className="font-mono text-micro text-fog-700 cursor-default">
            {active}/{agents.length}
          </span>
        </Tooltip>
        <Tooltip content="spawn new agent" side="bottom" align="end">
          <button
            onClick={onSpawn}
            className="ml-auto w-6 h-6 grid place-items-center rounded hairline bg-ink-800 hover:border-molten/40 hover:text-molten text-fog-500 transition"
          >
            <IconPlus size={11} />
          </button>
        </Tooltip>
      </div>

      {body}
    </section>
  );
}
