'use client';

// Modal renders for the main page (#7.Q26 decomposition wave 2).
//
// The page hosts 8 dynamic-imported overlays. Originally each was declared
// + rendered inline in PageBody, with its own dynamic() block at the top
// of page.tsx and its own JSX in the trailing modal block. Pulling them
// here keeps the dynamic imports co-located with the renders and shrinks
// PageBody's prop surface to "modalState + the data the visible modal
// needs" rather than 8 separate flag/setter pairs.
//
// SSR is off for every modal here — they're all interaction-driven and
// the layout chrome behind them is what server-rendering buys us.
// lazyWithRetry guards against a transient chunk fetch failure during
// HMR or under SSE-saturation by retrying twice before bubbling.

import dynamic from 'next/dynamic';
import { lazyWithRetry } from '@/lib/lazy-with-retry';
import type { PaletteAction } from '@/components/command-palette';
import { ErrorBoundary } from '@/components/ui/error-boundary';
import type { TimelineNode, DiffData } from '@/lib/types';
import type { LiveTurn } from '@/lib/opencode/transform';
import type { PageModalState } from './use-modal-state';

const CommandPalette = dynamic(
  lazyWithRetry(() =>
    import('@/components/command-palette').then((m) => m.CommandPalette),
  ),
  { ssr: false },
);
const RoutingModal = dynamic(
  lazyWithRetry(() =>
    import('@/components/routing-modal').then((m) => m.RoutingModal),
  ),
  { ssr: false },
);
const LiveCommitHistory = dynamic(
  lazyWithRetry(() =>
    import('@/components/live-commit-history').then((m) => m.LiveCommitHistory),
  ),
  { ssr: false },
);
const SpawnAgentModal = dynamic(
  lazyWithRetry(() =>
    import('@/components/spawn-agent-modal').then((m) => m.SpawnAgentModal),
  ),
  { ssr: false },
);
const GlossaryModal = dynamic(
  lazyWithRetry(() =>
    import('@/components/glossary-modal').then((m) => m.GlossaryModal),
  ),
  { ssr: false },
);
const NewRunModal = dynamic(
  lazyWithRetry(() =>
    import('@/components/new-run-modal').then((m) => m.NewRunModal),
  ),
  { ssr: false },
);
const RunProvenanceDrawer = dynamic(
  lazyWithRetry(() =>
    import('@/components/run-provenance-drawer').then(
      (m) => m.RunProvenanceDrawer,
    ),
  ),
  { ssr: false },
);
const CostDashboard = dynamic(
  lazyWithRetry(() =>
    import('@/components/cost-dashboard').then((m) => m.CostDashboard),
  ),
  { ssr: false },
);
const DiagnosticsModal = dynamic(
  lazyWithRetry(() =>
    import('@/components/diagnostics-modal').then((m) => m.DiagnosticsModal),
  ),
  { ssr: false },
);
const MetricsModal = dynamic(
  lazyWithRetry(() =>
    import('@/components/metrics-modal').then((m) => m.MetricsModal),
  ),
  { ssr: false },
);
const ProjectsModal = dynamic(
  lazyWithRetry(() =>
    import('@/components/projects-modal').then((m) => m.ProjectsModal),
  ),
  { ssr: false },
);

export interface PageModalsProps {
  state: PageModalState;
  paletteNodes: TimelineNode[];
  paletteActions: PaletteAction[];
  onJumpToMessage: (id: string) => void;
  liveTurns: LiveTurn[];
  liveDiffs: DiffData[] | null;
  diffLoading: boolean;
  diffError: string | null;
  liveDirectory: string | null;
  // Swarm run's workspace path (Windows-format). Used as a fallback when
  // no session is focused yet so workspace-scoped diagnostics can still
  // probe — e.g., the diagnostics modal opening before liveData hydrates.
  runWorkspace: string | null;
  swarmRunID: string | null;
}

export function PageModals({
  state,
  paletteNodes,
  paletteActions,
  onJumpToMessage,
  liveTurns,
  liveDiffs,
  diffLoading,
  diffError,
  liveDirectory,
  runWorkspace,
  swarmRunID,
}: PageModalsProps) {
  const { flags, closers } = state;
  // Modals are always rendered (with open=false when closed) so their
  // dynamic-import chunks fetch + compile on initial page mount, not on
  // first click. Dev mode amplifies the difference: gating render behind
  // `flag && <Modal>` makes the first click pay a 2-3s on-demand compile
  // cost in Next.js dev, which manifests as "the button didn't fire."
  // Each modal sits inside its own ErrorBoundary so a render error in
  // one can't unmount the surrounding chrome — without this, a throw
  // inside e.g. DiagnosticsModal would unmount the whole tree (which
  // looks identical to "footer buttons stop responding").
  return (
    <>
      <ErrorBoundary scope="palette">
        <CommandPalette
          open={flags.palette}
          onClose={closers.palette}
          nodes={paletteNodes}
          onJump={onJumpToMessage}
          actions={paletteActions}
        />
      </ErrorBoundary>
      <ErrorBoundary scope="routing">
        <RoutingModal open={flags.routing} onClose={closers.routing} />
      </ErrorBoundary>
      <ErrorBoundary scope="history">
        <LiveCommitHistory
          open={flags.history}
          onClose={closers.history}
          turns={liveTurns}
          diffs={liveDiffs}
          loading={diffLoading}
          error={diffError}
        />
      </ErrorBoundary>
      <ErrorBoundary scope="spawn">
        <SpawnAgentModal
          open={flags.spawn}
          onClose={closers.spawn}
          directory={liveDirectory}
        />
      </ErrorBoundary>
      <ErrorBoundary scope="glossary">
        <GlossaryModal open={flags.glossary} onClose={closers.glossary} />
      </ErrorBoundary>
      <ErrorBoundary scope="new-run">
        <NewRunModal open={flags.newRun} onClose={closers.newRun} />
      </ErrorBoundary>
      <ErrorBoundary scope="provenance">
        <RunProvenanceDrawer
          swarmRunID={swarmRunID}
          open={flags.provenance}
          onClose={closers.provenance}
        />
      </ErrorBoundary>
      <ErrorBoundary scope="cost">
        <CostDashboard open={flags.cost} onClose={closers.cost} />
      </ErrorBoundary>
      <ErrorBoundary scope="diagnostics">
        <DiagnosticsModal
          open={flags.diagnostics}
          onClose={closers.diagnostics}
          directory={liveDirectory ?? runWorkspace}
        />
      </ErrorBoundary>
      <ErrorBoundary scope="metrics">
        <MetricsModal open={flags.metrics} onClose={closers.metrics} />
      </ErrorBoundary>
      <ErrorBoundary scope="projects">
        <ProjectsModal open={flags.projects} onClose={closers.projects} />
      </ErrorBoundary>
    </>
  );
}
