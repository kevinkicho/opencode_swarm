// GET /api/swarm/run/compare?ids=id1,id2,id3
//
// Batch-fetch retro data for cross-run comparison. Returns an array
// of retro objects (one per ID) in the same order as requested. Missing
// or no-rollup runs include a null retro.

import type { NextRequest } from 'next/server';

import { getRetro, countRollups } from '@/lib/server/memory/reader';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const ids = req.nextUrl.searchParams.get('ids');
  if (!ids) {
    return Response.json({ error: 'ids query parameter required (comma-separated)' }, { status: 400 });
  }

  const runIDs = ids.split(',').map((s) => s.trim()).filter(Boolean);
  if (runIDs.length < 2) {
    return Response.json({ error: 'at least 2 run IDs required' }, { status: 400 });
  }
  if (runIDs.length > 10) {
    return Response.json({ error: 'maximum 10 run IDs for comparison' }, { status: 400 });
  }

  const results = runIDs.map((id) => {
    const data = getRetro(id);
    return {
      swarmRunID: id,
      retro: data?.retro ?? null,
      agentRollups: data?.agentRollups ?? [],
      rollupCount: countRollups(id),
    };
  });

  return Response.json(results, { status: 200 });
}