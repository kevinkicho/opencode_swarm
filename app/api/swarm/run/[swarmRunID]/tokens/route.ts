// Per-session + aggregate token / cost view for one swarm run.
//
// GET /api/swarm/run/:swarmRunID/tokens
//   → {
//       swarmRunID,
//       pattern,
//       totals:   { tokens, cost, status, lastActivityTs },
//       sessions: [{ sessionID, role?, tokens, cost, status, lastActivityTs }]
//     }
//
// Motivation: during the 2026-04-23 overnight run we had no way to answer
// "did we hit the expected token threshold?" without either (a) eyeballing
// the cost-dashboard UI or (b) re-implementing the fan-out in a debug
// script. Both flows already existed in spirit — `deriveRunRow` already
// aggregates per-session tokens — but nothing exposed the per-session grain
// over HTTP. See memory/reference_opencode_freeze.md for how this gap bit.
//
// Why a dedicated endpoint vs. extending `/api/swarm/run/:id`:
//   - Meta is a cold read (fs → JSON). Tokens is a hot-ish read (opencode
//     fetch × sessionIDs). Collapsing them would force every meta caller to
//     pay the tokens round-trip or force the route to return partial data.
//   - The cost-dashboard UI already consumes `deriveRunRow` via a different
//     list endpoint; this route is for per-run drill-downs that the list
//     view can't satisfy.
//
// Role-name resolution reuses `roleNamesBySessionID` so the single-source
// pattern→role map in lib/blackboard/roles.ts stays authoritative — the
// endpoint doesn't re-encode which pattern pins which role.

import type { NextRequest } from 'next/server';

import { getRun, deriveRunTokens } from '@/lib/server/swarm-registry';
import { roleNamesBySessionID } from '@/lib/blackboard/roles';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  { params }: { params: { swarmRunID: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }

  const breakdown = await deriveRunTokens(meta, req.signal);
  const roles = roleNamesBySessionID(meta);

  return Response.json(
    {
      swarmRunID: params.swarmRunID,
      pattern: meta.pattern,
      totals: breakdown.totals,
      sessions: breakdown.sessions.map((s) => ({
        ...s,
        role: roles.get(s.sessionID),
      })),
    },
    { status: 200 },
  );
}
