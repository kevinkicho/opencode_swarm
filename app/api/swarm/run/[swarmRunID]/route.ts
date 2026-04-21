// GET /api/swarm/run/:swarmRunID — returns the run's meta.json.
//
// Used by the browser to resolve a swarm-run URL back to its workspace +
// component sessionIDs after a page reload. The event stream also includes
// this in its opening `swarm.run.attached` frame, but a dedicated GET lets
// callers hydrate synchronously without waiting for the first SSE frame
// to arrive.

import type { NextRequest } from 'next/server';

import { getRun } from '@/lib/server/swarm-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: { swarmRunID: string } }
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }
  return Response.json(meta, { status: 200 });
}
