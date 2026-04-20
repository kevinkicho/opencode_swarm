'use client';

import clsx from 'clsx';
import { useState } from 'react';
import type { Agent, AgentMessage, TodoItem } from '@/lib/swarm-types';
import { PlanRail } from './plan-rail';
import { AgentRoster } from './agent-roster';
import { Tooltip } from './ui/tooltip';
import { IconPlus } from './icons';

type Tab = 'plan' | 'roster';

export function LeftTabs({
  plan,
  agents,
  messages,
  selectedAgentId,
  onSelectAgent,
  onInspectAgent,
  onFocus,
  onJump,
  onSpawn,
}: {
  plan: TodoItem[];
  agents: Agent[];
  messages: AgentMessage[];
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
  onInspectAgent: (id: string) => void;
  onFocus: (id: string) => void;
  onJump: (messageId: string) => void;
  onSpawn: () => void;
}) {
  const [tab, setTab] = useState<Tab>('plan');

  const planCompleted = plan.filter((i) => i.status === 'completed').length;
  const agentsActive = agents.filter(
    (a) => a.status === 'working' || a.status === 'thinking'
  ).length;

  return (
    <section className="relative flex flex-col min-w-0 min-h-0 bg-ink-850 hairline-r">
      <div className="h-10 hairline-b px-2 flex items-center gap-0.5 bg-ink-850/80 backdrop-blur">
        <TabButton
          active={tab === 'plan'}
          onClick={() => setTab('plan')}
          label="plan"
          count={`${planCompleted}/${plan.length}`}
        />
        <TabButton
          active={tab === 'roster'}
          onClick={() => setTab('roster')}
          label="roster"
          count={`${agentsActive}/${agents.length}`}
        />

        <div className="ml-auto flex items-center">
          {tab === 'plan' ? (
            <Tooltip
              side="bottom"
              align="end"
              wide
              content={
                <div className="space-y-1">
                  <div className="font-mono text-[11px] text-fog-200">
                    agent-owned state
                  </div>
                  <div className="font-mono text-[10.5px] text-fog-500">
                    written by whichever agent is holding the plan via{' '}
                    <span className="text-fog-300">todowrite</span>. humans re-plan
                    via the command palette, not by editing rows.
                  </div>
                </div>
              }
            >
              <span className="font-mono text-micro uppercase tracking-widest2 text-fog-700 cursor-help pr-2">
                read-only
              </span>
            </Tooltip>
          ) : (
            <Tooltip content="spawn new agent" side="bottom" align="end">
              <button
                onClick={onSpawn}
                className="w-6 h-6 grid place-items-center rounded hairline bg-ink-800 hover:border-molten/40 hover:text-molten text-fog-500 transition"
              >
                <IconPlus size={11} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {tab === 'plan' ? (
          <PlanRail items={plan} agents={agents} onJump={onJump} embedded />
        ) : (
          <AgentRoster
            agents={agents}
            messages={messages}
            selectedId={selectedAgentId}
            onSelect={onSelectAgent}
            onInspect={onInspectAgent}
            onFocus={onFocus}
            embedded
          />
        )}
      </div>
    </section>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: string;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'h-6 px-2 rounded flex items-center gap-1.5 transition font-mono text-micro uppercase tracking-widest2',
        active
          ? 'bg-ink-800 text-fog-100'
          : 'text-fog-600 hover:text-fog-200 hover:bg-ink-800/50'
      )}
    >
      <span>{label}</span>
      <span
        className={clsx(
          'tabular-nums normal-case',
          active ? 'text-fog-400' : 'text-fog-700'
        )}
      >
        {count}
      </span>
    </button>
  );
}
