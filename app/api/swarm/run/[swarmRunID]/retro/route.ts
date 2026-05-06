// GET /api/swarm/run/:swarmRunID/retro
//
// Returns L2 rollup data (RunRetro + AgentRollup[]) for a single run.
// The dedicated /retro/:id page reads this data server-side via getRetro()
// directly; this endpoint exists for browser-side fetches (e.g., cross-run
// comparison, seed-from-previous-run) that can't import the server-only
// memory module.

import type { NextRequest } from 'next/server';

import { getRun } from '@/lib/server/swarm-registry';
import { countRollups, getRetro } from '@/lib/server/memory/reader';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: { swarmRunID: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }

  const data = getRetro(params.swarmRunID);

  if (!data) {
    return Response.json({
      retro: null,
      agentRollups: [],
      rollupCount: countRollups(params.swarmRunID),
    }, { status: 200 });
  }

  return Response.json({
    retro: data.retro,
    agentRollups: data.agentRollups,
    rollupCount: data.agentRollups.length + (data.retro ? 1 : 0),
  }, { status: 200 });
}