// POST /api/swarm/memory/rollup — run the L2 reducer over one run or all.
//
// Body shape:
//   { swarmRunID?: string }
//     when set, rolls up only that run; otherwise rolls up every run in the
//     ledger. Safe to call as a follow-up to /memory/reindex: rollup reads
//     live opencode messages, not the parts table, so the two surfaces are
//     independent.
//
// Idempotent: rollups are upserted by (swarm_run_id, session_id). A re-run
// with new events produces a superset; a re-run on unchanged input writes
// the same bytes back. No cleanup needed.
//
// Not authenticated — personal-use deployment (memory project_deployment_scope).

import type { NextRequest } from 'next/server';

import { generateRollupById, generateAllRollups } from '@/lib/server/memory/rollup';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<Response> {
  let body: { swarmRunID?: string } = {};
  try {
    const raw = await req.text();
    if (raw.trim()) body = JSON.parse(raw) as { swarmRunID?: string };
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  try {
    if (body.swarmRunID) {
      const result = await generateRollupById(body.swarmRunID);
      if (!result) {
        return Response.json({ error: 'swarm run not found' }, { status: 404 });
      }
      return Response.json({
        swarmRunID: body.swarmRunID,
        agentCount: result.agentRollups.length,
        retro: result.retro,
      });
    }
    const results = await generateAllRollups();
    return Response.json({ results });
  } catch (err) {
    return Response.json(
      { error: 'rollup failed', message: (err as Error).message },
      { status: 500 }
    );
  }
}
