'use client';

import clsx from 'clsx';
import { useMemo, useState } from 'react';
import type { Agent, AgentMessage, AgentStatus, TodoItem } from '@/lib/swarm-types';
import { ProviderBadge } from './provider-badge';
import { Tooltip } from './ui/tooltip';
import { Popover } from './ui/popover';
import { StatsStream } from './ui/stats-stream';
import { IconPlus } from './icons';
import { ToolList } from './part-chip';
import { compact } from '@/lib/format';
import {
  computeAttention,
  statusCircle,
  type Attention,
} from '@/lib/agent-status';

const accentStripe: Record<Agent['accent'], string> = {
  molten: 'bg-molten',
  mint: 'bg-mint',
  iris: 'bg-iris',
  amber: 'bg-amber',
  fog: 'bg-fog-500',
};

const accentText: Record<Agent['accent'], string> = {
  molten: 'text-molten',
  mint: 'text-mint',
  iris: 'text-iris',
  amber: 'text-amber',
  fog: 'text-fog-400',
};

const statusMeta: Record<AgentStatus, { label: string; color: string }> = {
  idle: { label: 'idle', color: 'text-mint' },
  thinking: { label: 'thinking', color: 'text-molten' },
  working: { label: 'working', color: 'text-molten' },
  waiting: { label: 'waiting', color: 'text-amber' },
  paused: { label: 'paused', color: 'text-fog-500' },
  done: { label: 'done', color: 'text-sky' },
  error: { label: 'error', color: 'text-rust' },
};

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

function AgentRow({
  agent,
  attention,
  activeTodos,
  selected,
  expanded,
  onToggleExpand,
  onSelect,
  onInspect,
  onFocus,
}: {
  agent: Agent;
  attention: Attention;
  activeTodos: TodoItem[];
  selected: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onSelect: () => void;
  onInspect: () => void;
  onFocus: (id: string) => void;
}) {
  const st = statusMeta[agent.status];
  const tokenPct = Math.min(100, Math.round((agent.tokensUsed / agent.tokensBudget) * 100));
  const circle = statusCircle(agent, attention);

  return (
    <li
      className={clsx(
        'relative transition group',
        selected && 'bg-ink-800/80'
      )}
    >
      {selected && (
        <span className="absolute right-0 top-0 bottom-0 w-[1px] bg-molten" />
      )}

      <button
        onClick={() => {
          onToggleExpand();
          onSelect();
        }}
        className="w-full text-left pl-3 pr-3 py-2 flex items-center gap-2.5 hover:bg-ink-800/60 transition relative"
      >
        <span
          className={clsx(
            'absolute left-0 top-0 bottom-0 w-[2px]',
            accentStripe[agent.accent],
            !selected && !circle.animation && 'opacity-50'
          )}
        />

        <Tooltip
          side="right"
          wide
          content={
            <div className="space-y-1">
              <div className="font-mono text-[11px] text-fog-200">
                <span className={st.color}>{st.label}</span>
                {agent.focus && <span className="text-fog-500"> - {agent.focus}</span>}
              </div>
              <div className="font-mono text-[10.5px] text-fog-600">
                {compact(agent.tokensUsed)} tokens ${agent.costUsed.toFixed(2)} sent {agent.messagesSent} recv {agent.messagesRecv}
              </div>
            </div>
          }
        >
          <span className="flex items-center gap-1.5 cursor-default shrink-0">
            <span
              className={clsx(
                'w-1.5 h-1.5 rounded-full',
                circle.dot,
                circle.animation,
              )}
            />
          </span>
        </Tooltip>

        <span className="text-[13px] text-fog-100 truncate flex-1 min-w-0 cursor-default">
          {agent.name}
        </span>

        {activeTodos.length > 0 && (
          <ActiveTodoChip
            todos={activeTodos}
            accent={agent.accent}
            onFocus={onFocus}
          />
        )}

        <AttentionBadge attention={attention} onFocus={onFocus} />
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-0 animate-fade-up">
          <div className="rounded-md bg-ink-900/60 hairline p-2.5 space-y-2">
            <div>
              <ProviderBadge provider={agent.model.provider} label={agent.model.label} size="sm" clickable />
            </div>

            <div className="pt-1">
              <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 mb-1">
                tools
              </div>
              <ToolList tools={agent.tools} size="xs" />
            </div>

            {agent.focus && (
              <div className="text-[11.5px] text-fog-400 leading-snug">
                {agent.focus}
              </div>
            )}

            <div className="space-y-1.5">
              <div className="flex items-center gap-2 font-mono text-micro text-fog-600">
                <span>tokens</span>
                <span className="text-fog-200 tabular-nums ml-auto">
                  {compact(agent.tokensUsed)} / {compact(agent.tokensBudget)}
                </span>
              </div>
              <div className="h-[3px] rounded-full bg-ink-900 overflow-hidden">
                <div
                  className={clsx(
                    'h-full rounded-full',
                    tokenPct > 80 ? 'bg-rust' : tokenPct > 60 ? 'bg-amber' : 'bg-fog-500/70'
                  )}
                  style={{ width: `${tokenPct}%` }}
                />
              </div>
            </div>

            <div className="flex items-center gap-3 font-mono text-micro text-fog-600">
              <Popover
                side="right"
                align="start"
                content={() => (
                  <StatsStream
                    live={agent.status === 'working' || agent.status === 'thinking'}
                    seed={{
                      label: `${agent.name} live`,
                      tokens: agent.tokensUsed,
                      cost: agent.costUsed,
                      duration: 12,
                      status:
                        agent.status === 'working' || agent.status === 'thinking'
                          ? 'running'
                          : agent.status === 'error'
                            ? 'error'
                            : agent.status === 'done'
                              ? 'complete'
                              : 'queued',
                    }}
                  />
                )}
              >
                <button
                  onClick={(e) => e.stopPropagation()}
                  className="tabular-nums cursor-pointer hover:text-fog-200 transition"
                  aria-label="view cost stream"
                >
                  ${agent.costUsed.toFixed(2)}
                </button>
              </Popover>
              <Tooltip content={`${agent.messagesSent} messages sent`} side="top">
                <span className="tabular-nums cursor-help">sent {agent.messagesSent}</span>
              </Tooltip>
              <Tooltip content={`${agent.messagesRecv} messages received`} side="top">
                <span className="tabular-nums cursor-help">recv {agent.messagesRecv}</span>
              </Tooltip>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onInspect();
                }}
                className="ml-auto font-mono text-micro uppercase tracking-wider text-fog-400 hover:text-molten transition"
              >
                inspect
              </button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

// Compact chip on an agent row: "→ item B". Click jumps to the task-tool
// message that bound the todo. Multi-todo case shows a "+N" suffix; the
// Popover reveals the full list. Positioned inline between name and the
// attention badge so a single glance answers "what is this agent doing?".
function ActiveTodoChip({
  todos,
  accent,
  onFocus,
}: {
  todos: TodoItem[];
  accent: Agent['accent'];
  onFocus: (messageId: string) => void;
}) {
  const primary = todos[0];
  const extra = todos.length - 1;
  const toneText: Record<Agent['accent'], string> = {
    molten: 'text-molten',
    mint: 'text-mint',
    iris: 'text-iris',
    amber: 'text-amber',
    fog: 'text-fog-300',
  };

  const jumpTo = (messageId?: string) => {
    if (messageId) onFocus(messageId);
  };

  const content = (close?: () => void) => (
    <div className="py-1 min-w-[220px]">
      <div className="px-2 pt-1 pb-1.5 flex items-center gap-2">
        <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-500">
          in progress
        </span>
        <span className="ml-auto font-mono text-[9.5px] tabular-nums text-fog-600">
          {todos.length}
        </span>
      </div>
      <ul className="hairline-t">
        {todos.map((t) => {
          const clickable = !!t.taskMessageId;
          return (
            <li key={t.id}>
              <button
                type="button"
                disabled={!clickable}
                onClick={() => {
                  jumpTo(t.taskMessageId);
                  close?.();
                }}
                className={clsx(
                  'w-full grid grid-cols-[28px_1fr] items-center gap-2 px-2 h-6 text-left border-b border-ink-800 last:border-b-0 transition',
                  clickable ? 'hover:bg-ink-800 cursor-pointer' : 'cursor-default'
                )}
              >
                <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-500">
                  {t.id}
                </span>
                <span className="text-[11px] text-fog-200 truncate leading-none">
                  {t.content}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <span onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <Popover side="right" align="start" width={280} content={content}>
        <span
          className={clsx(
            'shrink-0 inline-flex items-center gap-1 h-4 px-1 rounded-sm cursor-pointer',
            'bg-ink-900/60 hairline hover:border-molten/40 transition max-w-[110px]',
          )}
        >
          <span className={clsx('font-mono text-[9px] uppercase tracking-widest2', toneText[accent])}>
            →
          </span>
          <span className="font-mono text-[10px] text-fog-300 truncate min-w-0">
            {primary.content}
          </span>
          {extra > 0 && (
            <span className="font-mono text-[9.5px] tabular-nums text-fog-600 shrink-0">
              +{extra}
            </span>
          )}
        </span>
      </Popover>
    </span>
  );
}

type AttentionKind = 'error' | 'pending' | 'retry';

const kindTone: Record<AttentionKind, { text: string; label: string }> = {
  error: { text: 'text-rust', label: 'error' },
  pending: { text: 'text-amber', label: 'perm' },
  retry: { text: 'text-iris', label: 'retry' },
};

function AttentionBadge({
  attention,
  onFocus,
}: {
  attention: Attention;
  onFocus: (id: string) => void;
}) {
  const total = attention.pending.length + attention.errors.length + attention.retries.length;
  if (total === 0) return null;

  const severity: AttentionKind =
    attention.errors.length > 0
      ? 'error'
      : attention.pending.length > 0
        ? 'pending'
        : 'retry';

  const tone =
    severity === 'error'
      ? { dot: 'bg-rust', ring: 'ring-rust/40', text: 'text-rust' }
      : severity === 'pending'
        ? { dot: 'bg-amber', ring: 'ring-amber/40', text: 'text-amber' }
        : { dot: 'bg-iris', ring: 'ring-iris/40', text: 'text-iris' };

  const rows: Array<{ msg: AgentMessage; kind: AttentionKind }> = [
    ...attention.errors.map((m) => ({ msg: m, kind: 'error' as const })),
    ...attention.pending.map((m) => ({ msg: m, kind: 'pending' as const })),
    ...attention.retries.map((m) => ({ msg: m, kind: 'retry' as const })),
  ];

  return (
    <span onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <Popover
        side="right"
        align="start"
        width={280}
        content={(close) => (
          <AttentionTable
            rows={rows}
            onPick={(id) => {
              onFocus(id);
              close();
            }}
          />
        )}
      >
        <span
          className={clsx(
            'shrink-0 inline-flex items-center justify-center min-w-[14px] h-4 px-1 rounded-sm cursor-pointer',
            'hover:ring-1 transition',
            tone.ring,
          )}
        >
          <span
            className={clsx(
              'font-mono text-[9.5px] tabular-nums leading-none',
              tone.text,
            )}
          >
            {total}
          </span>
        </span>
      </Popover>
    </span>
  );
}

function AttentionTable({
  rows,
  onPick,
}: {
  rows: Array<{ msg: AgentMessage; kind: AttentionKind }>;
  onPick: (msgId: string) => void;
}) {
  return (
    <div className="py-1">
      <div className="px-2 pt-1 pb-1.5 flex items-center gap-2">
        <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-500">
          needs attention
        </span>
        <span className="ml-auto font-mono text-[9.5px] tabular-nums text-fog-600">
          {rows.length}
        </span>
      </div>
      <ul className="hairline-t">
        {rows.map(({ msg, kind }) => {
          const tone = kindTone[kind];
          return (
            <li key={msg.id}>
              <button
                onClick={() => onPick(msg.id)}
                className="w-full grid grid-cols-[36px_1fr_auto] items-center gap-2 px-2 h-6 hover:bg-ink-800 transition text-left border-b border-ink-800 last:border-b-0"
              >
                <span
                  className={clsx(
                    'font-mono text-[9px] uppercase tracking-widest2',
                    tone.text,
                  )}
                >
                  {tone.label}
                </span>
                <span className="text-[11px] text-fog-200 truncate leading-none">
                  {msg.title}
                </span>
                <span className="font-mono text-[9.5px] tabular-nums text-fog-600">
                  {msg.timestamp}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
