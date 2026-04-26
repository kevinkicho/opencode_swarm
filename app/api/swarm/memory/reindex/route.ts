// POST /api/swarm/memory/reindex — rebuild the L1 part index from L0.
//
// Body shape:
//   { swarmRunID?: string }
//     when set, reindex only that run; otherwise reindex every persisted run.
//
// Use cases:
//   - one-shot backfill after first install (runs existed before the memory
//     DB was added)
//   - schema change: drop memory.sqlite, POST with no body, rebuild from L0
//   - manual refresh when the user suspects a run was partially indexed
//
// Idempotent: ingest resumes from the per-run event_seq cursor stored in
// `ingest_cursors`. Calling twice in a row is a no-op on unchanged input.
//
// Not authenticated — this is a single-user dev tool. Deployment is
// personal-use-only (see memory project_deployment_scope), so there is no
// multi-tenant surface to protect.

import type { NextRequest } from 'next/server';

import { reindexAllRuns, reindexRunById } from '@/lib/server/memory/ingest';

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
      const result = await reindexRunById(body.swarmRunID);
      if (!result) {
        return Response.json({ error: 'swarm run not found' }, { status: 404 });
      }
      return Response.json({ results: [{ swarmRunID: body.swarmRunID, ...result }] });
    }
    const results = await reindexAllRuns();
    return Response.json({ results });
  } catch (err) {
    return Response.json(
      { error: 'reindex failed', detail: (err as Error).message },
      { status: 500 }
    );
  }
}
