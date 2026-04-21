// Dedicated retro viewer page: /retro/<swarmRunID>
//
// Server component — reads rollups directly from the L2 store on the Node
// runtime. No HTTP round-trip to our own API. Pure read path; no caching
// directives needed beyond Next's default (which is dynamic because of
// the URL param).
//
// If a run has no rollup yet, the view renders an "empty" state with the
// exact curl command to generate one. That's intentional — running the
// rollup endpoint is a conscious act (it's a reducer over live opencode
// state), so we don't auto-trigger it from a page load.

import type { Metadata } from 'next';

import { RetroView } from '@/components/retro-view';
import { getRetro } from '@/lib/server/memory/reader';

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
  return (
    <RetroView
      swarmRunID={params.swarmRunID}
      retro={data?.retro ?? null}
      agentRollups={data?.agentRollups ?? []}
    />
  );
}
