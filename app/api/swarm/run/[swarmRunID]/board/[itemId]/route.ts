// Board item actions — claim / start / commit / block / unblock.
//
// POST /api/swarm/run/:swarmRunID/board/:itemId    body: { action, ... }
//
// Split from /board (list + create) because action semantics are per-item and
// one of them (commit) needs filesystem I/O that the parent route doesn't.
// The CAS guarantees live in lib/server/blackboard/store.transitionStatus —
// this route's job is to validate input, read files on commit, and map the
// store's {ok, currentStatus} return into HTTP status codes.
//
// URL shape uses action-in-body (RPC style) rather than /action segments
// because it matches the existing POST /board pattern (kind-in-body) and
// avoids proliferating route files per verb.

import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getRun } from '@/lib/server/swarm-registry';
import {
  getBoardItem,
  transitionStatus,
} from '@/lib/server/blackboard/store';
import type { BoardItem, BoardItemStatus } from '@/lib/blackboard/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Action = 'claim' | 'start' | 'commit' | 'block' | 'unblock';

const ACTIONS: ReadonlySet<Action> = new Set([
  'claim',
  'start',
  'commit',
  'block',
  'unblock',
]);

// Git-short (7 char) SHA1 over file contents. Matches the convention
// documented on BoardItem.fileHashes — 7 hex chars is plenty of entropy to
// detect drift within one run's lifetime and keeps rows compact in the UI.
async function sha7(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  return createHash('sha1').update(buf).digest('hex').slice(0, 7);
}

// HARDENING_PLAN.md#R6 — read+parse a request body, returning a tagged
// result instead of throwing. Caller branches on `ok` and emits 400 with
// the human-readable reason, never propagating undefined-shaped data.
async function readJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function parseActionBody(
  raw: unknown,
): { ok: true; body: ActionBody & { action: Action } } | { ok: false; error: string } {
  if (raw === undefined) return { ok: false, error: 'invalid JSON body' };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.action !== 'string' || !ACTIONS.has(r.action as Action)) {
    return {
      ok: false,
      error: `action must be one of: ${[...ACTIONS].join(', ')}`,
    };
  }
  // Optional fields — type-check only when present. Per-action handlers
  // below validate semantic requirements (e.g., claim requires
  // ownerAgentId).
  for (const k of ['ownerAgentId', 'note', 'sessionID', 'workerSessionID'] as const) {
    if (k in r && r[k] !== undefined && typeof r[k] !== 'string') {
      return { ok: false, error: `${k} must be a string when present` };
    }
  }
  return { ok: true, body: r as unknown as ActionBody & { action: Action } };
}

interface ActionBody {
  action?: string;
  ownerAgentId?: string;
  fileHashes?: Array<{ path?: unknown; sha?: unknown }>;
  note?: string;
}

function parseFileHashes(
  raw: unknown,
): { path: string; sha: string }[] | string {
  if (!Array.isArray(raw)) return 'fileHashes must be an array';
  const validated: { path: string; sha: string }[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return 'fileHashes entries must be objects';
    const e = entry as { path?: unknown; sha?: unknown };
    if (typeof e.path !== 'string' || !e.path) return 'fileHashes[*].path required';
    if (typeof e.sha !== 'string' || !e.sha) return 'fileHashes[*].sha required';
    validated.push({ path: e.path, sha: e.sha });
  }
  return validated;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { swarmRunID: string; itemId: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }

  // HARDENING_PLAN.md#R6 — validate shape before trusting fields.
  // Pre-fix: the cast `(await req.json()) as ActionBody` trusted the
  // shape and the per-action handlers below did partial typeof checks.
  // The parseActionBody helper makes the top-level discriminator
  // contract explicit; per-action checks handle the per-action fields.
  const parsed = parseActionBody(await readJson(req));
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const body = parsed.body;
  const action = body.action;

  const item = getBoardItem(params.swarmRunID, params.itemId);
  if (!item) {
    return Response.json({ error: 'board item not found' }, { status: 404 });
  }

  switch (action) {
    case 'claim': {
      if (!body.ownerAgentId || typeof body.ownerAgentId !== 'string') {
        return Response.json(
          { error: 'claim requires ownerAgentId' },
          { status: 400 },
        );
      }
      const hashes = parseFileHashes(body.fileHashes);
      if (typeof hashes === 'string') {
        return Response.json({ error: hashes }, { status: 400 });
      }
      if (hashes.length === 0) {
        return Response.json(
          { error: 'claim requires non-empty fileHashes' },
          { status: 400 },
        );
      }
      const result = transitionStatus(params.swarmRunID, params.itemId, {
        from: 'open',
        to: 'claimed',
        ownerAgentId: body.ownerAgentId,
        fileHashes: hashes,
      });
      return respondToTransition(result);
    }

    case 'start': {
      const result = transitionStatus(params.swarmRunID, params.itemId, {
        from: 'claimed',
        to: 'in-progress',
      });
      return respondToTransition(result);
    }

    case 'commit': {
      // Re-read recorded SHAs from disk to detect drift. I/O happens here,
      // not inside the store, because better-sqlite3 transactions are
      // synchronous — awaiting fs.readFile inside one would deadlock.
      if (!item.fileHashes || item.fileHashes.length === 0) {
        return Response.json(
          { error: 'commit requires recorded fileHashes on the claim' },
          { status: 409 },
        );
      }

      const drift: { path: string; recorded: string; current: string | null }[] = [];
      for (const { path: rel, sha: recorded } of item.fileHashes) {
        const abs = path.resolve(meta.workspace, rel);
        let current: string | null;
        try {
          current = await sha7(abs);
        } catch {
          // ENOENT / perm error = drift from the agent's perspective. Record
          // as null so the client can distinguish "missing" from "changed".
          current = null;
        }
        if (current !== recorded) drift.push({ path: rel, recorded, current });
      }

      if (drift.length > 0) {
        // Mark stale with the first drifted file's current SHA (or '-' when
        // missing). The replanner reads staleSinceSha to decide how to
        // regenerate the todo against the new code state.
        const firstCurrent = drift[0].current ?? '-';
        const result = transitionStatus(params.swarmRunID, params.itemId, {
          from: ['claimed', 'in-progress'],
          to: 'stale',
          staleSinceSha: firstCurrent,
        });
        if (result.ok) {
          return Response.json({ item: result.item, drift }, { status: 200 });
        }
        return respondToTransition(result);
      }

      const result = transitionStatus(params.swarmRunID, params.itemId, {
        from: ['claimed', 'in-progress'],
        to: 'done',
        setCompletedAt: true,
      });
      return respondToTransition(result);
    }

    case 'block': {
      const result = transitionStatus(params.swarmRunID, params.itemId, {
        from: ['claimed', 'in-progress'],
        to: 'blocked',
        note: typeof body.note === 'string' ? body.note : null,
      });
      return respondToTransition(result);
    }

    case 'unblock': {
      const result = transitionStatus(params.swarmRunID, params.itemId, {
        from: 'blocked',
        to: 'in-progress',
      });
      return respondToTransition(result);
    }
  }
}

// Map transitionStatus' {ok, currentStatus} return to HTTP. A CAS loss (wrong
// current status) is 409 — the caller saw stale state and should re-read the
// board before retrying. The shape matches the POST /board route so clients
// get a uniform `{item}` on success.
function respondToTransition(
  result:
    | { ok: true; item: BoardItem }
    | { ok: false; currentStatus: BoardItemStatus | null },
): Response {
  if (result.ok) {
    return Response.json({ item: result.item }, { status: 200 });
  }
  if (result.currentStatus === null) {
    return Response.json({ error: 'board item not found' }, { status: 404 });
  }
  return Response.json(
    { error: 'status transition rejected', currentStatus: result.currentStatus },
    { status: 409 },
  );
}
