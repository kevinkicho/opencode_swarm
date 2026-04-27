'use client';

import clsx from 'clsx';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { ProfileBoundary } from '@/components/perf/profile-boundary';
import { useRouter, useSearchParams } from 'next/navigation';
import { SwarmTopbar } from '@/components/swarm-topbar';
import { LeftTabs } from '@/components/left-tabs';
import { SwarmTimeline } from '@/components/swarm-timeline';
import { roleNamesFromMeta, useLiveBoard, useLiveTicker } from '@/lib/blackboard/live';
import { deriveSilentSessions } from '@/lib/silent-session';
import { lazyWithRetry } from '@/lib/lazy-with-retry';
// Modals and drawers below are gated by `open={...}` state that defaults to
// closed — they cost 0 visual rent until the user opens them. Lazy-loading
// via next/dynamic keeps them out of the initial JS bundle, which matters
// because page.tsx is the largest client chunk in the app (~6 MB in dev).
// ssr:false is safe: each component is already client-only code rendered
// inside a client page, and nothing on the closed state needs pre-render.
// Each loader is wrapped in lazyWithRetry so a transient ChunkLoadError
// (webpack hash rotating mid-HMR, or SSE-saturated dev server dropping a
// chunk request) retries twice before surfacing — covers the common case
// without masking real import failures.
// Modal renders moved to app/page-internals/page-modals.tsx (#7.Q26
// decomposition wave 2). The 8 dynamic-imported overlays live there now,
// alongside the useModalState hook that owns their open/close flags.
// Inspector stays here — it's gated by drawerOpen + the selection state
// (focusedMsgId / selectedAgentId / selectedFileHeat), which is too
// entangled with the page-level interaction model to extract cleanly.
const Inspector = dynamic(
  lazyWithRetry(() =>
    import('@/components/inspector').then((m) => m.Inspector),
  ),
  { ssr: false },
);
import { PageModals } from './page-internals/page-modals';
import { useModalState } from './page-internals/use-modal-state';
import { useSelectionState } from './page-internals/use-selection-state';
import { useCostCapBlock } from './page-internals/use-cost-cap-block';
import { useGlobalKeybindings } from './page-internals/use-global-keybindings';
import { useViewState } from './page-internals/use-view-state';
import type { PaletteAction } from '@/components/command-palette';
import { SwarmRunsPicker } from '@/components/swarm-runs-picker';
import { StatusRail } from '@/components/status-rail';
import { RunNotFoundScreen } from '@/components/run-not-found-screen';
// Pattern-specific main-view rails (moved 2026-04-24 from LeftTabs to
// main viewport per user feedback: pattern-specific deep observability
// IS the primary surface for understanding the run, not a left-rail
// secondary tab).
//
// 2026-04-25 — converted to next/dynamic + lazyWithRetry. Each rail is
// only rendered when its specific runView is active (gated by the
// switch in the JSX), so we never need them in the initial bundle.
// Defers ~10 component-trees worth of JS until the user actually
// clicks the corresponding tab. ssr:false is safe (parent is 'use
// client', component is interactive). Loading state is null because
// the tab switch is a single click — a flash of empty space is less
// jarring than a spinner.
const TurnCardsView = dynamic(
  lazyWithRetry(() =>
    import('@/components/turn-cards-view').then((m) => m.TurnCardsView),
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
import { SwarmComposer, type ComposerTarget } from '@/components/swarm-composer';
import { resolveSendTargets } from '@/lib/composer-targets';
import { CostCapBanner } from '@/components/cost-cap-banner';
import { PermissionStrip } from '@/components/permission-strip';
import { ReconcileStrip } from '@/components/reconcile-strip';
import { SynthesisStrip } from '@/components/synthesis-strip';
import { JudgeVerdictStrip } from '@/components/judge-verdict-strip';
import { CriticVerdictStrip } from '@/components/critic-verdict-strip';
import { OrchestratorActionsStrip } from '@/components/orchestrator-actions-strip';
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
  useLiveSwarmRunMessages,
  useSwarmRunSnapshot,
  useSessionDiff,
  useSwarmRuns,
} from '@/lib/opencode/live';
import {
  type LiveTurn,
  type TurnCard,
  type FileHeat,
} from '@/lib/opencode/transform';
import {
  useSwarmView,
  EMPTY_SWARM_VIEW,
  type SwarmView,
} from './page-internals/use-swarm-view';
import { useDiffStats } from './page-internals/use-diff-stats';
import { tokensForBudget } from '@/lib/opencode/pricing';
import type { DiffData } from '@/lib/types';
import type { AgentMessage, Agent, RunMeta, ProviderSummary, TodoItem } from '@/lib/swarm-types';
import type { SwarmRunMeta, SwarmRunStatus } from '@/lib/swarm-run-types';
import type { TimelineNode } from '@/lib/types';

// runView gates — single source of truth for which main-panel views
// are available given the active run's pattern + board state. Three
// surfaces consume this:
//   - the runView state union type (derived via keyof typeof)
//   - the toolbar render (filter visible buttons by gate(ctx)===true)
//   - the auto-reset effect (snap back to 'timeline' when the current
//     view's gate flips false, e.g. user navigates from critic-loop
//     with `iterations` to a council run)
// Pre-2026-04-25 each surface had its own copy of the conditional
// logic; drift would silently render dead tabs or auto-reset away
// from a valid view.
type ViewGateContext = {
  pattern: SwarmRunMeta['pattern'] | undefined;
  boardSwarmRunID: string | null;
};
type ViewConfig = {
  enabled: (ctx: ViewGateContext) => boolean;
  // Hover hint surfaced via Tooltip on the toolbar button. Keep one
  // sentence — long enough to disambiguate from siblings, short enough
  // to read in a hover.
  hint: string;
};
const VIEW_PATTERN_GATES: Record<string, ViewConfig> = {
  timeline: {
    enabled: () => true,
    hint: 'cross-lane event flow with A2A wires',
  },
  cards: {
    enabled: () => true,
    hint: 'per-turn conversation cards · collapses tool calls into chips',
  },
  board: {
    enabled: (ctx) => !!ctx.boardSwarmRunID,
    hint: 'full blackboard kanban · todos / claims / findings',
  },
  contracts: {
    enabled: (ctx) => !!ctx.boardSwarmRunID,
    hint: 'auditor verdicts against acceptance criteria',
  },
  iterations: {
    enabled: (ctx) => ctx.pattern === 'critic-loop',
    hint: 'critic-loop: worker draft → critic review → revise',
  },
  debate: {
    enabled: (ctx) => ctx.pattern === 'debate-judge',
    hint: 'debate-judge: N generators propose, judge picks',
  },
  map: {
    enabled: (ctx) => ctx.pattern === 'map-reduce',
    hint: 'map-reduce: per-mapper drafts + synthesis claim',
  },
  council: {
    enabled: (ctx) => ctx.pattern === 'council',
    hint: 'council members\' drafts + reconciliation',
  },
  strategy: {
    enabled: (ctx) => ctx.pattern === 'orchestrator-worker',
    hint: 'orchestrator-worker: planner sweeps + re-plan history',
  },
} as const;
type RunView = keyof typeof VIEW_PATTERN_GATES;
const RUN_VIEW_KEYS = Object.keys(VIEW_PATTERN_GATES) as RunView[];

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ProfileBoundary id="page-inner">
        <PageInner />
      </ProfileBoundary>
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
  // 2026-04-25 IMPL 6.6 follow-up — migrated from useLiveSwarmRun
  // (single-endpoint /api/swarm/run/:id meta fetch) to
  // useSwarmRunSnapshot (aggregator endpoint that bundles meta + board
  // + ticker + tokens + planRevisions in one fetch). Backend measured
  // 4.5x cold-load speedup on the aggregator vs the prior 5-call
  // fan-out. Live updates continue to flow through the existing SSE
  // channels (useLiveBoard subscribes to /board/events, useLiveTicker
  // polls every 5s) — this hook only owns the cold-load seed.
  const swarmRunSnap = useSwarmRunSnapshot(swarmRunID);
  const swarmRunMeta_ = swarmRunSnap.snapshot?.meta ?? null;
  const swarmRunNotFound = swarmRunSnap.notFound;
  const swarmRunPrimarySessionID = swarmRunMeta_?.sessionIDs[0] ?? null;
  // Ledger poll re-enabled at slow cadence (2026-04-24 evening): the
  // earlier `enabled: false` saved cold-load fetches but had two
  // failure modes: (1) topbar status went permanently stale after a
  // run ended (no refresh source), so a "live" cache from earlier
  // could persist indefinitely until the user re-opened the picker;
  // (2) opening the picker took ~5 s while the cold fetch landed.
  // 30 s cadence is the compromise: ledger refreshes once per 30 s
  // (vs 4 s previously), populates the topbar status reliably, and
  // pre-warms the picker so it opens with data already cached.
  // TanStack Query dedups the picker's hook against this one via
  // shared queryKey, so opening the picker doesn't trigger an
  // additional cold flight.
  const runsSnapshot = useSwarmRuns({ intervalMs: 30000, enabled: true });
  const currentRunStatus: SwarmRunStatus | null = useMemo(() => {
    if (!swarmRunID) return null;
    const row = runsSnapshot.rows.find((r) => r.meta.swarmRunID === swarmRunID);
    return row?.status ?? null;
  }, [runsSnapshot.rows, swarmRunID]);
  // When the swarmRunID is terminal-dead (404) we still need to pass null
  // through the downstream session/permission hooks rather than branching
  // early — rules-of-hooks requires a stable call order across renders.
  // The dead-link screen is rendered conditionally in JSX below.
  const swarmRunMissing = Boolean(swarmRunID) && swarmRunNotFound;
  const sessionId = swarmRunMissing
    ? null
    : swarmRunID
      ? swarmRunPrimarySessionID
      : directSessionId;
  const { data: liveData } = useLiveSession(sessionId);
  // Multi-session fan-out for council / future N-member patterns. The hook
  // collapses to a one-slot no-op when meta is null or carries a single
  // sessionID, so we can call it unconditionally and let the view decide
  // which channel to consume.
  const liveSwarmRun = useLiveSwarmRunMessages(swarmRunMeta_);
  const isMultiSession = (swarmRunMeta_?.sessionIDs.length ?? 0) > 1;
  const liveDirectory = liveData?.session?.directory ?? null;
  const permissions = useLivePermissions(sessionId, liveDirectory);

  const view: SwarmView = useSwarmView({
    isMultiSession,
    liveSwarmRun,
    swarmRunMeta: swarmRunMeta_,
    sessionId,
    liveData: liveData ?? null,
  });

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
        liveSlots={liveSwarmRun.slots}
        swarmRunID={swarmRunID}
        swarmRunMeta={swarmRunMeta_}
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
  liveSlots,
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
  // Per-session message slots from useLiveSwarmRunMessages — threaded
  // through to LeftTabs for the iterations / debate / map per-pattern
  // tabs. Empty array when there's no active swarm run.
  liveSlots: import('@/lib/opencode/live').LiveSwarmSessionSlot[];
  swarmRunID: string | null;
  swarmRunMeta: SwarmRunMeta | null;
  swarmRunStatus: SwarmRunStatus | null;
  swarmRuns: import('@/lib/swarm-run-types').SwarmRunListRow[];
}) {
  const router = useRouter();
  // 8 modal flag/setter pairs collapsed into one hook — see
  // app/page-internals/use-modal-state.ts. The hook hands back stable
  // openers/closers so passing them down doesn't invalidate downstream
  // memos.
  const modals = useModalState();
  // Cost-cap block + safe-post wrapper hub. See
  // app/page-internals/use-cost-cap-block.ts. Auto-clears the banner
  // when swarmRunID changes; safePost is the only call sites use to
  // post messages — turns CostCapError into the banner side-effect
  // so call sites don't repeat the try/catch dance.
  const { costCapBlock, safePost, dismissCap } = useCostCapBlock(swarmRunID);
  // (view-state hub moved below boardSwarmRunID — needs it as a gate input)

  // Board SSE subscription lives at the page level so both the left-rail
  // "board" tab and the main-view "board" toggle read from the same
  // EventSource. Null when the run's pattern doesn't drive the board —
  // hooks short-circuit to empty state without opening a connection.
  // Patterns that populate the board: blackboard (obviously) plus
  // orchestrator-worker (which seeds a board via the planner session).
  const boardPatterns: ReadonlySet<string> = useMemo(
    () =>
      new Set<string>([
        'blackboard',
        'orchestrator-worker',
      ]),
    [],
  );
  const boardSwarmRunID =
    swarmRunMeta?.pattern && boardPatterns.has(swarmRunMeta.pattern)
      ? swarmRunMeta.swarmRunID
      : null;
  const liveBoard = useLiveBoard(boardSwarmRunID);
  const liveTicker = useLiveTicker(boardSwarmRunID);
  // Pattern-aware role labels for board chips. Empty map on self-
  // organizing patterns (blackboard, council, map-reduce) — chips fall
  // back to numeric 1..N. Built once per meta change.
  const boardRoleNames = useMemo(
    () => roleNamesFromMeta(swarmRunMeta),
    [swarmRunMeta],
  );

  // View state hub — leftTab, runView, focusTodoId + jumpToTodo. See
  // app/page-internals/use-view-state.ts. Single source for the cross-
  // cutting "click a card → flip plan tab + flash a todo" UX, plus the
  // auto-reset effect that resets runView when its gate stops applying
  // (mid-pattern-switch).
  const viewState = useViewState<RunView>(
    'timeline',
    (view) =>
      VIEW_PATTERN_GATES[view].enabled({
        pattern: swarmRunMeta?.pattern,
        boardSwarmRunID,
      }),
    [swarmRunMeta?.pattern, boardSwarmRunID],
  );
  const { leftTab, setLeftTab, runView, setRunView, focusTodoId, jumpToTodo } = viewState;
  // (leftTab/runView/focusTodoId state, auto-reset effect, and jumpToTodo
  // handler now live in useViewState — see destructure above.)

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
  const { liveDiffs, diffStatsByPath } = useDiffStats({
    rawDiffs,
    workspace: swarmRunMeta?.workspace,
    liveDirectory,
  });

  // Selection-tuple state hub — see app/page-internals/use-selection-state.ts.
  // Owns focusedMsgId / selectedAgentId / selectedFileHeat / drawerOpen
  // plus the 7 handlers that enforce the "set one, clear the others,
  // open the drawer" invariant. selectSession bridges pattern-rail
  // sessionIDs → synthesised agent IDs by walking the agents array.
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

  // Cmd/Ctrl-K toggles the palette; Cmd/Ctrl-N opens the new-run modal.
  // Lives in useGlobalKeybindings so this file doesn't grow keybinding
  // tables inline as we add more shortcuts.
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

  // STATUS.md "silent since dispatch" — derive client-side so the
  // chip surfaces during the 90s window before F1 watchdog WARNs.
  // Memoised on the slots reference; recomputes when messages tick.
  const silentSessions = useMemo(
    () => deriveSilentSessions(liveSlots),
    [liveSlots],
  );

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
          liveSlots={liveSlots}
          runSessionIDs={swarmRunMeta?.sessionIDs ?? []}
        />
        </ProfileBoundary>

        <section className="relative flex-1 flex flex-col min-w-0 min-h-0 pl-3">
          <div className="h-7 hairline-b px-3 flex items-center gap-2 bg-ink-850/80 backdrop-blur shrink-0">
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">view</span>
            <div className="flex items-center gap-0.5 font-mono text-micro uppercase tracking-widest2">
              {/* Toolbar visibility gate: each view's button is shown only
                  when its VIEW_PATTERN_GATES entry passes for the active
                  run. Single source of truth shared with the auto-reset
                  effect above so the two never drift. */}
              {RUN_VIEW_KEYS.filter((k) =>
                VIEW_PATTERN_GATES[k].enabled({
                  pattern: swarmRunMeta?.pattern,
                  boardSwarmRunID,
                }),
              ).map((k) => (
                <Tooltip key={k} content={VIEW_PATTERN_GATES[k].hint} side="bottom">
                  <button
                    type="button"
                    onClick={() => setRunView(k)}
                    className={clsx(
                      'h-5 px-2 rounded-sm transition-colors cursor-pointer',
                      runView === k
                        ? 'bg-molten/15 text-molten'
                        : 'text-fog-500 hover:text-fog-300 hover:bg-ink-800/60',
                    )}
                  >
                    {k}
                  </button>
                </Tooltip>
              ))}
            </div>
            <div className="flex-1" />
            <span className="font-mono text-micro tabular-nums text-fog-700">
              {runView === 'timeline'
                ? `${messages.length} events`
                : runView === 'cards'
                  ? `${turnCards.length} turns`
                  : runView === 'board' || runView === 'contracts'
                    ? `${liveBoard.items?.length ?? 0} items`
                    : `${liveSlots.length} sessions`}
            </span>
          </div>
          {(() => {
            // Switch-style render so we don't pile 11 ternary branches.
            // Each pattern-specific view falls back to timeline when its
            // pattern flag is false, which can happen if the user lands
            // on the URL with a stale runView selection from before a
            // pattern switch.
            switch (runView) {
              case 'timeline':
                return (
                  <ProfileBoundary id="swarm-timeline">
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
                      onFocus={focusMessage}
                    />
                  </ProfileBoundary>
                );
              case 'contracts':
                return (
                  <ProfileBoundary id="contracts-rail">
                    <ContractsRail live={liveBoard} embedded />
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
          })()}
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
            const result = await safePost(
              sid,
              swarmRunMeta.workspace,
              text,
              undefined,
              'reconcile/forward',
            );
            if (!result.ok && result.capped) return;
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
            const result = await safePost(
              sid,
              swarmRunMeta.workspace,
              text,
              undefined,
              'reconcile/round2',
            );
            if (!result.ok && result.capped) return;
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

      <JudgeVerdictStrip
        agents={agents}
        messages={messages}
        meta={swarmRunMeta}
        onFocus={focusMessage}
      />

      <CriticVerdictStrip
        agents={agents}
        messages={messages}
        meta={swarmRunMeta}
        onFocus={focusMessage}
      />

      <OrchestratorActionsStrip
        agents={agents}
        messages={messages}
        meta={swarmRunMeta}
        onAction={async (actionID, prompt) => {
          if (!swarmRunMeta) return;
          const orchestratorSID = swarmRunMeta.sessionIDs[0];
          if (!orchestratorSID) return;
          // Don't pass `agent` — opencode silently drops POSTs whose
          // `agent` field isn't one of its built-ins (build/compaction/
          // explore/general/plan/summary/title). 'orchestrator' is our
          // role label, not an opencode agent. Past behavior: every
          // button click 204'd silently, no message posted, no
          // observable event. See reference_opencode_agent_silent_drop.md.
          await safePost(
            orchestratorSID,
            swarmRunMeta.workspace,
            prompt,
            undefined,
            `orchestrator-action/${actionID}`,
          );
        }}
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

      {/* Composer + status rail are app-level controls; semantically
          the page's footer. Wrapping in <footer> brings them into a
          landmark so axe's `region` rule counts them as contained
          content (was: floating textareas + buttons outside any
          landmark, flagged 2026-04-27). */}
      <footer className="contents">
      <SwarmComposer
        agents={agents}
        disabled={!liveSessionId || !liveDirectory}
        disabledReason="no active run — start one from the status rail to compose"
        onSend={(target: ComposerTarget, body: string) => {
          if (!liveSessionId || !liveDirectory) return;
          // #7.Q37 — route per-agent sends by sessionID, not by passing
          // the agent's UI name to opencode's `agent` field. Our agent
          // names ('build #1', 'member-1', 'mapper-1', etc.) aren't
          // opencode built-in agents, so the prior `{ agent: agentName }`
          // path silently 204'd every per-agent send. The sessionID-
          // routing approach is correct anyway: each team agent has its
          // own opencode session, so posting there sends to that worker
          // directly.
          //
          // #174 (2026-04-26) — broadcast was previously falling through
          // to the primary session only ("opencode routes to its lead"),
          // which on multi-session patterns silently dropped the message
          // for every worker except the lead. Fix: collect every distinct
          // sessionID across the roster and fan-post in parallel. Set
          // dedupes the (rare) case where two agents share a session
          // (e.g. one session running planner + synthesizer roles).
          // Agents without a sessionID (anything pre-bind) are skipped.
          const sessionIDs = resolveSendTargets(target, agents, liveSessionId);
          const tag = target.kind === 'broadcast' ? 'composer-broadcast' : 'composer';
          for (const sid of sessionIDs) {
            void safePost(sid, liveDirectory, body, undefined, tag);
          }
        }}
      />

      <StatusRail
        onOpenPalette={modals.openers.palette}
        onOpenRouting={modals.openers.routing}
        onOpenHistory={modals.openers.history}
        onOpenGlossary={modals.openers.glossary}
        onOpenNewRun={modals.openers.newRun}
        onOpenProvenance={swarmRunID ? modals.openers.provenance : null}
        onOpenCost={modals.openers.cost}
        swarmRunID={swarmRunID}
      />
      </footer>

      <Drawer
        open={drawerOpen && (!!focusedMsgId || !!selectedAgentId || !!selectedFileHeat)}
        onClose={closeDrawer}
        eyebrow={drawerEyebrow}
        title={drawerTitle}
        width={380}
        dismissOnClickOutside
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
        swarmRunID={swarmRunID}
      />
    </div>
    </ProviderStatsProvider>
    </PlaybackProvider>
  );
}

