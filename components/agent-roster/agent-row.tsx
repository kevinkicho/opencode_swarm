'use client';

//
// Per-agent row in the roster table, plus its two private helpers
// (ActiveTodoChip + AttentionBadge). Lifted from agent-roster.tsx so
// the main file is the table shell + AttentionTable, not 200 LOC of
// per-row presentation.

import clsx from 'clsx';
import type { Agent, TodoItem } from '@/lib/swarm-types';
import { ProviderBadge } from '../provider-badge';
import { Tooltip } from '../ui/tooltip';
import { Popover } from '../ui/popover';
import { ToolList } from '../part-chip';
import { compact } from '@/lib/format';
import { statusCircle, type Attention } from '@/lib/agent-status';
import { accentStripe, statusMeta } from './_shared';
import { ActiveTodoChip } from './active-todo-chip';
import { AttentionBadge } from './attention-badge';

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
        className="w-full text-left pl-3 pr-3 py-2 flex flex-col gap-1.5 hover:bg-ink-800/60 transition relative"
      >
        <span
          className={clsx(
            'absolute left-0 top-0 bottom-0 w-[2px]',
            accentStripe[agent.accent],
            !selected && !circle.animation && 'opacity-50'
          )}
        />

        {/* Line 1: identity row — dot + name + status + (todo chip) + (attention) */}
        <div className="flex items-center gap-2.5 w-full">
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
              DOING right now?" without parsing color → state. */}
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
        </div>

        {/* Line 2: throughput strip — tokens compact + sent/recv + cost,
            and a thin budget bar below. Surfaces "is this agent doing
            work" at a glance without expanding the row. The earlier
            collapsed state showed only IDLE/WORKING which was the same
            information as the colored dot — this fills the unused
            horizontal space with metrics that actually matter. */}
        <div className="flex items-center gap-2 w-full pl-3 pr-1">
          <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-700 tabular-nums">
            {compact(agent.tokensUsed)}
            <span className="text-fog-700/70 mx-1">tok</span>
          </span>
          <span className="font-mono text-[9.5px] text-fog-600 tabular-nums">
            ${agent.costUsed.toFixed(2)}
          </span>
          <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 tabular-nums">
            ↑{agent.messagesSent} ↓{agent.messagesRecv}
          </span>
          {/* Budget bar pushed right; thin (1px) so it doesn't add
              visual weight, fills remaining space for max precision. */}
          <Tooltip
            content={`${compact(agent.tokensUsed)} of ${compact(agent.tokensBudget)} budget · ${tokenPct}%`}
            side="top"
          >
            <span className="flex-1 min-w-[24px] h-[2px] rounded-full bg-ink-900 overflow-hidden cursor-help">
              <span
                className={clsx(
                  'block h-full rounded-full',
                  tokenPct > 80 ? 'bg-rust' : tokenPct > 60 ? 'bg-amber' : 'bg-fog-500/70',
                )}
                style={{ width: `${tokenPct}%` }}
              />
            </span>
          </Tooltip>
        </div>
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

