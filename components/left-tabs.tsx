'use client';

import clsx from 'clsx';
import { useEffect, useState } from 'react';
import type { Agent, AgentMessage, SwarmPattern, TodoItem } from '@/lib/swarm-types';
import type { FileHeat } from '@/lib/opencode/transform';
import type { LiveBoard, LiveTicker } from '@/lib/blackboard/live';
import type { LiveSwarmSessionSlot } from '@/lib/opencode/live';
import type { DeliberationProgress } from '@/lib/deliberate-progress';
import { PlanRail } from './plan-rail';
import { AgentRoster } from './agent-roster';
import { BoardRail } from './board-rail';
// Pattern-specific rails (contracts/iterations/debate/roles/map/
// council/phases/strategy) moved 2026-04-24 to the main viewport in
// app/page.tsx. The left panel now holds only the cross-pattern
// surfaces (plan / roster / board / heat).
import { HeatRail, type DiffStatsByPath } from './heat-rail';
import { Tooltip } from './ui/tooltip';
import { IconPlus } from './icons';

// 2026-04-24: pattern-specific tabs moved out of the left panel into
// the main viewport. Left panel keeps only the cross-pattern
// surfaces (plan / roster / board / heat).
export type Tab = 'plan' | 'roster' | 'board' | 'heat';

export function LeftTabs({
  plan,
  agents,
  messages,
  heat,
  diffStatsByPath,
  workspace,
  selectedAgentId,
  onSelectAgent,
  onInspectAgent,
  onFocus,
  onJump,
  onSelectFileHeat,
  onSpawn,
  tab: tabProp,
  onTabChange,
  focusTodoId,
  boardSwarmRunID,
  live,
  ticker,
  boardRoleNames,
  boardPattern,
  deliberationProgress,
  liveSlots,
  runSessionIDs,
}: {
  plan: TodoItem[];
  agents: Agent[];
  messages: AgentMessage[];
  // Per-file edit counts aggregated from patch parts — stigmergy v0.
  // Empty array hides the heat tab entirely.
  heat: FileHeat[];
  // Per-file add/delete line counts from the session's diff. Shared
  // with the cards view — populated from liveDiffs at the page level.
  diffStatsByPath: DiffStatsByPath;
  // Run's workspace root. HeatRail strips this prefix from displayed
  // paths so rows don't all lead with the same repo-root string.
  workspace: string;
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
  onInspectAgent: (id: string) => void;
  onFocus: (id: string) => void;
  onJump: (messageId: string) => void;
  // Heat row clicked — opens the file inspector. Forwarded through to
  // HeatRail embedded body.
  onSelectFileHeat: (heat: FileHeat) => void;
  onSpawn: () => void;
  // Board SSE state hoisted to the page so the main-view "board" toggle
  // can share the same subscription. Null/inactive when the run isn't
  // blackboard.
  live: LiveBoard;
  ticker: LiveTicker;
  // Controlled tab state is optional — the component falls back to its own
  // local state. Lifting is needed only for cross-component jumps (e.g. a
  // task card in the timeline that wants to reveal the plan tab).
  tab?: Tab;
  onTabChange?: (tab: Tab) => void;
  focusTodoId?: string | null;
  // When set, the third "board" tab is rendered and the inline BoardRail
  // polls /api/swarm/run/:id/board. Null/undefined hides the tab entirely.
  // Set for any pattern that populates the board (blackboard plus the
  // hierarchical patterns with board-execution phases).
  boardSwarmRunID?: string | null;
  // Per-session message slots from useLiveSwarmRunMessages. Required by
  // the iterations / debate / map pattern-specific tabs which build their
  // views from per-session message arrays. Empty array → no slot data;
  // those tabs render their empty state.
  liveSlots?: LiveSwarmSessionSlot[];
  // Run's session IDs in declared slot order. Required by the roles +
  // map tabs to derive `s0` / `s1` / … session labels.
  runSessionIDs?: string[];
  // Pattern-aware ownerAgentId → role name map for BoardRail chip labels
  // on hierarchical patterns. Empty map → numeric fallback in chips.
  boardRoleNames?: ReadonlyMap<string, string>;
  // Pattern of the current run, forwarded to BoardRail so the empty-
  // state message can reflect the correct phase (deliberation vs.
  // planner-sweep-pending).
  boardPattern?: SwarmPattern;
  // Deliberation round inference for deliberate-execute runs. Shown as
  // "round N of M" in the empty-state when present. Null otherwise.
  deliberationProgress?: DeliberationProgress | null;
}) {
  const [localTab, setLocalTab] = useState<Tab>('plan');
  const tab = tabProp ?? localTab;
  const setTab = (t: Tab) => {
    if (onTabChange) onTabChange(t);
    else setLocalTab(t);
  };

  // If the active run stops being a blackboard (or we switch to a
  // different run that has no board), 'board' becomes an invalid
  // selection. Fall back to 'plan' so the header doesn't show a
  // highlighted tab with no content. Same shape for the 'heat' tab —
  // it vanishes when no files have been touched yet, so a mid-run tab
  // switch back to 'heat' after a restart shouldn't leave the header
  // in an invalid state.
  useEffect(() => {
    if (!boardSwarmRunID && tab === 'board') setTab('plan');
    if (heat.length === 0 && tab === 'heat') setTab('plan');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardSwarmRunID, heat.length, tab]);

  const planCompleted = plan.filter((i) => i.status === 'completed').length;
  const agentsActive = agents.filter(
    (a) => a.status === 'working' || a.status === 'thinking'
  ).length;

  // Board SSE hooks now live at PageBody so the main-view "board"
  // toggle can share the same subscription. Props above.

  return (
    // overflow-hidden moved OFF this section: it was clipping the inset
    // seam shadow. Inner scroll containers (plan-rail / heat-rail /
    // board-rail ul + board-rail section) carry their own overflow
    // rules, so clipping at this level isn't needed anyway.
    <section className="relative flex flex-col min-w-0 min-h-0 bg-ink-850 sidebar-seam">
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
        {/* Pattern-specific tabs (contracts/iterations/debate/roles/
            map/council/phases/strategy) moved 2026-04-24 to the main
            viewport's runView toggle. They were the primary surface
            for understanding a run on its pattern; the left panel
            should hold only cross-pattern surfaces. */}
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
          <BoardRail
            swarmRunID={boardSwarmRunID}
            live={live}
            ticker={ticker}
            embedded
            roleNames={boardRoleNames}
            pattern={boardPattern}
            deliberationProgress={deliberationProgress}
            heat={heat}
          />
        )}
        {tab === 'heat' && (
          <HeatRail
            heat={heat}
            agents={agents}
            workspace={workspace}
            diffStatsByPath={diffStatsByPath}
            onSelect={onSelectFileHeat}
            embedded
            swarmRunID={boardSwarmRunID ?? undefined}
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
  tooltip,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: string;
  tooltip?: React.ReactNode;
}) {
  // Label-only button; count rendered as a corner badge overlapping
  // the top-right edge. Wrapper carries `relative` so the badge can
  // position against it, and stays inline-flex so siblings align on
  // the tab row.
  const btn = (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={onClick}
        className={clsx(
          'w-[68px] h-6 rounded flex items-center justify-center transition font-mono text-micro uppercase tracking-widest2 cursor-pointer',
          active
            ? 'bg-ink-800 text-fog-100'
            : 'text-fog-600 hover:text-fog-200 hover:bg-ink-800/50',
        )}
      >
        <span>{label}</span>
      </button>
      {count && (
        <span
          className={clsx(
            // Overlap the button's top-right edge. Small rounded pill
            // with mono tabular-nums so digits align across tabs.
            'absolute -top-1 -right-1 px-1 h-3.5 min-w-[14px] rounded-full border bg-ink-900',
            'flex items-center justify-center font-mono text-[9px] tabular-nums leading-none normal-case pointer-events-none select-none',
            active
              ? 'border-molten/40 text-molten'
              : 'border-fog-700 text-fog-400',
          )}
        >
          {count}
        </span>
      )}
    </span>
  );
  if (!tooltip) return btn;
  return (
    <Tooltip side="bottom" wide content={tooltip}>
      {btn}
    </Tooltip>
  );
}
