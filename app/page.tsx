'use client';

import clsx from 'clsx';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { SwarmTopbar } from '@/components/swarm-topbar';
import { LeftTabs } from '@/components/left-tabs';
import { SwarmTimeline } from '@/components/swarm-timeline';
import { TurnCardsView } from '@/components/turn-cards-view';
import { BoardFullView } from '@/components/board-full-view';
import { Inspector } from '@/components/inspector';
import { useLiveBoard, useLiveTicker } from '@/lib/blackboard/live';
// Modals and drawers below are gated by `open={...}` state that defaults to
// closed — they cost 0 visual rent until the user opens them. Lazy-loading
// via next/dynamic keeps them out of the initial JS bundle, which matters
// because page.tsx is the largest client chunk in the app (~6 MB in dev).
// ssr:false is safe: each component is already client-only code rendered
// inside a client page, and nothing on the closed state needs pre-render.
const CommandPalette = dynamic(
  () => import('@/components/command-palette').then((m) => m.CommandPalette),
  { ssr: false },
);
const RoutingModal = dynamic(
  () => import('@/components/routing-modal').then((m) => m.RoutingModal),
  { ssr: false },
);
const LiveCommitHistory = dynamic(
  () =>
    import('@/components/live-commit-history').then((m) => m.LiveCommitHistory),
  { ssr: false },
);
const SpawnAgentModal = dynamic(
  () =>
    import('@/components/spawn-agent-modal').then((m) => m.SpawnAgentModal),
  { ssr: false },
);
const GlossaryModal = dynamic(
  () => import('@/components/glossary-modal').then((m) => m.GlossaryModal),
  { ssr: false },
);
const NewRunModal = dynamic(
  () => import('@/components/new-run-modal').then((m) => m.NewRunModal),
  { ssr: false },
);
const RunProvenanceDrawer = dynamic(
  () =>
    import('@/components/run-provenance-drawer').then(
      (m) => m.RunProvenanceDrawer,
    ),
  { ssr: false },
);
const CostDashboard = dynamic(
  () => import('@/components/cost-dashboard').then((m) => m.CostDashboard),
  { ssr: false },
);
import type { PaletteAction } from '@/components/command-palette';
import { SwarmRunsPicker } from '@/components/swarm-runs-picker';
import { SwarmComposer, type ComposerTarget } from '@/components/swarm-composer';
import { CostCapBanner, type CostCapBlock } from '@/components/cost-cap-banner';
import { PermissionStrip } from '@/components/permission-strip';
import { ReconcileStrip } from '@/components/reconcile-strip';
import { SynthesisStrip } from '@/components/synthesis-strip';
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
  useLiveSwarmRun,
  useLiveSwarmRunMessages,
  useSessionDiff,
  useSwarmRuns,
  postSessionMessageBrowser,
  CostCapError,
} from '@/lib/opencode/live';
import {
  toAgents,
  toMessages,
  toRunMeta,
  toRunPlan,
  toProviderSummary,
  toLiveTurns,
  toTurnCards,
  toFileHeat,
  parseSessionDiffs,
  type LiveTurn,
  type TurnCard,
  type FileHeat,
} from '@/lib/opencode/transform';
import { tokensForBudget } from '@/lib/opencode/pricing';
import type { DiffData } from '@/lib/types';
import type { AgentMessage, Agent, RunMeta, ProviderSummary, TodoItem } from '@/lib/swarm-types';
import type { SwarmRunMeta, SwarmRunStatus } from '@/lib/swarm-run-types';
import type { TimelineNode } from '@/lib/types';

interface SwarmView {
  agents: Agent[];
  agentOrder: string[];
  messages: AgentMessage[];
  runMeta: RunMeta;
  providerSummary: ProviderSummary[];
  runPlan: TodoItem[];
  liveTurns: LiveTurn[];
  turnCards: TurnCard[];
  fileHeat: FileHeat[];
}

// Zero-state view for "no run active" — topbar chips render as 0/placeholder,
// all live-data panels collapse to their empty states. Budget defaults match
// the routing-modal defaults so the topbar chip doesn't read 0/0.
const EMPTY_VIEW: SwarmView = {
  agents: [],
  agentOrder: [],
  messages: [],
  runMeta: {
    id: '',
    title: '',
    status: 'paused',
    started: '',
    elapsed: '—',
    totalTokens: 0,
    totalCost: 0,
    budgetCap: 5,
    goTier: { window: '5h', used: 0, cap: 12 },
    cwd: '',
  },
  providerSummary: [],
  runPlan: [],
  liveTurns: [],
  turnCards: [],
  fileHeat: [],
};

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PageInner />
    </Suspense>
  );
}

// Short relative-age formatter for palette hints — mirrors the runs
// picker's `fmtAge` so both surfaces read identically. Kept inline here
// rather than imported because the picker's helper isn't exported and it's
// three trivial lines.
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
  const params = useSearchParams();
  // Two entry points resolve to the same live session:
  //   ?session=<id>   — direct, used for deep-linking into an opencode session
  //                     that was created outside the swarm-run flow
  //   ?swarmRun=<id>  — swarm-run anchor; the hook looks up meta.json and
  //                     resolves to the primary sessionID (sessionIDs[0] at v1)
  // Pattern='none' makes these equivalent in runtime behavior; the swarmRun
  // URL is preferred because it carries run-level context (workspace, bounds,
  // source) that future patterns will consume here.
  const swarmRunID = params.get('swarmRun');
  const directSessionId = params.get('session');
  const swarmRun = useLiveSwarmRun(swarmRunID);
  // Ledger-wide poll. Feeds both the topbar status dot (this page) and the
  // runs picker (via its own internal call — see note below). We poll here
  // so the topbar has a live status even before the user opens the picker.
  // The picker's internal poll stays — cheap at prototype scale and keeps
  // the picker component self-contained.
  const runsSnapshot = useSwarmRuns(4000);
  const currentRunStatus: SwarmRunStatus | null = useMemo(() => {
    if (!swarmRunID) return null;
    const row = runsSnapshot.rows.find((r) => r.meta.swarmRunID === swarmRunID);
    return row?.status ?? null;
  }, [runsSnapshot.rows, swarmRunID]);
  // When the swarmRunID is terminal-dead (404) we still need to pass null
  // through the downstream session/permission hooks rather than branching
  // early — rules-of-hooks requires a stable call order across renders.
  // The dead-link screen is rendered conditionally in JSX below.
  const swarmRunMissing = Boolean(swarmRunID) && swarmRun.notFound;
  const sessionId = swarmRunMissing
    ? null
    : swarmRunID
      ? swarmRun.primarySessionID
      : directSessionId;
  const { data: liveData } = useLiveSession(sessionId);
  // Multi-session fan-out for council / future N-member patterns. The hook
  // collapses to a one-slot no-op when meta is null or carries a single
  // sessionID, so we can call it unconditionally and let the view decide
  // which channel to consume.
  const liveSwarmRun = useLiveSwarmRunMessages(swarmRun.meta);
  const isMultiSession = (swarmRun.meta?.sessionIDs.length ?? 0) > 1;
  const liveDirectory = liveData?.session?.directory ?? null;
  const permissions = useLivePermissions(sessionId, liveDirectory);

  const view: SwarmView = useMemo(() => {
    // Council / multi-session: merge every slot's messages into a single
    // chronological stream, then feed the transform pipeline. toAgents and
    // toMessages are session-aware (S4 rekey), so merging is safe — IDs
    // stay disambiguated by sessionID and user→assistant routing resolves
    // per-session rather than cross-session. The primary slot's session is
    // the anchor for runMeta; workspace / title are identical across
    // council members by construction.
    if (isMultiSession && liveSwarmRun.slots.length > 0) {
      const merged = liveSwarmRun.slots
        .flatMap((s) => s.messages)
        .slice()
        .sort((a, b) => a.info.time.created - b.info.time.created);
      const anchorSession = liveSwarmRun.slots[0]?.session ?? null;
      const { agents, agentOrder } = toAgents(merged);
      const baseMeta = toRunMeta(anchorSession, merged);
      // For multi-session runs the primary member's opencode title carries
      // the `#1` member suffix we added at spawn time (swarm/run/route.ts).
      // Users reading the topbar want the run-level title, not "foo #1" —
      // so overlay meta.title (the seed title) and swarmRunID so the anchor
      // reads as a run identity rather than a stray member.
      return {
        agents,
        agentOrder,
        messages: toMessages(merged),
        runMeta: {
          ...baseMeta,
          id: swarmRun.meta?.swarmRunID ?? baseMeta.id,
          title: swarmRun.meta?.title ?? baseMeta.title,
        },
        providerSummary: toProviderSummary(agents, merged),
        runPlan: toRunPlan(merged),
        liveTurns: toLiveTurns(merged),
        turnCards: toTurnCards(merged),
        fileHeat: toFileHeat(merged),
      };
    }
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
        turnCards: toTurnCards(liveData.messages),
        fileHeat: toFileHeat(liveData.messages),
      };
    }
    return EMPTY_VIEW;
  }, [isMultiSession, liveSwarmRun.slots, swarmRun.meta, sessionId, liveData]);

  // Layer `waiting` on top of toAgents' status: a pending permission on the
  // session means whichever agent is mid-turn is actually blocked on human
  // approval, not still working. toAgents can't see permissions — they come
  // from a separate hook — so we apply the override here.
  const agents = useMemo(() => {
    if (permissions.pending.length === 0) return view.agents;
    return view.agents.map((a) =>
      a.status === 'working' || a.status === 'thinking'
        ? { ...a, status: 'waiting' as const }
        : a
    );
  }, [view.agents, permissions.pending.length]);

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
        swarmRunID={swarmRunID}
        swarmRunMeta={swarmRun.meta}
        swarmRunStatus={currentRunStatus}
        swarmRuns={runsSnapshot.rows}
      />
    </RoutingBoundsProvider>
  );
}

function PageBody({
  agents: agentsIn,
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
  turnCards,
  fileHeat,
  liveLastUpdated,
  swarmRunID,
  swarmRunMeta,
  swarmRunStatus,
  swarmRuns,
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
  turnCards: TurnCard[];
  fileHeat: FileHeat[];
  liveLastUpdated: number | null;
  swarmRunID: string | null;
  swarmRunMeta: SwarmRunMeta | null;
  swarmRunStatus: SwarmRunStatus | null;
  swarmRuns: import('@/lib/swarm-run-types').SwarmRunListRow[];
}) {
  const router = useRouter();
  const [focusedMsgId, setFocusedMsgId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  // A row in the heat rail that was clicked to open the file inspector.
  // Orthogonal to focusedMsgId / selectedAgentId — they mutually exclude
  // each other so the drawer shows exactly one thing at a time.
  const [selectedFileHeat, setSelectedFileHeat] = useState<FileHeat | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [newRunOpen, setNewRunOpen] = useState(false);
  const [provenanceOpen, setProvenanceOpen] = useState(false);
  const [costOpen, setCostOpen] = useState(false);
  // Most recent cost-cap rejection from the proxy gate (DESIGN.md §9). Set
  // when postSessionMessageBrowser throws CostCapError; cleared on dismiss or
  // when the user switches to a different run.
  const [costCapBlock, setCostCapBlock] = useState<CostCapBlock | null>(null);
  // Left-panel tab is lifted so the timeline can reveal the plan when a task
  // card's todo-eyebrow is clicked. `focusTodoId` is a transient pointer —
  // PlanRail scrolls+flashes on change; we clear it after the row animates.
  const [leftTab, setLeftTab] = useState<'plan' | 'roster' | 'board' | 'heat'>('plan');

  // Board SSE subscription lives at the page level so both the left-rail
  // "board" tab and the main-view "board" toggle read from the same
  // EventSource. Null when the run isn't blackboard — hooks short-circuit
  // to empty state without opening a connection.
  const boardSwarmRunID =
    swarmRunMeta?.pattern === 'blackboard' ? swarmRunMeta.swarmRunID : null;
  const liveBoard = useLiveBoard(boardSwarmRunID);
  const liveTicker = useLiveTicker(boardSwarmRunID);
  const [focusTodoId, setFocusTodoId] = useState<string | null>(null);
  // Main-panel view toggle. Timeline = cross-lane event flow (default);
  // cards = per-turn conversation cards; board = full-width blackboard
  // kanban (only for blackboard runs — hidden otherwise). The cards
  // view is a complement to the timeline — it collapses tool calls into
  // chip rows but loses the wire/A2A topology the timeline exists to
  // show. See DESIGN.md §2.
  const [runView, setRunView] = useState<'timeline' | 'cards' | 'board'>('timeline');

  const jumpToTodo = useCallback((todoId: string) => {
    setLeftTab('plan');
    setFocusTodoId(todoId);
    // Clear after the flash so re-clicking the same todo re-triggers the
    // scroll + highlight. 1200ms covers smooth scroll + visual settle.
    window.setTimeout(() => setFocusTodoId(null), 1200);
  }, []);

  // Palette actions: runtime navigation shortcuts that don't fit the
  // jump-to-node model. Gated on swarmRunStatus so we don't offer retro for
  // a live run — the rollup hasn't landed yet (DESIGN.md §7.6 — rollups are
  // written at session close). The retro page handles "no rollup yet"
  // gracefully, but showing the action during a run reads as a bug.
  //
  // Recent-retro entries lean on the same runsSnapshot the topbar polls, so
  // this adds no extra request overhead. Cap at 8 — more than that, users
  // should pop the runs picker for scan-style discovery. Excludes the
  // current run since it already has its own entry above.
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

  // Routing bounds live in a provider so the modal can persist them to
  // localStorage. Cost cap is the only bound with a direct RunMeta field
  // today; the rest live on the bounds record for dispatcher reads.
  const { bounds } = useRoutingBounds();
  const runWithBounds = useMemo<RunMeta>(
    () => ({ ...runMeta, budgetCap: bounds.costCap }),
    [runMeta, bounds.costCap]
  );

  // Overlay pricing-derived tokensBudget on each agent. The per-agent budget
  // is the notional output-token count that the run's cost cap buys at the
  // agent's own model rate — so agents on expensive models show smaller
  // budgets than agents on cheap ones, matching economic reality. Falls back
  // to the toAgents default (80k) when pricing is unknown.
  const agents = useMemo(() => {
    return agentsIn.map((a) => {
      const budget = tokensForBudget(bounds.costCap, a.model.id);
      return budget ? { ...a, tokensBudget: budget } : a;
    });
  }, [agentsIn, bounds.costCap]);

  // Fetch the diff whenever a live session exists so per-file +/- stats
  // can render in the cards view's file list. The history drawer also
  // reads from the same `liveDiffs` signal so nothing downstream
  // breaks. Refetches on liveLastUpdated.
  const {
    diffs: rawDiffs,
    loading: diffLoading,
    error: diffError,
  } = useSessionDiff(liveSessionId, !!liveSessionId, liveLastUpdated);
  const liveDiffs: DiffData[] | null = useMemo(
    () => (rawDiffs ? parseSessionDiffs(rawDiffs) : null),
    [rawDiffs]
  );
  // Per-file add/delete stats for the cards view's file list and the
  // heat rail's +/- columns. Built from liveDiffs if present; empty
  // map otherwise.
  //
  // Key shape: we populate BOTH the relative path (as liveDiffs has
  // it) and the workspace-prefixed absolute path, because different
  // surfaces carry paths in different shapes — heat.path is absolute
  // (came from opencode patch.files) while filesTouched in cards
  // view is also absolute. Lookups by either form resolve.
  //
  // Multi-session caveat: only the primary session's diff is fetched
  // today, so stats for files edited exclusively by non-primary
  // sessions stay undefined (render as `—`). A future pass can
  // aggregate diffs across every sessionID in meta.sessionIDs.
  const diffStatsByPath = useMemo(() => {
    const m = new Map<string, { added: number; deleted: number }>();
    if (!liveDiffs) return m;
    const ws = (swarmRunMeta?.workspace ?? liveDirectory ?? '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
    for (const d of liveDiffs) {
      const stats = { added: d.additions ?? 0, deleted: d.deletions ?? 0 };
      const rel = d.file.replace(/\\/g, '/').replace(/^\/+/, '');
      m.set(rel, stats);
      if (ws) m.set(`${ws}/${rel}`, stats);
    }
    return m;
  }, [liveDiffs, swarmRunMeta?.workspace, liveDirectory]);

  const focusMessage = useCallback((id: string) => {
    setFocusedMsgId((prev) => {
      if (prev === id) {
        setDrawerOpen(false);
        return null;
      }
      setSelectedAgentId(null);
      setSelectedFileHeat(null);
      setDrawerOpen(true);
      return id;
    });
  }, []);

  const clearFocus = useCallback(() => {
    setFocusedMsgId(null);
    setSelectedAgentId(null);
    setSelectedFileHeat(null);
    setDrawerOpen(false);
  }, []);

  const selectAgent = useCallback((id: string) => {
    setSelectedAgentId(id);
    setFocusedMsgId(null);
    setSelectedFileHeat(null);
    setDrawerOpen(true);
  }, []);

  const rosterSelect = useCallback((id: string) => {
    setSelectedAgentId(id);
    setFocusedMsgId(null);
    setSelectedFileHeat(null);
  }, []);

  const selectFileHeat = useCallback((heat: FileHeat) => {
    // Toggle: clicking the same file again closes the drawer.
    setSelectedFileHeat((prev) => {
      if (prev?.path === heat.path) {
        setDrawerOpen(false);
        return null;
      }
      setFocusedMsgId(null);
      setSelectedAgentId(null);
      setDrawerOpen(true);
      return heat;
    });
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setFocusedMsgId(null);
    setSelectedAgentId(null);
    setSelectedFileHeat(null);
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

  // Drop any stale cost-cap banner when the active run changes — a block from
  // one run isn't meaningful for another. Also clears when the user exits a
  // swarm-scoped view entirely (swarmRunID → null).
  useEffect(() => {
    setCostCapBlock(null);
  }, [swarmRunID]);


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
        swarmRunMeta={swarmRunMeta}
        swarmRunStatus={swarmRunStatus}
      />

      <main
        className="flex-1 grid min-h-0"
        style={{ gridTemplateColumns: '320px 1fr' }}
      >
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
          onSpawn={() => setSpawnOpen(true)}
          tab={leftTab}
          onTabChange={setLeftTab}
          focusTodoId={focusTodoId}
          boardSwarmRunID={boardSwarmRunID}
          live={liveBoard}
          ticker={liveTicker}
        />

        <section className="flex-1 flex flex-col min-w-0 min-h-0 pl-3">
          <div className="h-7 hairline-b px-3 flex items-center gap-2 bg-ink-850/80 backdrop-blur shrink-0">
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">view</span>
            <div className="flex items-center gap-0.5 font-mono text-micro uppercase tracking-widest2">
              {(
                [
                  { key: 'timeline', enabled: true },
                  { key: 'cards', enabled: true },
                  // `board` only rendered for blackboard runs — LiveBoard
                  // would be empty otherwise.
                  { key: 'board', enabled: !!boardSwarmRunID },
                ] as const
              )
                .filter((v) => v.enabled)
                .map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => setRunView(v.key)}
                    className={clsx(
                      'h-5 px-2 rounded-sm transition-colors cursor-pointer',
                      runView === v.key
                        ? 'bg-molten/15 text-molten'
                        : 'text-fog-500 hover:text-fog-300 hover:bg-ink-800/60',
                    )}
                  >
                    {v.key}
                  </button>
                ))}
            </div>
            <div className="flex-1" />
            <span className="font-mono text-micro tabular-nums text-fog-700">
              {runView === 'timeline'
                ? `${messages.length} events`
                : runView === 'cards'
                  ? `${turnCards.length} turns`
                  : `${liveBoard.items?.length ?? 0} items`}
            </span>
          </div>
          {runView === 'timeline' ? (
            <SwarmTimeline
              agents={agents}
              messages={messages}
              agentOrder={agentOrder}
              focusedId={focusedMsgId}
              onFocus={focusMessage}
              onClearFocus={clearFocus}
              selectedAgentId={selectedAgentId}
              onSelectAgent={selectAgent}
              todos={runPlan}
              onJumpToTodo={jumpToTodo}
            />
          ) : runView === 'board' ? (
            <BoardFullView live={liveBoard} ticker={liveTicker} />
          ) : (
            <TurnCardsView
              cards={turnCards}
              agents={agents}
              agentOrder={agentOrder}
              workspace={swarmRunMeta?.workspace ?? liveDirectory ?? ''}
              diffStatsByPath={diffStatsByPath}
              focusedId={focusedMsgId}
              onFocus={focusMessage}
            />
          )}
        </section>
      </main>

      <PermissionStrip
        pending={permissions.pending}
        onApprove={permissions.approve}
        onReject={permissions.reject}
        error={permissions.error}
      />

      <ReconcileStrip
        agents={agents}
        messages={messages}
        isMultiSession={
          swarmRunMeta?.pattern === 'council' &&
          (swarmRunMeta?.sessionIDs.length ?? 0) > 1
        }
        onFocus={focusMessage}
        focusedMsgId={focusedMsgId}
        onCopyDraft={async (draft) => {
          const text = draft.body ?? draft.title ?? '';
          if (!text) return;
          try {
            await navigator.clipboard.writeText(text);
          } catch (err) {
            console.error('[reconcile/copy] clipboard blocked', err);
          }
        }}
        onForwardDraft={async (draft, agent) => {
          if (!swarmRunMeta) return;
          const body = (draft.body ?? draft.title ?? '').trim();
          if (!body) return;
          const text = [
            `The council has accepted ${agent.name}'s draft. Continuing from:`,
            '',
            body,
          ].join('\n');
          for (const sid of swarmRunMeta.sessionIDs) {
            try {
              await postSessionMessageBrowser(sid, swarmRunMeta.workspace, text);
            } catch (err) {
              if (err instanceof CostCapError) {
                setCostCapBlock({
                  swarmRunID: err.swarmRunID,
                  costTotal: err.costTotal,
                  costCap: err.costCap,
                  message: err.message,
                });
                return;
              }
              console.error('[reconcile/forward] session failed', sid, err);
            }
          }
        }}
        onStartRoundTwo={async (drafts) => {
          if (!swarmRunMeta) return;
          const block = drafts
            .map(
              ({ agent, draft }) =>
                `--- ${agent.name} ---\n${(draft.body ?? draft.title ?? '').trim()}`,
            )
            .join('\n\n');
          const text = [
            'Round 2. Below are the Round-1 drafts from every council member.',
            'Revise your own response in light of the others, or state clearly',
            'which member\'s draft you accept and why. Respond now.',
            '',
            block,
          ].join('\n');
          for (const sid of swarmRunMeta.sessionIDs) {
            try {
              await postSessionMessageBrowser(sid, swarmRunMeta.workspace, text);
            } catch (err) {
              if (err instanceof CostCapError) {
                setCostCapBlock({
                  swarmRunID: err.swarmRunID,
                  costTotal: err.costTotal,
                  costCap: err.costCap,
                  message: err.message,
                });
                return;
              }
              console.error('[reconcile/round2] session failed', sid, err);
            }
          }
        }}
      />

      <SynthesisStrip
        agents={agents}
        messages={messages}
        pattern={swarmRunMeta?.pattern ?? null}
        sessionCount={swarmRunMeta?.sessionIDs.length ?? 0}
        onFocus={focusMessage}
        focusedMsgId={focusedMsgId}
      />

      {costCapBlock && (
        <CostCapBanner
          block={costCapBlock}
          onOpenRouting={() => {
            setCostCapBlock(null);
            setRoutingOpen(true);
          }}
          onDismiss={() => setCostCapBlock(null)}
        />
      )}

      <SwarmComposer
        agents={agents}
        disabled={!liveSessionId || !liveDirectory}
        disabledReason="no active run — start one from the status rail to compose"
        onSend={(target: ComposerTarget, body: string) => {
          if (!liveSessionId || !liveDirectory) return;
          // Agent target → opencode `agent` field (agent-config name, not UI id).
          // Broadcast → omit `agent`; opencode routes to the session's lead.
          const agentName =
            target.kind === 'agent'
              ? agents.find((a) => a.id === target.id)?.name
              : undefined;
          postSessionMessageBrowser(liveSessionId, liveDirectory, body, {
            agent: agentName,
          }).catch((err) => {
            if (err instanceof CostCapError) {
              setCostCapBlock({
                swarmRunID: err.swarmRunID,
                costTotal: err.costTotal,
                costCap: err.costCap,
                message: err.message,
              });
              return;
            }
            console.error('[composer] opencode post failed', err);
          });
        }}
      />

      <StatusRail
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenRouting={() => setRoutingOpen(true)}
        onOpenHistory={() => setHistoryOpen(true)}
        onOpenGlossary={() => setGlossaryOpen(true)}
        onOpenNewRun={() => setNewRunOpen(true)}
        onOpenProvenance={swarmRunID ? () => setProvenanceOpen(true) : null}
        onOpenCost={() => setCostOpen(true)}
        swarmRunID={swarmRunID}
      />

      <Drawer
        open={drawerOpen && (!!focusedMsgId || !!selectedAgentId || !!selectedFileHeat)}
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
          selectedFileHeat={selectedFileHeat}
          workspace={swarmRunMeta?.workspace ?? liveDirectory ?? ''}
          onFocus={focusMessage}
          embedded
        />
      </Drawer>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        nodes={paletteNodes}
        onJump={focusMessage}
        actions={paletteActions}
      />

      <RoutingModal open={routingOpen} onClose={() => setRoutingOpen(false)} />

      <LiveCommitHistory
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        turns={liveTurns}
        diffs={liveDiffs}
        loading={diffLoading}
        error={diffError}
      />

      <SpawnAgentModal
        open={spawnOpen}
        onClose={() => setSpawnOpen(false)}
        directory={liveDirectory}
      />

      <GlossaryModal open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />

      <NewRunModal open={newRunOpen} onClose={() => setNewRunOpen(false)} />

      <RunProvenanceDrawer
        swarmRunID={swarmRunID}
        open={provenanceOpen}
        onClose={() => setProvenanceOpen(false)}
      />

      <CostDashboard open={costOpen} onClose={() => setCostOpen(false)} />
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
  onOpenProvenance,
  onOpenCost,
  swarmRunID,
}: {
  onOpenPalette: () => void;
  onOpenRouting: () => void;
  onOpenHistory: () => void;
  onOpenGlossary: () => void;
  onOpenNewRun: () => void;
  onOpenProvenance: (() => void) | null;
  onOpenCost: () => void;
  swarmRunID: string | null;
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
        <SwarmRunsPicker currentSwarmRunID={swarmRunID}>
          <button
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
            aria-label="browse swarm runs"
          >
            <span className="font-mono text-[10px] uppercase tracking-widest2">runs</span>
            <span className="font-mono text-[9px] text-fog-700">▴</span>
          </button>
        </SwarmRunsPicker>
        <Tooltip
          side="top"
          wide
          content={
            <div className="space-y-0.5">
              <div className="font-mono text-[11px] text-fog-200">cross-run cost</div>
              <div className="font-mono text-[10.5px] text-fog-600">
                $ / tokens across every persisted run · by workspace + top spenders
              </div>
            </div>
          }
        >
          <button
            onClick={onOpenCost}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
            aria-label="open cost dashboard"
          >
            <span className="font-mono text-[10px] uppercase tracking-widest2">cost</span>
          </button>
        </Tooltip>
        <Tooltip
          side="top"
          wide
          content={
            <div className="space-y-0.5">
              <div className="font-mono text-[11px] text-fog-200">cross-preset metrics</div>
              <div className="font-mono text-[10.5px] text-fog-600">
                aggregates per pattern · avg duration, tokens, cost, stale%
              </div>
            </div>
          }
        >
          <Link
            href="/metrics"
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
            aria-label="open cross-preset metrics"
          >
            <span className="font-mono text-[10px] uppercase tracking-widest2">metrics</span>
          </Link>
        </Tooltip>
        <Tooltip
          side="top"
          wide
          content={
            <div className="space-y-0.5">
              <div className="font-mono text-[11px] text-fog-200">project-time matrix</div>
              <div className="font-mono text-[10.5px] text-fog-600">
                every repo × every day · run markers colored by status
              </div>
            </div>
          }
        >
          <Link
            href="/projects"
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
            aria-label="open project-time matrix"
          >
            <span className="font-mono text-[10px] uppercase tracking-widest2">projects</span>
          </Link>
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

        {onOpenProvenance && (
          <Tooltip
            side="top"
            wide
            content={
              <div className="space-y-0.5">
                <div className="font-mono text-[11px] text-fog-200">run provenance</div>
                <div className="font-mono text-[10.5px] text-fog-600">
                  L0 event log for this swarm run · replay + live
                </div>
              </div>
            }
          >
            <button
              onClick={onOpenProvenance}
              className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
            >
              <span className="text-fog-700">provenance</span>
            </button>
          </Tooltip>
        )}

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

// Dedicated screen for a dead ?swarmRun= link. Deliberately *not* rendered
// inside the normal chrome — we don't want the topbar/timeline to tease a
// live-looking view over stale state. The two exits point at the recoverable
// next actions: strip the param (go home / mock view) or start a fresh run.
function RunNotFoundScreen({ swarmRunID }: { swarmRunID: string }) {
  return (
    <div className="h-screen w-screen flex items-center justify-center bg-ink-900 bg-noise">
      <div className="w-[420px] hairline rounded bg-ink-900/60 shadow-lg">
        <div className="px-4 h-7 hairline-b flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-rust" />
          <span className="font-mono text-micro uppercase tracking-widest2 text-rust">
            run not found
          </span>
        </div>
        <div className="px-4 py-3 hairline-b space-y-2">
          <div className="font-mono text-[11px] text-fog-400 leading-relaxed">
            no swarm run matches this id. the link may be stale, the run may
            have been deleted, or the id may have a typo.
          </div>
          <div className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 items-baseline">
            <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
              run id
            </span>
            <span className="font-mono text-[11px] text-fog-200 truncate tabular-nums" title={swarmRunID}>
              {swarmRunID}
            </span>
          </div>
        </div>
        <div className="px-4 py-2.5 flex items-center gap-2">
          <a
            href="/"
            className="h-6 px-2 rounded hairline bg-ink-900 hover:bg-ink-800 font-mono text-[10px] uppercase tracking-widest2 text-fog-400 hover:text-fog-200 transition flex items-center"
          >
            clear link
          </a>
          <span className="ml-auto font-mono text-[10px] text-fog-700">
            or start a new run from the status rail
          </span>
        </div>
      </div>
    </div>
  );
}
