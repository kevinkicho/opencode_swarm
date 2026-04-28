'use client';

//
// Per-agent inspector panel. Header (glyph + name + accent stripe),
// model swap row, focus blurb, budget burn-down, session info (v1.14
// children/todos/summarize), and recent activity stream.
//
// 2026-04-28 decomposition: ModelSwapRow + ModelPicker → agent-model-swap.tsx,
// SessionInfoPanel → agent-session-info.tsx, BudgetPanel →
// agent-budget-panel.tsx. This file now reads as the agent panel
// composition only — the helper subtrees live in their own modules.

import clsx from 'clsx';
import type { Agent, AgentMessage } from '@/lib/swarm-types';
import { partHex, toolMeta } from '@/lib/part-taxonomy';
import { ModelSwapRow } from './agent-model-swap';
import { SessionInfoPanel } from './agent-session-info';
import { BudgetPanel } from './agent-budget-panel';

export function AgentInspector({
  agent,
  messages,
  onFocus,
  workspace,
}: {
  agent: Agent;
  messages: AgentMessage[];
  onFocus: (id: string) => void;
  workspace: string;
}) {
  const agentMsgs = messages.filter(
    (m) => m.fromAgentId === agent.id || m.toAgentIds.includes(agent.id)
  );
  return (
    <div className="space-y-3 animate-fade-up">
      <div className="border border-ink-600 bg-ink-800 relative">
        <span
          className={clsx(
            'absolute left-0 right-0 top-0 h-[2px]',
            agent.accent === 'molten' && 'bg-molten',
            agent.accent === 'mint' && 'bg-mint',
            agent.accent === 'iris' && 'bg-iris',
            agent.accent === 'amber' && 'bg-amber',
            agent.accent === 'fog' && 'bg-fog-500'
          )}
        />
        <div className="px-3 pt-3 pb-3">
          <div className="flex items-center gap-2">
            <span
              className={clsx(
                'font-mono text-[11px] uppercase tracking-widest2 shrink-0',
                agent.accent === 'molten' && 'text-molten',
                agent.accent === 'mint' && 'text-mint',
                agent.accent === 'iris' && 'text-iris',
                agent.accent === 'amber' && 'text-amber',
                agent.accent === 'fog' && 'text-fog-400'
              )}
            >
              {agent.glyph}
            </span>
            <span className="text-[15px] text-fog-100">{agent.name}</span>
          </div>

          <div className="mt-3">
            <ModelSwapRow agent={agent} />
          </div>

          {agent.focus && (
            <div className="mt-3 text-[12px] text-fog-300 leading-relaxed">
              <span className="font-mono text-micro uppercase tracking-wider text-fog-700 mr-1.5">
                focus
              </span>
              {agent.focus}
            </div>
          )}
        </div>
      </div>

      <BudgetPanel agent={agent} />

      <SessionInfoPanel agent={agent} workspace={workspace} />

      <div className="rounded-md hairline bg-ink-800 overflow-hidden">
        <div className="px-3 h-8 hairline-b flex items-center">
          <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
            recent activity
          </span>
          <span className="ml-auto font-mono text-micro text-fog-700">
            {agentMsgs.length}
          </span>
        </div>
        <ul className="max-h-64 overflow-y-auto">
          {agentMsgs.slice(-8).reverse().map((m) => {
            const label = m.toolName ?? m.part;
            const color = m.toolName
              ? toolMeta[m.toolName].hex
              : partHex[m.part];
            return (
              <li key={m.id}>
                <button
                  onClick={() => onFocus(m.id)}
                  className="w-full h-8 grid grid-cols-[8px_64px_1fr_40px] items-center gap-2 px-3 hover:bg-ink-750 transition text-left border-b border-ink-700 last:border-b-0"
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span
                    className="font-mono text-micro uppercase tracking-widest2 truncate"
                    style={{ color }}
                  >
                    {label}
                  </span>
                  <span className="text-[12px] text-fog-300 truncate">{m.title}</span>
                  <span className="font-mono text-[10.5px] text-fog-600 tabular-nums text-right">
                    {m.timestamp}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/*
        Per-agent "control" panel was removed in April 2026 — the four buttons
        (pause, branch-here, nudge-retry, terminate) were unwired. Per
        DESIGN.md §9, reintroduce wired. Real paths:
          pause / terminate → session.abort (soft cancel; current turn only)
          branch-here       → session.revert + session.create children
          nudge-retry       → session.prompt("retry the last action")
        "pause" vs "terminate" may fold into one button once we ship — they
        both map to the same opencode call today.
      */}
    </div>
  );
}
