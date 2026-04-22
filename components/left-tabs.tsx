'use client';

import clsx from 'clsx';
import { useEffect, useState } from 'react';
import type { Agent, AgentMessage, TodoItem } from '@/lib/swarm-types';
import type { FileHeat } from '@/lib/opencode/transform';
import { PlanRail } from './plan-rail';
import { AgentRoster } from './agent-roster';
import { BoardRail } from './board-rail';
import { HeatRail } from './heat-rail';
import { Tooltip } from './ui/tooltip';
import { IconPlus } from './icons';

export type Tab = 'plan' | 'roster' | 'board' | 'heat';

export function LeftTabs({
  plan,
  agents,
  messages,
  heat,
  selectedAgentId,
  onSelectAgent,
  onInspectAgent,
  onFocus,
  onJump,
  onSpawn,
  tab: tabProp,
  onTabChange,
  focusTodoId,
  boardSwarmRunID,
}: {
  plan: TodoItem[];
  agents: Agent[];
  messages: AgentMessage[];
  // Per-file edit counts aggregated from patch parts — stigmergy v0.
  // Empty array hides the heat tab entirely.
  heat: FileHeat[];
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
  onInspectAgent: (id: string) => void;
  onFocus: (id: string) => void;
  onJump: (messageId: string) => void;
  onSpawn: () => void;
  // Controlled tab state is optional — the component falls back to its own
  // local state. Lifting is needed only for cross-component jumps (e.g. a
  // task card in the timeline that wants to reveal the plan tab).
  tab?: Tab;
  onTabChange?: (tab: Tab) => void;
  focusTodoId?: string | null;
  // When set, the third "board" tab is rendered and the inline BoardRail
  // polls /api/swarm/run/:id/board. Null/undefined hides the tab entirely.
  // Only blackboard runs should pass a value here.
  boardSwarmRunID?: string | null;
}) {
  const [localTab, setLocalTab] = useState<Tab>('plan');
  const tab = tabProp ?? localTab;
  const setTab = (t: Tab) => {
    if (onTabChange) onTabChange(t);
    else setLocalTab(t);
  };

  // If the active run stops being a blackboard (or we switch to a different
  // run that has no board), 'board' becomes an invalid selection. Fall back
  // to 'plan' so the header doesn't show a highlighted tab with no content.
  // Same shape for the 'heat' tab — it vanishes when no files have been
  // touched yet, so a mid-run tab switch back to 'heat' after a restart
  // shouldn't leave the header in an invalid state.
  useEffect(() => {
    if (!boardSwarmRunID && tab === 'board') setTab('plan');
    if (heat.length === 0 && tab === 'heat') setTab('plan');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardSwarmRunID, heat.length, tab]);

  const planCompleted = plan.filter((i) => i.status === 'completed').length;
  const agentsActive = agents.filter(
    (a) => a.status === 'working' || a.status === 'thinking'
  ).length;

  return (
    <section className="relative flex flex-col min-w-0 min-h-0 overflow-hidden bg-ink-850 hairline-r">
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
        {boardSwarmRunID && (
          <TabButton
            active={tab === 'board'}
            onClick={() => setTab('board')}
            label="board"
            count=""
          />
        )}
        {heat.length > 0 && (
          <TabButton
            active={tab === 'heat'}
            onClick={() => setTab('heat')}
            label="heat"
            count={String(heat.length)}
          />
        )}

        <div className="ml-auto flex items-center">
          {tab === 'plan' && (
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
          )}
          {tab === 'roster' && (
            <Tooltip content="spawn new agent" side="bottom" align="end">
              <button
                onClick={onSpawn}
                className="w-6 h-6 grid place-items-center rounded hairline bg-ink-800 hover:border-molten/40 hover:text-molten text-fog-500 transition"
              >
                <IconPlus size={11} />
              </button>
            </Tooltip>
          )}
          {tab === 'board' && (
            <Tooltip
              side="bottom"
              align="end"
              wide
              content={
                <div className="space-y-1">
                  <div className="font-mono text-[11px] text-fog-200">
                    blackboard state
                  </div>
                  <div className="font-mono text-[10.5px] text-fog-500">
                    items and claims are written by the coordinator loop (see{' '}
                    <span className="text-fog-300">SWARM_PATTERNS.md §1</span>).
                    polls every 2s. for the 5-column kanban, follow the
                    footer link.
                  </div>
                </div>
              }
            >
              <span className="font-mono text-micro uppercase tracking-widest2 text-fog-700 cursor-help pr-2">
                read-only
              </span>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {tab === 'plan' && (
          <PlanRail
            items={plan}
            agents={agents}
            onJump={onJump}
            focusTodoId={focusTodoId ?? null}
            embedded
          />
        )}
        {tab === 'roster' && (
          <AgentRoster
            agents={agents}
            messages={messages}
            todos={plan}
            selectedId={selectedAgentId}
            onSelect={onSelectAgent}
            onInspect={onInspectAgent}
            onFocus={onFocus}
            embedded
          />
        )}
        {tab === 'board' && boardSwarmRunID && (
          <BoardRail swarmRunID={boardSwarmRunID} embedded />
        )}
        {tab === 'heat' && <HeatRail heat={heat} agents={agents} embedded />}
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
      {count && (
        <span
          className={clsx(
            'tabular-nums normal-case',
            active ? 'text-fog-400' : 'text-fog-700'
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}
