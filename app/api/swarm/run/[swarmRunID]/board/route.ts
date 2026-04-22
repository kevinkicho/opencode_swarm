// Board API — list + post.
//
// GET  /api/swarm/run/:swarmRunID/board           list every board item (newest-first)
// POST /api/swarm/run/:swarmRunID/board           create a todo / question / claim / finding
//
// The board is storage-only at this layer. The coordinator loop (still
// unwritten — SWARM_PATTERNS.md "Backend gap" step 3) is what decides which
// session claims what; this route just accepts writes. pattern='blackboard'
// gating lives in /api/swarm/run POST — the board endpoint itself doesn't
// reject other-pattern runs because there's no harm in storing rows nobody
// reads, and it keeps the route shape uniform for testing.

import type { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';

import { getRun } from '@/lib/server/swarm-registry';
import {
  insertBoardItem,
  listBoardItems,
} from '@/lib/server/blackboard/store';
import type {
  BoardItem,
  BoardItemKind,
  BoardItemStatus,
} from '@/lib/blackboard/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KINDS: ReadonlySet<BoardItemKind> = new Set([
  'claim',
  'question',
  'todo',
  'finding',
]);

const STATUSES: ReadonlySet<BoardItemStatus> = new Set([
  'open',
  'claimed',
  'in-progress',
  'done',
  'stale',
  'blocked',
]);

// Kind-specific defaults for `status` when the caller omits it. Mirrors the
// claim/question/todo/finding semantics from SWARM_PATTERNS.md §1:
//   * todo / question land on the board unclaimed (open)
//   * claim arrives with an owner already and skips to claimed
//   * finding is immutable completed output — lands as done
function defaultStatusFor(kind: BoardItemKind): BoardItemStatus {
  switch (kind) {
    case 'finding':
      return 'done';
    case 'claim':
      return 'claimed';
    default:
      return 'open';
  }
}

// Minimal item-id generator. 8 hex chars gives ~4B distinct IDs per run —
// plenty for a single run even under adversarial planner churn. Caller-
// supplied IDs win when provided so the UI can cross-reference board rows
// to planner-sweep-generated names like `t_001`.
function mintItemId(): string {
  return 't_' + randomBytes(4).toString('hex');
}

interface PostBody {
  id?: string;
  kind?: string;
  content?: string;
  status?: string;
  ownerAgentId?: string;
  note?: string;
  fileHashes?: Array<{ path?: unknown; sha?: unknown }>;
}

function parsePost(raw: unknown): Omit<BoardItem, 'createdAtMs' | 'completedAtMs' | 'staleSinceSha'> | string {
  if (!raw || typeof raw !== 'object') return 'body must be a JSON object';
  const b = raw as PostBody;

  if (typeof b.kind !== 'string' || !KINDS.has(b.kind as BoardItemKind)) {
    return `kind must be one of: ${[...KINDS].join(', ')}`;
  }
  const kind = b.kind as BoardItemKind;

  if (typeof b.content !== 'string' || !b.content.trim()) {
    return 'content is required';
  }

  let status: BoardItemStatus = defaultStatusFor(kind);
  if (b.status !== undefined) {
    if (typeof b.status !== 'string' || !STATUSES.has(b.status as BoardItemStatus)) {
      return `status must be one of: ${[...STATUSES].join(', ')}`;
    }
    status = b.status as BoardItemStatus;
  }

  // A claim must name its owner + snapshot SHAs; without them the CAS
  // commit has nothing to validate against. Enforce here so the invariant
  // lives at the boundary, not deep in the coordinator.
  if (kind === 'claim') {
    if (!b.ownerAgentId || typeof b.ownerAgentId !== 'string') {
      return 'kind=claim requires ownerAgentId';
    }
    if (!Array.isArray(b.fileHashes) || b.fileHashes.length === 0) {
      return 'kind=claim requires non-empty fileHashes';
    }
  }

  let fileHashes: BoardItem['fileHashes'] | undefined;
  if (b.fileHashes !== undefined) {
    if (!Array.isArray(b.fileHashes)) return 'fileHashes must be an array';
    const validated: { path: string; sha: string }[] = [];
    for (const entry of b.fileHashes) {
      if (!entry || typeof entry !== 'object') return 'fileHashes entries must be objects';
      if (typeof entry.path !== 'string' || !entry.path) return 'fileHashes[*].path must be a non-empty string';
      if (typeof entry.sha !== 'string' || !entry.sha) return 'fileHashes[*].sha must be a non-empty string';
      validated.push({ path: entry.path, sha: entry.sha });
    }
    fileHashes = validated;
  }

  const out: Omit<BoardItem, 'createdAtMs' | 'completedAtMs' | 'staleSinceSha'> = {
    id: typeof b.id === 'string' && b.id.trim() ? b.id.trim() : mintItemId(),
    kind,
    status,
    content: b.content,
  };
  if (typeof b.ownerAgentId === 'string' && b.ownerAgentId) out.ownerAgentId = b.ownerAgentId;
  if (typeof b.note === 'string' && b.note) out.note = b.note;
  if (fileHashes) out.fileHashes = fileHashes;
  return out;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { swarmRunID: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }
  const items = listBoardItems(params.swarmRunID);
  return Response.json({ items }, { status: 200 });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { swarmRunID: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = parsePost(body);
  if (typeof parsed === 'string') {
    return Response.json({ error: parsed }, { status: 400 });
  }

  try {
    const item = insertBoardItem(params.swarmRunID, parsed);
    return Response.json({ item }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Likely a unique-constraint violation on (swarm_run_id, id). Surface
    // as 409 so the coordinator can retry with a fresh id.
    if (message.includes('UNIQUE') || message.includes('constraint')) {
      return Response.json(
        { error: 'board item id conflict', detail: message },
        { status: 409 },
      );
    }
    return Response.json(
      { error: 'board write failed', detail: message },
      { status: 500 },
    );
  }
}
