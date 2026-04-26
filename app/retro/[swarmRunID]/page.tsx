// Dedicated retro viewer page: /retro/<swarmRunID>
//
// Server component — reads rollups directly from the L2 store on the Node
// runtime. No HTTP round-trip to our own API. Pure read path; no caching
// directives needed beyond Next's default (which is dynamic because of
// the URL param).
//
// If a run has no rollup yet, the view renders the empty state with a
// "generate rollup" button (Q20+Q24). Newer runs auto-fire a rollup at
// stop time so the empty state is mostly hit on older runs or aborted
// stops where the rollup couldn't complete.
//
// Q40: ticker snapshot is also fetched and passed through so the retro
// view can surface "stopped at min N · <stopReason>" on failure-mode
// runs (opencode-frozen, zen-rate-limit, replan-loop-exhausted). Pulled
// from the persisted SQLite snapshot (Q21 path) — survives dev reloads.

import type { Metadata } from 'next';

import { RetroView } from '@/components/retro-view';
import { getRetro } from '@/lib/server/memory/reader';
// Read-only path: import directly from auto-ticker/state to skip the
// lifecycle module's heavy transitive chain (coordinator + planner).
// Same reason as /snapshot route — cuts retro page compile cost.
import { getTickerSnapshot } from '@/lib/server/blackboard/auto-ticker/state';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface PageProps {
  params: { swarmRunID: string };
}

export function generateMetadata({ params }: PageProps): Metadata {
  return {
    title: `retro · ${params.swarmRunID}`,
  };
}

export default function RetroPage({ params }: PageProps) {
  const data = getRetro(params.swarmRunID);
  // getTickerSnapshot is non-throwing — returns null when the run has
  // no ticker (e.g., a non-blackboard pattern, or the registry is fresh
  // post-process-restart and the run completed before that). Null is
  // fine; the retro view's failure header simply doesn't render.
  const ticker = getTickerSnapshot(params.swarmRunID);
  return (
    <RetroView
      swarmRunID={params.swarmRunID}
      retro={data?.retro ?? null}
      agentRollups={data?.agentRollups ?? []}
      ticker={ticker}
    />
  );
}
