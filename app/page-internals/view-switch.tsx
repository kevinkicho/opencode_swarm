'use client';

import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { ProfileBoundary } from '@/components/perf/profile-boundary';
import { SwarmTimeline } from '@/components/swarm-timeline';
import { EmptyViewState } from '@/components/empty-view-state';
import { Tooltip } from '@/components/ui/tooltip';
import { lazyWithRetry } from '@/lib/lazy-with-retry';
import { RUN_VIEW_KEYS, VIEW_META, type RunView } from '@/lib/view-availability';
import type { Agent, AgentMessage, TodoItem } from '@/lib/swarm-types';
import type { FileHeat, LiveTurn, TurnCard } from '@/lib/opencode/transform';
import type { SwarmRunMeta } from '@/lib/swarm-run-types';
import type { LiveBoard, LiveTicker } from '@/lib/blackboard/live';
import type { LiveSwarmSessionSlot } from '@/lib/opencode/live';
import type { DiffStatsByPath } from '@/components/heat-rail';

const VIEW_PATTERN_GATES = VIEW_META;

const TurnCardsView = dynamic(
  lazyWithRetry(() =>
    import('@/components/turn-cards-view').then((m) => m.TurnCardsView),
  ),
  { ssr: false },
);
const ChatView = dynamic(
  lazyWithRetry(() =>
    import('@/components/chat-view').then((m) => m.ChatView),
  ),
  { ssr: false },
);
const BoardFullView = dynamic(
  lazyWithRetry(() =>
    import('@/components/board-full-view').then((m) => m.BoardFullView),
  ),
  { ssr: false },
);
const ContractsRail = dynamic(
  lazyWithRetry(() =>
    import('@/components/contracts-rail').then((m) => m.ContractsRail),
  ),
  { ssr: false },
);
const IterationsRail = dynamic(
  lazyWithRetry(() =>
    import('@/components/iterations-rail').then((m) => m.IterationsRail),
  ),
  { ssr: false },
);
const DebateRail = dynamic(
  lazyWithRetry(() =>
    import('@/components/debate-rail').then((m) => m.DebateRail),
  ),
  { ssr: false },
);
const MapRail = dynamic(
  lazyWithRetry(() => import('@/components/map-rail').then((m) => m.MapRail)),
  { ssr: false },
);
const CouncilRail = dynamic(
  lazyWithRetry(() =>
    import('@/components/council-rail').then((m) => m.CouncilRail),
  ),
  { ssr: false },
);
const StrategyRail = dynamic(
  lazyWithRetry(() =>
    import('@/components/strategy-rail').then((m) => m.StrategyRail),
  ),
  { ssr: false },
);

type ViewSwitchProps = {
  runView: RunView;
  setRunView: (v: RunView) => void;
  agents: Agent[];
  messages: AgentMessage[];
  agentOrder: string[];
  focusedMsgId: string | null;
  onFocus: (id: string) => void;
  onClearFocus: () => void;
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
  runPlan: TodoItem[];
  onJumpToTodo: (id: string) => void;
  boardRoleNames: ReadonlyMap<string, string>;
  liveBoard: LiveBoard;
  liveTicker: LiveTicker;
  swarmRunMeta: SwarmRunMeta | null;
  boardSwarmRunID: string | null;
  turnCards: TurnCard[];
  liveSlots: LiveSwarmSessionSlot[];
  diffStatsByPath: DiffStatsByPath;
  liveDirectory: string | null;
  messagesLoading: boolean;
  selectSession: (sid: string) => void;
};

export function ViewToolbar({
  runView,
  setRunView,
  boardSwarmRunID,
  swarmRunMeta,
  messages,
  messagesLoading,
  turnCards,
  liveBoard,
  liveSlots,
}: {
  runView: RunView;
  setRunView: (v: RunView) => void;
  boardSwarmRunID: string | null;
  swarmRunMeta: SwarmRunMeta | null;
  messages: AgentMessage[];
  messagesLoading: boolean;
  turnCards: TurnCard[];
  liveBoard: LiveBoard;
  liveSlots: LiveSwarmSessionSlot[];
}) {
  return (
    <div className="h-7 hairline-b px-3 flex items-center gap-2 bg-ink-850/80 backdrop-blur shrink-0">
      <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">view</span>
      {(() => {
        const gateCtx = {
          pattern: swarmRunMeta?.pattern,
          boardSwarmRunID,
        };
        const universal = ['chat', 'timeline', 'cards'] as RunView[];
        const renderTab = (k: RunView) => {
          const enabled = VIEW_PATTERN_GATES[k].enabled(gateCtx);
          return (
            <Tooltip
              key={k}
              content={
                enabled
                  ? VIEW_PATTERN_GATES[k].hint
                  : `${VIEW_PATTERN_GATES[k].hint} · click to see when this view applies`
              }
              side="bottom"
            >
              <button
                type="button"
                onClick={() => setRunView(k)}
                className={clsx(
                  'h-5 px-2 rounded-sm transition-colors cursor-pointer',
                  runView === k
                    ? 'bg-molten/15 text-molten'
                    : 'text-fog-500 hover:text-fog-300 hover:bg-ink-800/60',
                  !enabled && runView !== k && 'opacity-50',
                )}
              >
                {k}
              </button>
            </Tooltip>
          );
        };
        return (
          <div className="flex items-center gap-0.5 font-mono text-micro uppercase tracking-widest2">
            {universal.map(renderTab)}
            <span
              className="mx-2 text-fog-700 select-none"
              aria-hidden
            >
              ·
            </span>
            {RUN_VIEW_KEYS.filter((k) => !universal.includes(k)).map(renderTab)}
          </div>
        );
      })()}
      <div className="flex-1" />
      <span className={clsx('font-mono text-micro tabular-nums', messagesLoading ? 'text-fog-600 animate-pulse' : 'text-fog-700')}>
        {messagesLoading && messages.length === 0
          ? 'loading…'
          : runView === 'timeline'
            ? `${messages.length} events`
            : runView === 'chat'
              ? `${messages.length} messages`
              : runView === 'cards'
                ? `${turnCards.length} turns`
                : runView === 'board' || runView === 'contracts'
                  ? `${liveBoard.items?.length ?? 0} items`
                  : `${liveSlots.length} sessions`}
      </span>
    </div>
  );
}

export function MainViewSwitch({
  runView,
  agents,
  messages,
  agentOrder,
  focusedMsgId,
  onFocus,
  onClearFocus,
  selectedAgentId,
  onSelectAgent,
  runPlan,
  onJumpToTodo,
  boardRoleNames,
  liveBoard,
  liveTicker,
  swarmRunMeta,
  boardSwarmRunID,
  turnCards,
  liveSlots,
  diffStatsByPath,
  liveDirectory,
  messagesLoading,
  selectSession,
}: ViewSwitchProps) {
  const viewEnabled = VIEW_PATTERN_GATES[runView].enabled({
    pattern: swarmRunMeta?.pattern,
    boardSwarmRunID,
  });
  if (!viewEnabled) {
    return (
      <EmptyViewState
        view={runView}
        currentPattern={swarmRunMeta?.pattern}
      />
    );
  }
  switch (runView) {
    case 'timeline':
      return (
        <ProfileBoundary id="swarm-timeline">
          <SwarmTimeline
            agents={agents}
            messages={messages}
            agentOrder={agentOrder}
            focusedId={focusedMsgId}
            onFocus={onFocus}
            onClearFocus={onClearFocus}
            selectedAgentId={selectedAgentId}
            onSelectAgent={onSelectAgent}
            todos={runPlan}
            onJumpToTodo={onJumpToTodo}
            roleNames={boardRoleNames}
          />
        </ProfileBoundary>
      );
    case 'board':
      return (
        <ProfileBoundary id="board-full">
          <BoardFullView
            live={liveBoard}
            ticker={liveTicker}
            roleNames={boardRoleNames}
            pattern={swarmRunMeta?.pattern}
          />
        </ProfileBoundary>
      );
    case 'cards':
      return (
        <ProfileBoundary id="turn-cards">
          <TurnCardsView
            cards={turnCards}
            agents={agents}
            agentOrder={agentOrder}
            workspace={swarmRunMeta?.workspace ?? liveDirectory ?? ''}
            diffStatsByPath={diffStatsByPath}
            focusedId={focusedMsgId}
            onFocus={onFocus}
            loading={messagesLoading}
          />
        </ProfileBoundary>
      );
    case 'chat':
      return (
        <ProfileBoundary id="chat-view">
          <ChatView
            messages={messages}
            agents={agents}
            focusedId={focusedMsgId}
            onFocus={onFocus}
            loading={messagesLoading}
          />
        </ProfileBoundary>
      );
    case 'contracts':
      return (
        <ProfileBoundary id="contracts-rail">
          <ContractsRail live={liveBoard} embedded loading={messagesLoading} />
        </ProfileBoundary>
      );
    case 'iterations':
      return (
        <ProfileBoundary id="iterations-rail">
          <IterationsRail slots={liveSlots} embedded onInspectSession={selectSession} />
        </ProfileBoundary>
      );
    case 'debate':
      return (
        <ProfileBoundary id="debate-rail">
          <DebateRail slots={liveSlots} embedded onInspectSession={selectSession} />
        </ProfileBoundary>
      );
    case 'map':
      return (
        <ProfileBoundary id="map-rail">
          <MapRail
            slots={liveSlots}
            live={liveBoard}
            sessionIDs={swarmRunMeta?.sessionIDs ?? []}
            embedded
            onInspectSession={selectSession}
          />
        </ProfileBoundary>
      );
    case 'council':
      return (
        <ProfileBoundary id="council-rail">
          <CouncilRail slots={liveSlots} embedded onInspectSession={selectSession} />
        </ProfileBoundary>
      );
    case 'strategy':
      return boardSwarmRunID ? (
        <ProfileBoundary id="strategy-rail">
          <StrategyRail swarmRunID={boardSwarmRunID} embedded />
        </ProfileBoundary>
      ) : null;
    default:
      return null;
  }
}