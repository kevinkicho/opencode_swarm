'use client';

import type { ReactNode } from 'react';
import clsx from 'clsx';
import { SwarmComposer, type ComposerTarget } from '@/components/swarm-composer';
import { StatusRail } from '@/components/status-rail';
import { resolveSendTargets } from '@/lib/composer-targets';
import type { Agent, AgentMessage } from '@/lib/swarm-types';
import type { SwarmRunMeta } from '@/lib/swarm-run-types';
import type { CostCapHook } from './use-cost-cap-block';

function StreamingIndicator({ agents }: { agents: Agent[] }) {
  const thinking = agents.filter((a) => a.status === 'thinking' || a.status === 'working');
  if (thinking.length === 0) return null;
  return (
    <div className="flex items-center gap-1 h-5 px-2">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-molten opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-molten" />
      </span>
      <span className="font-mono text-[9px] uppercase tracking-widest2 text-molten tabular-nums">
        {thinking.length} active
      </span>
    </div>
  );
}

type PageFooterProps = {
  agents: Agent[];
  liveSessionId: string | null;
  liveDirectory: string | null;
  swarmRunMeta: SwarmRunMeta | null;
  swarmRunID: string | null;
  safePost: CostCapHook['safePost'];
  modals: {
    openers: Record<string, () => void>;
  };
};

export function PageFooter({
  agents,
  liveSessionId,
  liveDirectory,
  swarmRunMeta,
  swarmRunID,
  safePost,
  modals,
}: PageFooterProps) {
  return (
    <footer className="contents">
      <StreamingIndicator agents={agents} />
      <SwarmComposer
        agents={agents}
        disabled={!liveSessionId || !liveDirectory}
        disabledReason="no active run — start one from the status rail to compose"
        onSend={(target: ComposerTarget, body: string) => {
          if (!liveSessionId || !liveDirectory) return;
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
        onOpenDiagnostics={modals.openers.diagnostics}
        onOpenNewRun={modals.openers.newRun}
        onOpenProvenance={swarmRunID ? modals.openers.provenance : null}
        onOpenCost={modals.openers.cost}
        onOpenMetrics={modals.openers.metrics}
        onOpenProjects={modals.openers.projects}
        swarmRunID={swarmRunID}
      />
    </footer>
  );
}