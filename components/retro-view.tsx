'use client';

// Read-only retro viewer for a single swarm run. Renders RunRetro +
// AgentRollup data as dense cards — header summarizes the run, lessons
// come next (the load-bearing field per DESIGN.md §7.4), then one card
// per participating session.
//
// No write actions. No "edit lesson", no "rerun rollup from here".
// Retention / regeneration are backend concerns (see DESIGN.md §7.7 and
// §7.6). If a retro looks stale, hit POST /api/swarm/memory/rollup from
// the terminal — this view is pure observation.
//
// Layout contract (dense-factory aesthetic):
//   - h-5/h-6 header rows with text-micro uppercase tracking-widest2
//   - monospace + tabular-nums for anything numeric
//   - hairline borders only; no drop shadows except card container
//   - outcome drives accent color: merged=mint, partial=amber,
//     aborted/failed=rust, default=fog
//
// Not a client-polled surface — the underlying rollups table only changes
// when someone POSTs /api/swarm/memory/rollup. Re-fetch on navigation.
//
// 2026-04-28 decomposition: header + body sections (Header, RunOverview,
// LessonsBlock, ArtifactGraphBlock) → retro-view/sections.tsx;
// EmptyRetro + rollup-generate card → retro-view/empty.tsx; agent
// rollup cards already lived in retro-view/agent-blocks.tsx.

import type { AgentRollup, RunRetro } from '@/lib/server/memory/types';
import type { TickerSnapshot } from '@/lib/blackboard/live';
import { AgentSection } from './retro-view/agent-blocks';
import {
  Header,
  RunOverview,
  LessonsBlock,
  ArtifactGraphBlock,
} from './retro-view/sections';
import { EmptyRetro } from './retro-view/empty';

interface Props {
  swarmRunID: string;
  retro: RunRetro | null;
  agentRollups: AgentRollup[];
  // #7.Q40 — ticker snapshot for failure-mode runs. When stopped with
  // a failure stopReason (opencode-frozen / zen-rate-limit /
  // replan-loop-exhausted), the header surfaces a prominent chip
  // showing "stopped at min N · <reason>" so the user doesn't have
  // to read the retro body to find out a run silently died. Null when
  // the run has no ticker (non-blackboard pattern, fresh process post-
  // restart, etc.) — header simply omits the failure chip.
  ticker?: TickerSnapshot | null;
}

export function RetroView({ swarmRunID, retro, agentRollups, ticker }: Props) {
  if (!retro && agentRollups.length === 0) {
    return <EmptyRetro swarmRunID={swarmRunID} />;
  }

  return (
    <div className="min-h-screen bg-ink-900 text-fog-100 flex flex-col">
      <Header retro={retro} swarmRunID={swarmRunID} ticker={ticker} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-[960px] py-6 px-5 space-y-6">
          {retro && <RunOverview retro={retro} />}
          {retro && retro.lessons.length > 0 && <LessonsBlock lessons={retro.lessons} />}
          {retro && retro.artifactGraph.filesFinal.length > 0 && (
            <ArtifactGraphBlock graph={retro.artifactGraph} />
          )}
          <AgentSection rollups={agentRollups} />
        </div>
      </div>
    </div>
  );
}
