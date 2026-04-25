// Aggregated swarm-run snapshot — IMPLEMENTATION_PLAN 6.5.
//
// GET /api/swarm/run/:swarmRunID/snapshot
//   → SnapshotResponse
//
// Replaces 5 separate cold-load round-trips (meta + status + tokens +
// board + ticker) with one. Reduces page-load latency observed in
// 2026-04-24 against `run_modm7vsw_uxxy6b` (15s blank + 30s before
// board data). The page used to fan out to /run/:id, /run/:id/tokens,
// /run/:id/board, /run/:id/board/ticker, and a derived-status read
// from the runs list — each subject to opencode's per-session
// message-fetch latency. By collating server-side and parallelizing
// the upstream fetches we cut the waterfall to a single async pause.
//
// Internal parallelization: deriveRunRowCached + deriveRunTokens
// both walk per-session messages via opencode-server. Done in
// `Promise.all` so they overlap rather than serialize. Cache TTL
// (5 min on derived rows) absorbs repeat polls cheaply.
//
// SSE channels still own incremental updates (board.events, etc.).
// This endpoint is the COLD-LOAD seed; subsequent state changes flow
// through SSE as before.

import type { NextRequest } from 'next/server';

import {
  deriveRunRowCached,
  deriveRunTokens,
  getRun,
} from '@/lib/server/swarm-registry';
import { listBoardItems } from '@/lib/server/blackboard/store';
import { getTickerSnapshot } from '@/lib/server/blackboard/auto-ticker';
import { listPlanRevisions } from '@/lib/server/blackboard/plan-revisions';
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

  // Parallelize the two opencode-bound aggregators so their per-session
  // message fetches overlap. The synchronous pulls (board / ticker /
  // plan-revisions) are SQLite reads under 1 ms each.
  const [derivedRow, tokens] = await Promise.all([
    deriveRunRowCached(meta, req.signal),
    deriveRunTokens(meta, req.signal),
  ]);

  const roles = roleNamesBySessionID(meta);

  return Response.json(
    {
      meta,
      // Status equivalent to what the runs picker / topbar shows.
      status: derivedRow.status,
      derivedRow,
      tokens: {
        totals: tokens.totals,
        sessions: tokens.sessions.map((s) => ({
          ...s,
          role: roles.get(s.sessionID),
        })),
      },
      // Full board items list. Cheap (single SQLite query).
      board: { items: listBoardItems(params.swarmRunID) },
      // Ticker state (in-memory or persisted via plan_revisions for
      // post-restart reconstruction). { state: 'none' } when no ticker
      // ever ran for this id.
      ticker: getTickerSnapshot(params.swarmRunID) ?? { state: 'none' as const },
      // Plan revisions count — the strategy tab fetches the full list
      // separately on click, so we just expose the count for cold-load
      // hint ("3 sweeps · last 12m ago").
      planRevisions: { count: listPlanRevisions(params.swarmRunID).length },
    },
    { status: 200 },
  );
}
