// PATCH /api/swarm/run/:swarmRunID/board/items/:itemId
//
// Update a board item's content. The only mutable field is `content`;
// status transitions must go through the coordinator's transitionStatus()
// (CAS-guarded, emits SSE events). Content edits are user-initiated
// corrections (typo fixes, scope adjustments) that don't change the
// item's lifecycle state — so a simple unconditional UPDATE is fine.

import type { NextRequest } from 'next/server';

import { getRun } from '@/lib/server/swarm-registry';
import { getBoardItem, updateBoardItemContent } from '@/lib/server/blackboard/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PATCH(
  req: NextRequest,
  { params }: { params: { swarmRunID: string; itemId: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }

  let body: { content?: unknown };
  try {
    body = await req.json() as { content?: unknown };
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (typeof body.content !== 'string' || !body.content.trim()) {
    return Response.json({ error: 'content must be a non-empty string' }, { status: 400 });
  }

  const existing = getBoardItem(params.swarmRunID, params.itemId);
  if (!existing) {
    return Response.json({ error: 'board item not found' }, { status: 404 });
  }

  const updated = updateBoardItemContent(params.swarmRunID, params.itemId, body.content);
  if (!updated) {
    return Response.json({ error: 'update failed' }, { status: 500 });
  }

  return Response.json(updated, { status: 200 });
}