// POST /api/swarm/recall — the memory query surface.
//
// Body shape: RecallRequest (see lib/server/memory/types.ts). Three response
// shapes:
//   shape='summary' — one card per session/retro; cheapest, default.
//   shape='parts'   — per-part snippets; use when you need the exact thing
//                     an agent said / did.
//   shape='diffs'   — parts filtered to part_type='patch'; diff expansion is
//                     a follow-up.
//
// Agents call this to hydrate context before writing new plans. The UI can
// also call it for a "related runs" sidebar — same endpoint, different shape.
//
// Not authenticated. Personal-use deployment; see project_deployment_scope.

import type { NextRequest } from 'next/server';

import { recall } from '@/lib/server/memory/query';
import type { RecallRequest } from '@/lib/server/memory/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<Response> {
  let body: RecallRequest;
  try {
    body = (await req.json()) as RecallRequest;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  // Guardrail: if the caller doesn't scope the query to a run, session, or
  // workspace, they're asking for "everything across the whole ledger". At
  // prototype scale that's fine (SQLite will chew through it), but forcing
  // the caller to make an explicit choice catches malformed agent plans.
  if (!body.swarmRunID && !body.sessionID && !body.workspace) {
    return Response.json(
      {
        error: 'query too broad',
        message: 'set at least one of swarmRunID, sessionID, workspace',
      },
      { status: 400 }
    );
  }

  try {
    const response = recall(body);
    return Response.json(response);
  } catch (err) {
    return Response.json(
      { error: 'recall failed', message: (err as Error).message },
      { status: 500 }
    );
  }
}
