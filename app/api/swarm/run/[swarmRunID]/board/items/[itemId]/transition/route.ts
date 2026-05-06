// POST /api/swarm/run/:swarmRunID/board/items/:itemId/transition
//
// CAS-guarded status transition for board items. Wraps
// store.transitionStatus() — the coordinator's claim/dispatch/retry
// path uses the same function server-side, so the CAS guarantees are
// identical whether the transition comes from the coordinator loop or
// from a human clicking a button in the UI.

import type { NextRequest } from 'next/server';

import type { BoardItemStatus } from '@/lib/blackboard/types';
import { getRun } from '@/lib/server/swarm-registry';
import { getBoardItem, transitionStatus } from '@/lib/server/blackboard/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: { swarmRunID: string; itemId: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }

  let body: { from?: unknown; to?: unknown; ownerAgentId?: unknown; note?: unknown };
  try {
    body = await req.json() as { from?: unknown; to?: unknown; ownerAgentId?: unknown; note?: unknown };
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { swarmRunID, itemId } = params;

  const existing = getBoardItem(swarmRunID, itemId);
  if (!existing) {
    return Response.json({ error: 'board item not found' }, { status: 404 });
  }

  const validStatuses: BoardItemStatus[] = [
    'open', 'claimed', 'in-progress', 'done', 'stale', 'blocked',
  ];

  const from = body.from;
  const to = body.to;

  if (typeof to !== 'string' || !validStatuses.includes(to as BoardItemStatus)) {
    return Response.json(
      { error: `to must be one of: ${validStatuses.join(', ')}` },
      { status: 400 },
    );
  }

  // `from` can be a single status or an array; coerce to the shape
  // transitionStatus expects.
  let fromStatus: BoardItemStatus | BoardItemStatus[];
  if (Array.isArray(from)) {
    const valid = from.filter((f): f is BoardItemStatus =>
      typeof f === 'string' && validStatuses.includes(f as BoardItemStatus));
    if (valid.length === 0) {
      return Response.json({ error: 'from contains no valid statuses' }, { status: 400 });
    }
    fromStatus = valid;
  } else if (typeof from === 'string' && validStatuses.includes(from as BoardItemStatus)) {
    fromStatus = from as BoardItemStatus;
  } else {
    fromStatus = existing.status;
  }

  const input = {
    from: fromStatus,
    to: to as BoardItemStatus,
    ownerAgentId: typeof body.ownerAgentId === 'string' ? body.ownerAgentId : undefined,
    note: typeof body.note === 'string' ? body.note : undefined,
  };

  const result = transitionStatus(swarmRunID, itemId, input);

  if (!result.ok) {
    return Response.json(
      { ok: false, currentStatus: result.currentStatus },
      { status: 409 },
    );
  }

  return Response.json({ ok: true, item: result.item }, { status: 200 });
}