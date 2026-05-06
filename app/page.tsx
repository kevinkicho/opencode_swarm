'use client';

import { Suspense, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { ProfileBoundary } from '@/components/perf/profile-boundary';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import { SwarmTopbar } from '@/components/swarm-topbar';
import { LeftTabs } from '@/components/left-tabs';
import { CostCapBanner } from '@/components/cost-cap-banner';
import { Drawer } from '@/components/ui/drawer';
import { PlaybackProvider, tsToSec } from '@/lib/playback-context';
import { ProviderStatsProvider } from '@/lib/provider-context';
import { RoutingBoundsProvider, useRoutingBounds } from '@/lib/routing-bounds-context';
import { lazyWithRetry } from '@/lib/lazy-with-retry';
import { useSessionDiff } from '@/lib/opencode/live';
import { tokensForBudget } from '@/lib/opencode/pricing';
import { useDiffStats } from './page-internals/use-diff-stats';
import { PageModals } from './page-internals/page-modals';
import { useModalState } from './page-internals/use-modal-state';
import { useSelectionState } from './page-internals/use-selection-state';
import { useCostCapBlock } from './page-internals/use-cost-cap-block';
import { useGlobalKeybindings } from './page-internals/use-global-keybindings';
import { useViewState } from './page-internals/use-view-state';
import { usePageData } from './page-internals/use-page-data';
import { ViewToolbar, MainViewSwitch } from './page-internals/view-switch';
import { RunStrips } from './page-internals/run-strips';
import { PageFooter } from './page-internals/page-footer';
import type { PaletteAction } from '@/components/command-palette';
import type { AgentMessage, Agent, RunMeta, ProviderSummary, TodoItem } from '@/lib/swarm-types';
import type { SwarmRunMeta, SwarmRunStatus } from '@/lib/swarm-run-types';
import type { TimelineNode } from '@/lib/types';
import type { LiveTurn, TurnCard, FileHeat } from '@/lib/opencode/transform';
import type { LiveBoard, LiveTicker } from '@/lib/blackboard/live';
import type { RunView } from '@/lib/view-availability';
import type { SilentSession } from '@/lib/silent-session';

const Inspector = dynamic(
  lazyWithRetry(() =>
    import('@/components/inspector').then((m) => m.Inspector),
  ),
  { ssr: false },
);
const RunNotFoundScreen = dynamic(
  lazyWithRetry(() =>
    import('@/components/run-not-found-screen').then((m) => m.RunNotFoundScreen),
  ),
  { ssr: false },
);

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ProfileBoundary id="page-inner">
        <PageInner />
      </ProfileBoundary>
    </Suspense>
  );
}

function ageHint(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function PageInner() {
  const data = usePageData();
  const {
    swarmRunID,
    swarmRunMeta,
    swarmRunMissing,
    swarmRunStatus,
    runsSnapshot,
    sessionId,
    liveData,
    liveSwarmRun,
    messagesLoading,
    liveDirectory,
    permissions,
    view,
    agents,
    boardSwarmRunID,
    liveBoard,
    liveTicker,
    boardRoleNames,
    silentSessions,
  } = data;

  const { agentOrder, messages, runMeta, providerSummary, runPlan, liveTurns, turnCards, fileHeat } = view;

  const paletteNodes: TimelineNode[] = useMemo(
    () =>
      messages.map((m) => ({
        id: m.id,
        kind:
          m.fromAgentId === 'human'
            ? 'user'
            : m.part === 'tool'
              ? 'tool'
              : m.part === 'reasoning'
                ? 'thinking'
                : m.part === 'subtask' || m.part === 'agent'
                  ? 'agent'
                  : m.part === 'step-start' || m.part === 'step-finish'
                    ? 'milestone'
                    : 'assistant',
        toolKind: m.toolName,
        title: m.title,
        subtitle: m.toolSubtitle ?? m.body,
        preview: m.toolPreview ?? m.body,
        timestamp: m.timestamp,
        duration: m.duration,
        status: m.status === 'pending' ? 'pending' : m.status,
        tokens: m.tokens,
      })),
    [messages]
  );

  const runDuration = useMemo(
    () => Math.max(...messages.map((m) => tsToSec(m.timestamp)), 60),
    [messages]
  );

  if (swarmRunMissing) {
    return <RunNotFoundScreen swarmRunID={swarmRunID!} />;
  }

  return (
    <RoutingBoundsProvider>
      <PageBody
        agents={agents}
        agentOrder={agentOrder}
        messages={messages}
        messagesLoading={messagesLoading}
        runMeta={runMeta}
        providerSummary={providerSummary}
        runPlan={runPlan}
        paletteNodes={paletteNodes}
        runDuration={runDuration}
        liveSessionId={sessionId}
        liveDirectory={liveDirectory}
        permissions={permissions}
        liveTurns={liveTurns}
        turnCards={turnCards}
        fileHeat={fileHeat}
        liveLastUpdated={liveSwarmRun.lastUpdated ?? liveData?.lastUpdated ?? null}
        liveSlots={liveSwarmRun.slots}
        swarmRunID={swarmRunID}
        swarmRunMeta={swarmRunMeta}
        swarmRunStatus={swarmRunStatus}
        swarmRuns={runsSnapshot.rows}
        boardSwarmRunID={boardSwarmRunID}
        liveBoard={liveBoard}
        liveTicker={liveTicker}
        boardRoleNames={boardRoleNames}
        silentSessions={silentSessions}
        runsSnapshot={runsSnapshot}
      />
    </RoutingBoundsProvider>
  );
}

function PageBody({
  agents: agentsIn,
  agentOrder,
  messages,
  messagesLoading,
  runMeta,
  providerSummary,
  runPlan,
  paletteNodes,
  runDuration,
  liveSessionId,
  liveDirectory,
  permissions,
  liveTurns,
  turnCards,
  fileHeat,
  liveLastUpdated,
  liveSlots,
  swarmRunID,
  swarmRunMeta,
  swarmRunStatus,
  swarmRuns,
  boardSwarmRunID,
  liveBoard,
  liveTicker,
  boardRoleNames,
  silentSessions,
  runsSnapshot,
}: {
  agents: Agent[];
  agentOrder: string[];
  messages: AgentMessage[];
  messagesLoading: boolean;
  runMeta: RunMeta;
  providerSummary: ProviderSummary[];
  runPlan: TodoItem[];
  paletteNodes: TimelineNode[];
  runDuration: number;
  liveSessionId: string | null;
  liveDirectory: string | null;
  permissions: ReturnType<typeof import('@/lib/opencode/live').useLivePermissions>;
  liveTurns: LiveTurn[];
  turnCards: TurnCard[];
  fileHeat: FileHeat[];
  liveLastUpdated: number | null;
  liveSlots: import('@/lib/opencode/live').LiveSwarmSessionSlot[];
  swarmRunID: string | null;
  swarmRunMeta: SwarmRunMeta | null;
  swarmRunStatus: SwarmRunStatus | null;
  swarmRuns: import('@/lib/swarm-run-types').SwarmRunListRow[];
  boardSwarmRunID: string | null;
  liveBoard: LiveBoard;
  liveTicker: LiveTicker;
  boardRoleNames: ReadonlyMap<string, string>;
  silentSessions: SilentSession[];
  runsSnapshot: { rows: import('@/lib/swarm-run-types').SwarmRunListRow[] };
}) {
  const router = useRouter();
  const modals = useModalState();
  const { costCapBlock, safePost, dismissCap } = useCostCapBlock(swarmRunID);

  const viewState = useViewState<RunView>(
    'chat',
    () => true,
    [],
  );
  const { leftTab, setLeftTab, runView, setRunView, focusTodoId, jumpToTodo } = viewState;

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const out: PaletteAction[] = [];
    if (swarmRunID && swarmRunStatus && swarmRunStatus !== 'live' && swarmRunStatus !== 'unknown') {
      out.push({
        id: 'retro:current',
        group: 'open',
        label: 'retro · current run',
        hint: swarmRunID,
        tone: 'molten',
        onSelect: () => router.push(`/retro/${swarmRunID}`),
      });
    }
    const recent = [...swarmRuns]
      .filter(
        (r) =>
          r.meta.swarmRunID !== swarmRunID &&
          r.status !== 'live' &&
          r.status !== 'unknown'
      )
      .sort(
        (a, b) =>
          (b.lastActivityTs ?? b.meta.createdAt) -
          (a.lastActivityTs ?? a.meta.createdAt)
      )
      .slice(0, 8);
    for (const r of recent) {
      const directive = r.meta.directive?.split('\n', 1)[0]?.trim() ?? '';
      const teaser =
        directive.length > 64
          ? directive.slice(0, 64).replace(/\s+$/, '') + '…'
          : directive || '(no directive)';
      const age = ageHint(r.lastActivityTs ?? r.meta.createdAt);
      out.push({
        id: `retro:${r.meta.swarmRunID}`,
        group: 'recent retros',
        label: `retro · ${teaser}`,
        hint: `${r.meta.pattern} · ${age}`,
        tone: 'iris',
        onSelect: () => router.push(`/retro/${r.meta.swarmRunID}`),
      });
    }
    return out;
  }, [router, swarmRunID, swarmRunStatus, swarmRuns]);

  const { bounds } = useRoutingBounds();
  const runWithBounds = useMemo<RunMeta>(
    () => ({ ...runMeta, budgetCap: bounds.costCap }),
    [runMeta, bounds.costCap]
  );

  const agents = useMemo(() => {
    return agentsIn.map((a) => {
      const budget = tokensForBudget(bounds.costCap, a.model.id);
      return budget ? { ...a, tokensBudget: budget } : a;
    });
  }, [agentsIn, bounds.costCap]);

  const {
    diffs: rawDiffs,
    loading: diffLoading,
    error: diffError,
  } = useSessionDiff(liveSessionId, !!liveSessionId, liveLastUpdated);
  const { liveDiffs, diffStatsByPath } = useDiffStats({
    rawDiffs,
    workspace: swarmRunMeta?.workspace,
    liveDirectory,
  });

  const {
    focusedMsgId,
    selectedAgentId,
    selectedFileHeat,
    drawerOpen,
    focusMessage,
    selectAgent,
    selectSession,
    rosterSelect,
    selectFileHeat,
    clearFocus,
    closeDrawer,
  } = useSelectionState(agents);

  useGlobalKeybindings(modals);

  const drawerTitle = focusedMsgId
    ? messages.find((m) => m.id === focusedMsgId)?.title
    : selectedAgentId
      ? agents.find((a) => a.id === selectedAgentId)?.name
      : selectedFileHeat
        ? selectedFileHeat.path.split(/[\\/]/).pop() || selectedFileHeat.path
        : undefined;

  const drawerEyebrow = focusedMsgId
    ? 'message inspector'
    : selectedAgentId
      ? 'agent inspector'
      : selectedFileHeat
        ? 'file heat'
        : undefined;

  return (
    <PlaybackProvider runDuration={runDuration}>
    <ProviderStatsProvider
      value={{
        agents,
        providers: providerSummary,
        run: runWithBounds,
        onOpenRouting: modals.openers.routing,
      }}
    >
    <div className="relative h-screen w-screen flex flex-col bg-ink-900 overflow-hidden bg-noise">
      <ProfileBoundary id="topbar">
      <SwarmTopbar
        run={runWithBounds}
        providers={providerSummary}
        onOpenPalette={modals.openers.palette}
        onOpenSettings={modals.openers.routing}
        liveSessionId={liveSessionId}
        liveDirectory={liveDirectory}
        swarmRunMeta={swarmRunMeta}
        swarmRunStatus={swarmRunStatus}
        tickerState={liveTicker.state}
        boardItems={liveBoard.items ?? null}
        silentSessions={silentSessions}
      />
      </ProfileBoundary>

      <main
        className="flex-1 grid min-h-0"
        style={{ gridTemplateColumns: '320px 1fr' }}
      >
        <ProfileBoundary id="left-tabs">
        <LeftTabs
          plan={runPlan}
          agents={agents}
          messages={messages}
          heat={fileHeat}
          diffStatsByPath={diffStatsByPath}
          workspace={swarmRunMeta?.workspace ?? liveDirectory ?? ''}
          selectedAgentId={selectedAgentId}
          onSelectAgent={rosterSelect}
          onInspectAgent={selectAgent}
          onFocus={focusMessage}
          onJump={focusMessage}
          onSelectFileHeat={selectFileHeat}
          onSpawn={modals.openers.spawn}
          tab={leftTab}
          onTabChange={setLeftTab}
          focusTodoId={focusTodoId}
          boardSwarmRunID={boardSwarmRunID}
          live={liveBoard}
          ticker={liveTicker}
          boardRoleNames={boardRoleNames}
          boardPattern={swarmRunMeta?.pattern}
          pattern={swarmRunMeta?.pattern}
          liveSlots={liveSlots}
          runSessionIDs={swarmRunMeta?.sessionIDs ?? []}
          allRuns={runsSnapshot.rows}
          swarmRunMeta={swarmRunMeta}
        />
        </ProfileBoundary>

        <section className="relative flex-1 flex flex-col min-w-0 min-h-0 pl-3">
          <ViewToolbar
            runView={runView}
            setRunView={setRunView}
            boardSwarmRunID={boardSwarmRunID}
            swarmRunMeta={swarmRunMeta}
            messages={messages}
            messagesLoading={messagesLoading}
            turnCards={turnCards}
            liveBoard={liveBoard}
            liveSlots={liveSlots}
          />
          <MainViewSwitch
            runView={runView}
            setRunView={setRunView}
            agents={agents}
            messages={messages}
            agentOrder={agentOrder}
            focusedMsgId={focusedMsgId}
            onFocus={focusMessage}
            onClearFocus={clearFocus}
            selectedAgentId={selectedAgentId}
            onSelectAgent={selectAgent}
            runPlan={runPlan}
            onJumpToTodo={jumpToTodo}
            boardRoleNames={boardRoleNames}
            liveBoard={liveBoard}
            liveTicker={liveTicker}
            swarmRunMeta={swarmRunMeta}
            boardSwarmRunID={boardSwarmRunID}
            turnCards={turnCards}
            liveSlots={liveSlots}
            diffStatsByPath={diffStatsByPath}
            liveDirectory={liveDirectory}
            messagesLoading={messagesLoading}
            selectSession={selectSession}
          />
        </section>
      </main>

      <RunStrips
        agents={agents}
        messages={messages}
        swarmRunMeta={swarmRunMeta}
        focusedMsgId={focusedMsgId}
        onFocus={focusMessage}
        permissions={permissions}
        safePost={safePost}
      />

      {costCapBlock && (
        <CostCapBanner
          block={costCapBlock}
          onOpenRouting={() => {
            dismissCap();
            modals.openers.routing();
          }}
          onDismiss={dismissCap}
        />
      )}

      <PageFooter
        agents={agents}
        liveSessionId={liveSessionId}
        liveDirectory={liveDirectory}
        swarmRunMeta={swarmRunMeta}
        swarmRunID={swarmRunID}
        safePost={safePost}
        modals={modals}
      />

      <Drawer
        open={drawerOpen && (!!focusedMsgId || !!selectedAgentId || !!selectedFileHeat)}
        onClose={closeDrawer}
        eyebrow={drawerEyebrow}
        title={drawerTitle}
        width={380}
        dismissOnClickOutside
      >
        <ErrorBoundary scope="inspector">
          <Inspector
            agents={agents}
            messages={messages}
            focusedMessageId={focusedMsgId}
            selectedAgentId={selectedAgentId}
            selectedFileHeat={selectedFileHeat}
            workspace={swarmRunMeta?.workspace ?? liveDirectory ?? ''}
            onFocus={focusMessage}
            embedded
          />
        </ErrorBoundary>
      </Drawer>

      <PageModals
        state={modals}
        paletteNodes={paletteNodes}
        paletteActions={paletteActions}
        onJumpToMessage={focusMessage}
        liveTurns={liveTurns}
        liveDiffs={liveDiffs}
        diffLoading={diffLoading}
        diffError={diffError}
        liveDirectory={liveDirectory}
        runWorkspace={swarmRunMeta?.workspace ?? null}
        swarmRunID={swarmRunID}
      />
    </div>
    </ProviderStatsProvider>
    </PlaybackProvider>
  );
}