'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { SwarmTopbar } from '@/components/swarm-topbar';
import { LeftTabs } from '@/components/left-tabs';
import { SwarmTimeline } from '@/components/swarm-timeline';
import { Inspector } from '@/components/inspector';
import { CommandPalette } from '@/components/command-palette';
import { RoutingModal } from '@/components/routing-modal';
import { CommitHistory } from '@/components/commit-history';
import { LiveCommitHistory } from '@/components/live-commit-history';
import { SpawnAgentModal } from '@/components/spawn-agent-modal';
import { GlossaryModal } from '@/components/glossary-modal';
import { NewRunModal } from '@/components/new-run-modal';
import { SwarmComposer, type ComposerTarget } from '@/components/swarm-composer';
import { PermissionStrip } from '@/components/permission-strip';
import { Drawer } from '@/components/ui/drawer';
import { Tooltip } from '@/components/ui/tooltip';
import { IconBranch } from '@/components/icons';
import { PlaybackProvider, tsToSec } from '@/lib/playback-context';
import { ProviderStatsProvider } from '@/lib/provider-context';
import { RoutingBoundsProvider, useRoutingBounds } from '@/lib/routing-bounds-context';
import {
  useOpencodeHealth,
  useLiveSession,
  useLivePermissions,
  useSessionDiff,
  postSessionMessageBrowser,
} from '@/lib/opencode/live';
import {
  toAgents,
  toMessages,
  toRunMeta,
  toRunPlan,
  toProviderSummary,
  toLiveTurns,
  parseSessionDiffs,
  type LiveTurn,
} from '@/lib/opencode/transform';
import type { DiffData } from '@/lib/types';
import {
  agents as mockAgents,
  agentOrder as mockAgentOrder,
  messages as mockMessages,
  runMeta as mockRunMeta,
  runPlan as mockRunPlan,
  providerSummary as mockProviderSummary,
} from '@/lib/swarm-data';
import type { AgentMessage, Agent, RunMeta, ProviderSummary, TodoItem } from '@/lib/swarm-types';
import type { TimelineNode } from '@/lib/types';

interface SwarmView {
  agents: Agent[];
  agentOrder: string[];
  messages: AgentMessage[];
  runMeta: RunMeta;
  providerSummary: ProviderSummary[];
  runPlan: TodoItem[];
  liveTurns: LiveTurn[];
  isLive: boolean;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PageInner />
    </Suspense>
  );
}

function PageInner() {
  const params = useSearchParams();
  const sessionId = params.get('session');
  const { data: liveData } = useLiveSession(sessionId);
  const liveDirectory = liveData?.session?.directory ?? null;
  const permissions = useLivePermissions(sessionId, liveDirectory);

  const view: SwarmView = useMemo(() => {
    if (sessionId && liveData) {
      const { agents, agentOrder } = toAgents(liveData.messages);
      const messages = toMessages(liveData.messages);
      return {
        agents,
        agentOrder,
        messages,
        runMeta: toRunMeta(liveData.session, liveData.messages),
        providerSummary: toProviderSummary(agents, liveData.messages),
        runPlan: toRunPlan(liveData.messages),
        liveTurns: toLiveTurns(liveData.messages),
        isLive: true,
      };
    }
    return {
      agents: mockAgents,
      agentOrder: mockAgentOrder,
      messages: mockMessages,
      runMeta: mockRunMeta,
      providerSummary: mockProviderSummary,
      runPlan: mockRunPlan,
      liveTurns: [],
      isLive: false,
    };
  }, [sessionId, liveData]);

  const { agents, agentOrder, messages, runMeta, providerSummary, runPlan, liveTurns, isLive } = view;

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

  return (
    <RoutingBoundsProvider>
      <PageBody
        agents={agents}
        agentOrder={agentOrder}
        messages={messages}
        runMeta={runMeta}
        providerSummary={providerSummary}
        runPlan={runPlan}
        paletteNodes={paletteNodes}
        runDuration={runDuration}
        liveSessionId={sessionId}
        liveDirectory={liveDirectory}
        permissions={permissions}
        liveTurns={liveTurns}
        liveLastUpdated={liveData?.lastUpdated ?? null}
        isLive={isLive}
      />
    </RoutingBoundsProvider>
  );
}

function PageBody({
  agents,
  agentOrder,
  messages,
  runMeta,
  providerSummary,
  runPlan,
  paletteNodes,
  runDuration,
  liveSessionId,
  liveDirectory,
  permissions,
  liveTurns,
  liveLastUpdated,
  isLive,
}: {
  agents: Agent[];
  agentOrder: string[];
  messages: AgentMessage[];
  runMeta: RunMeta;
  providerSummary: ProviderSummary[];
  runPlan: TodoItem[];
  paletteNodes: TimelineNode[];
  runDuration: number;
  liveSessionId: string | null;
  liveDirectory: string | null;
  permissions: ReturnType<typeof useLivePermissions>;
  liveTurns: LiveTurn[];
  liveLastUpdated: number | null;
  isLive: boolean;
}) {
  const [focusedMsgId, setFocusedMsgId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [newRunOpen, setNewRunOpen] = useState(false);

  // Routing bounds live in a provider so the modal can persist them to
  // localStorage. Cost cap is the only bound with a direct RunMeta field
  // today; the rest live on the bounds record for dispatcher reads.
  const { bounds } = useRoutingBounds();
  const runWithBounds = useMemo<RunMeta>(
    () => ({ ...runMeta, budgetCap: bounds.costCap }),
    [runMeta, bounds.costCap]
  );

  // Only fetch the diff when the live drawer is actually open; refetch when
  // a new turn lands. Returns null in non-live mode so the mock drawer keeps
  // using its baked-in commit data.
  const {
    diffs: rawDiffs,
    loading: diffLoading,
    error: diffError,
  } = useSessionDiff(isLive ? liveSessionId : null, historyOpen, liveLastUpdated);
  const liveDiffs: DiffData[] | null = useMemo(
    () => (rawDiffs ? parseSessionDiffs(rawDiffs) : null),
    [rawDiffs]
  );

  const focusMessage = useCallback((id: string) => {
    setFocusedMsgId((prev) => {
      if (prev === id) {
        setDrawerOpen(false);
        return null;
      }
      setSelectedAgentId(null);
      setDrawerOpen(true);
      return id;
    });
  }, []);

  const clearFocus = useCallback(() => {
    setFocusedMsgId(null);
    setSelectedAgentId(null);
    setDrawerOpen(false);
  }, []);

  const selectAgent = useCallback((id: string) => {
    setSelectedAgentId(id);
    setFocusedMsgId(null);
    setDrawerOpen(true);
  }, []);

  const rosterSelect = useCallback((id: string) => {
    setSelectedAgentId(id);
    setFocusedMsgId(null);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setFocusedMsgId(null);
    setSelectedAgentId(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);


  const drawerTitle = focusedMsgId
    ? messages.find((m) => m.id === focusedMsgId)?.title
    : selectedAgentId
      ? agents.find((a) => a.id === selectedAgentId)?.name
      : undefined;

  const drawerEyebrow = focusedMsgId
    ? 'message inspector'
    : selectedAgentId
      ? 'agent inspector'
      : undefined;

  return (
    <PlaybackProvider runDuration={runDuration}>
    <ProviderStatsProvider
      value={{
        agents,
        providers: providerSummary,
        run: runWithBounds,
        onOpenRouting: () => setRoutingOpen(true),
      }}
    >
    <div className="relative h-screen w-screen flex flex-col bg-ink-900 overflow-hidden bg-noise">
      <SwarmTopbar
        run={runWithBounds}
        providers={providerSummary}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => setRoutingOpen(true)}
        liveSessionId={liveSessionId}
        liveDirectory={liveDirectory}
      />

      <main className="flex-1 grid min-h-0" style={{ gridTemplateColumns: '260px 1fr' }}>
        <LeftTabs
          plan={runPlan}
          agents={agents}
          messages={messages}
          selectedAgentId={selectedAgentId}
          onSelectAgent={rosterSelect}
          onInspectAgent={selectAgent}
          onFocus={focusMessage}
          onJump={focusMessage}
          onSpawn={() => setSpawnOpen(true)}
        />

        <SwarmTimeline
          agents={agents}
          messages={messages}
          agentOrder={agentOrder}
          focusedId={focusedMsgId}
          onFocus={focusMessage}
          onClearFocus={clearFocus}
          selectedAgentId={selectedAgentId}
          onSelectAgent={selectAgent}
        />
      </main>

      <PermissionStrip
        pending={permissions.pending}
        onApprove={permissions.approve}
        onReject={permissions.reject}
        error={permissions.error}
      />

      <SwarmComposer
        agents={agents}
        onSend={(target: ComposerTarget, body: string) => {
          if (liveSessionId && liveDirectory) {
            // Agent target → opencode `agent` field (agent-config name, not UI id).
            // Broadcast → omit `agent`; opencode routes to the session's lead.
            const agentName =
              target.kind === 'agent'
                ? agents.find((a) => a.id === target.id)?.name
                : undefined;
            postSessionMessageBrowser(liveSessionId, liveDirectory, body, {
              agent: agentName,
            }).catch((err) => console.error('[composer] opencode post failed', err));
            return;
          }
          console.info('[composer]', target, body);
        }}
      />

      <StatusRail
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenRouting={() => setRoutingOpen(true)}
        onOpenHistory={() => setHistoryOpen(true)}
        onOpenGlossary={() => setGlossaryOpen(true)}
        onOpenNewRun={() => setNewRunOpen(true)}
      />

      <Drawer
        open={drawerOpen && (!!focusedMsgId || !!selectedAgentId)}
        onClose={closeDrawer}
        eyebrow={drawerEyebrow}
        title={drawerTitle}
        width={380}
      >
        <Inspector
          agents={agents}
          messages={messages}
          focusedMessageId={focusedMsgId}
          selectedAgentId={selectedAgentId}
          onFocus={focusMessage}
          embedded
        />
      </Drawer>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        nodes={paletteNodes}
        onJump={focusMessage}
      />

      <RoutingModal open={routingOpen} onClose={() => setRoutingOpen(false)} />

      {isLive ? (
        <LiveCommitHistory
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          turns={liveTurns}
          diffs={liveDiffs}
          loading={diffLoading}
          error={diffError}
        />
      ) : (
        <CommitHistory open={historyOpen} onClose={() => setHistoryOpen(false)} />
      )}

      <SpawnAgentModal
        open={spawnOpen}
        onClose={() => setSpawnOpen(false)}
        directory={liveDirectory}
      />

      <GlossaryModal open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />

      <NewRunModal open={newRunOpen} onClose={() => setNewRunOpen(false)} />
    </div>
    </ProviderStatsProvider>
    </PlaybackProvider>
  );
}

function StatusRail({
  onOpenPalette,
  onOpenRouting,
  onOpenHistory,
  onOpenGlossary,
  onOpenNewRun,
}: {
  onOpenPalette: () => void;
  onOpenRouting: () => void;
  onOpenHistory: () => void;
  onOpenGlossary: () => void;
  onOpenNewRun: () => void;
}) {
  const health = useOpencodeHealth(5000);
  const dotClass =
    health.status === 'live'
      ? 'bg-mint'
      : health.status === 'offline'
        ? 'bg-rust'
        : 'bg-fog-700 animate-pulse';
  const label =
    health.status === 'live'
      ? 'swarm live'
      : health.status === 'offline'
        ? 'swarm offline'
        : 'connecting…';
  const healthTooltip =
    health.status === 'live'
      ? `opencode reachable · ${health.projectCount} project${health.projectCount === 1 ? '' : 's'}`
      : health.status === 'offline'
        ? health.error
          ? `opencode unreachable: ${health.error}`
          : 'opencode unreachable'
        : 'probing opencode…';

  return (
    <footer className="h-7 shrink-0 hairline-t bg-ink-900 flex items-center px-4 text-[11px] font-mono text-fog-600">
      <div className="flex items-center gap-3">
        <Tooltip content={healthTooltip} side="top">
          <span className="flex items-center gap-1.5 cursor-default">
            <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
            <span className="text-fog-400">{label}</span>
          </span>
        </Tooltip>
        <span className="w-px h-3 bg-ink-700" />
        <Tooltip
          side="top"
          wide
          content={
            <div className="space-y-0.5">
              <div className="font-mono text-[11px] text-fog-200">initiate a new run</div>
              <div className="font-mono text-[10.5px] text-fog-600">
                source + optional directive + optional team
              </div>
            </div>
          }
        >
          <button
            onClick={onOpenNewRun}
            className="flex items-center gap-1.5 h-5 px-1.5 rounded bg-molten/10 hover:bg-molten/20 text-molten border border-molten/25 transition"
          >
            <span className="w-1 h-1 rounded-full bg-molten" />
            <span className="font-mono text-[10px] uppercase tracking-widest2">new run</span>
          </button>
        </Tooltip>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Tooltip
          side="top"
          content={
            <span className="font-mono text-[11px] text-fog-200">
              open palette{' '}
              <span className="text-fog-500">⌘K / Ctrl+K</span>
            </span>
          }
        >
          <button
            onClick={onOpenPalette}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
          >
            <span className="text-fog-700">palette</span>
          </button>
        </Tooltip>

        <Tooltip content="routing rules" side="top">
          <button
            onClick={onOpenRouting}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
          >
            <span className="text-fog-700">routing</span>
          </button>
        </Tooltip>

        <Tooltip
          side="top"
          wide
          content={
            <div className="space-y-0.5">
              <div className="font-mono text-[11px] text-fog-200">opencode vocabulary</div>
              <div className="font-mono text-[10.5px] text-fog-600">
                canonical part, tool, and event names
              </div>
            </div>
          }
        >
          <button
            onClick={onOpenGlossary}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
          >
            <span className="text-fog-700">glossary</span>
          </button>
        </Tooltip>

        <Tooltip content="branch history" side="top">
          <button
            onClick={onOpenHistory}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
          >
            <IconBranch size={10} className="text-fog-500" />
            <span className="text-fog-700">history</span>
          </button>
        </Tooltip>
      </div>
    </footer>
  );
}
