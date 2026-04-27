'use client';

// HARDENING_PLAN.md#C14 — agent-roster decomposition.
//
// Per-agent row in the roster table, plus its two private helpers
// (ActiveTodoChip + AttentionBadge). Lifted from agent-roster.tsx so
// the main file is the table shell + AttentionTable, not 200 LOC of
// per-row presentation.

import clsx from 'clsx';
import type { Agent, AgentMessage, TodoItem } from '@/lib/swarm-types';
import { ProviderBadge } from '../provider-badge';
import { Tooltip } from '../ui/tooltip';
import { Popover } from '../ui/popover';
import { ToolList } from '../part-chip';
import { compact } from '@/lib/format';
import {
  computeAttention,
  statusCircle,
  type Attention,
} from '@/lib/agent-status';
import {
  accentStripe,
  kindTone,
  statusMeta,
  type AttentionKind,
} from './_shared';

export function AgentRow({
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

        <span className="text-[13px] text-fog-100 truncate min-w-0 cursor-default">
          {agent.name}
        </span>

        {/* Status text chip — 2026-04-24, complements the colored dot
            with a readable label. The dot already conveys severity via
            color (mint=idle, molten=working, amber=waiting, rust=error,
            etc.); the chip lets a glancer answer "what is this agent
            DOING right now?" without parsing color → state. Sits in
            the same flex row so the layout collapses gracefully on
            narrow widths via truncate on the name. */}
        <span
          className={clsx(
            'shrink-0 inline-flex items-center h-4 px-1.5 rounded-sm',
            'font-mono text-[9.5px] uppercase tracking-widest2 hairline',
            st.color,
            'bg-ink-900/70',
          )}
          title={`agent status: ${st.label}${agent.focus ? ` — ${agent.focus}` : ''}`}
        >
          {st.label}
        </span>

        <span className="flex-1 min-w-0" />

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
                  <div className="w-[220px] p-2.5 space-y-1">
                    <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
                      {agent.name} · {agent.status}
                    </div>
                    <div className="hairline-t pt-1.5 space-y-0.5 font-mono text-[10.5px] tabular-nums">
                      <div className="flex justify-between"><span className="text-fog-600 uppercase tracking-wider text-[10px]">tokens</span><span className="text-fog-100">{agent.tokensUsed.toLocaleString()}</span></div>
                      <div className="flex justify-between"><span className="text-fog-600 uppercase tracking-wider text-[10px]">cost</span><span className="text-fog-100">${agent.costUsed.toFixed(2)}</span></div>
                      <div className="flex justify-between"><span className="text-fog-600 uppercase tracking-wider text-[10px]">sent</span><span className="text-fog-100">{agent.messagesSent}</span></div>
                      <div className="flex justify-between"><span className="text-fog-600 uppercase tracking-wider text-[10px]">received</span><span className="text-fog-100">{agent.messagesRecv}</span></div>
                    </div>
                  </div>
                )}
              >
                <button
                  onClick={(e) => e.stopPropagation()}
                  className="tabular-nums cursor-pointer hover:text-fog-200 transition"
                  aria-label={`${agent.name} stats`}
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

// AttentionKind + kindTone come from ./_shared (cross-file dedup with
// AttentionTable in agent-roster.tsx).

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
