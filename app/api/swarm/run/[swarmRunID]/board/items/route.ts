// POST /api/swarm/run/:swarmRunID/board/items
//
// Create a new board item from the UI. Primarily used for posting
// `question` items that block until a human answers, enabling
// human-in-the-loop gates. Other kinds (todo, finding) can also be
// created but should be rare from the UI — the coordinator/planner
// is the canonical author for those.

import type { NextRequest } from 'next/server';

import { getRun } from '@/lib/server/swarm-registry';
import { insertBoardItem } from '@/lib/server/blackboard/store';
import type { BoardItemKind, BoardItemStatus } from '@/lib/blackboard/types';
import { mintItemId } from '@/lib/server/blackboard/item-ids';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VALID_KINDS: BoardItemKind[] = [
  'question', 'todo', 'claim', 'finding', 'synthesize', 'criterion',
];

const DEFAULT_STATUS: Record<BoardItemKind, BoardItemStatus> = {
  question: 'open',
  todo: 'open',
  claim: 'in-progress',
  finding: 'done',
  synthesize: 'in-progress',
  criterion: 'open',
};

export async function POST(
  req: NextRequest,
  { params }: { params: { swarmRunID: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }

  let body: { kind?: unknown; content?: unknown; note?: unknown };
  try {
    body = await req.json() as { kind?: unknown; content?: unknown; note?: unknown };
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const kind = body.kind as string | undefined;
  if (!kind || !VALID_KINDS.includes(kind as BoardItemKind)) {
    return Response.json(
      { error: `kind must be one of: ${VALID_KINDS.join(', ')}` },
      { status: 400 },
    );
  }

  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) {
    return Response.json({ error: 'content must be a non-empty string' }, { status: 400 });
  }

  const status = DEFAULT_STATUS[kind as BoardItemKind];
  const id = mintItemId();
  const note = typeof body.note === 'string' ? body.note : undefined;

  const item = insertBoardItem(params.swarmRunID, {
    id,
    kind: kind as BoardItemKind,
    status,
    content,
    note,
  });

  return Response.json(item, { status: 201 });
}