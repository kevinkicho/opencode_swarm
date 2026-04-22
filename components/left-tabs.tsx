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
    <section className="relative flex flex-col min-w-0 min-h-0 overflow-hidden bg-ink-850 sidebar-seam">
      <div className="h-10 hairline-b px-2 flex items-center gap-0.5 bg-ink-850/80 backdrop-blur">
        <TabButton
          active={tab === 'plan'}
          onClick={() => setTab('plan')}
          label="plan"
          count={`${planCompleted}/${plan.length}`}
          tooltip={
            <div className="space-y-0.5 max-w-[260px]">
              <div className="font-mono text-[11px] text-fog-200">plan</div>
              <div className="font-mono text-[10.5px] text-fog-500">
                agent-owned todos written via <span className="text-fog-300">todowrite</span>. click a row to
                expand details + jump to its delegation.
              </div>
            </div>
          }
        />
        <TabButton
          active={tab === 'roster'}
          onClick={() => setTab('roster')}
          label="roster"
          count={`${agentsActive}/${agents.length}`}
          tooltip={
            <div className="space-y-0.5 max-w-[260px]">
              <div className="font-mono text-[11px] text-fog-200">roster</div>
              <div className="font-mono text-[10.5px] text-fog-500">
                every live agent in the run — identity, model, status, tokens + cost. click a row to open the inspector.
              </div>
            </div>
          }
        />
        {boardSwarmRunID && (
          <TabButton
            active={tab === 'board'}
            onClick={() => setTab('board')}
            label="board"
            count=""
            tooltip={
              <div className="space-y-0.5 max-w-[260px]">
                <div className="font-mono text-[11px] text-fog-200">blackboard</div>
                <div className="font-mono text-[10.5px] text-fog-500">
                  shared board — items claimed via CAS, status transitions live-streamed (SWARM_PATTERNS.md §1).
                </div>
              </div>
            }
          />
        )}
        {heat.length > 0 && (
          <TabButton
            active={tab === 'heat'}
            onClick={() => setTab('heat')}
            label="heat"
            count={String(heat.length)}
            tooltip={
              <div className="space-y-0.5 max-w-[260px]">
                <div className="font-mono text-[11px] text-fog-200">heat</div>
                <div className="font-mono text-[10.5px] text-fog-500">
                  file-edit convergence — which files the swarm has touched, hot-first. observation only, never
                  assignment (stigmergy v0).
                </div>
              </div>
            }
          />
        )}

        {/* Right-side chrome. The "read-only" labels that used to live
            here (for plan / board / heat tabs) were redundant once the
            tab-buttons themselves got descriptive tooltips — agent-owned
            / coordinator-written / observation-only are all spelled out
            on hover. Only the "spawn agent" action remains, and only
            when the roster tab is active. */}
        <div className="ml-auto flex items-center">
          {tab === 'roster' && (
            <Tooltip content="spawn new agent" side="bottom" align="end">
              <button
                type="button"
                onClick={onSpawn}
                className="w-6 h-6 grid place-items-center rounded hairline bg-ink-800 hover:border-molten/40 hover:text-molten text-fog-500 transition cursor-pointer"
              >
                <IconPlus size={11} />
              </button>
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
  tooltip,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: string;
  tooltip?: React.ReactNode;
}) {
  const btn = (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        // Fixed width per tab so the four labels (plan/roster/board/heat)
        // align as a grid regardless of count length. Counts are hidden
        // visually on overflow — tooltip carries the full picture.
        'w-[68px] h-6 rounded flex items-center justify-center gap-1 transition font-mono text-micro uppercase tracking-widest2 cursor-pointer shrink-0',
        active
          ? 'bg-ink-800 text-fog-100'
          : 'text-fog-600 hover:text-fog-200 hover:bg-ink-800/50'
      )}
    >
      <span>{label}</span>
      {count && (
        <span
          className={clsx(
            'tabular-nums normal-case text-[9px]',
            active ? 'text-fog-400' : 'text-fog-700'
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
  if (!tooltip) return btn;
  return (
    <Tooltip side="bottom" wide content={tooltip}>
      {btn}
    </Tooltip>
  );
}
