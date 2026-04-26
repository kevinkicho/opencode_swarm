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

// HARDENING_PLAN.md#R6 — validate the request body's shape before
// trusting fields. Pre-fix: `(await req.json()) as RecallRequest`
// trusted the cast and accessed body.swarmRunID/sessionID/workspace
// directly. A malformed body (e.g., swarmRunID=42) would propagate
// the bad value into recall() and surface as an opaque 500.
function parseRecallBody(
  raw: unknown,
): { ok: true; body: RecallRequest } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const r = raw as Record<string, unknown>;
  for (const k of ['swarmRunID', 'sessionID', 'workspace'] as const) {
    if (k in r && r[k] !== undefined && typeof r[k] !== 'string') {
      return { ok: false, error: `${k} must be a string when present` };
    }
  }
  if ('shape' in r && r.shape !== undefined) {
    const valid = ['summary', 'parts', 'diffs'];
    if (typeof r.shape !== 'string' || !valid.includes(r.shape)) {
      return { ok: false, error: `shape must be one of ${valid.join('|')}` };
    }
  }
  if ('limit' in r && r.limit !== undefined && typeof r.limit !== 'number') {
    return { ok: false, error: 'limit must be a number when present' };
  }
  if ('filter' in r && r.filter !== undefined) {
    if (typeof r.filter !== 'object' || r.filter === null) {
      return { ok: false, error: 'filter must be an object' };
    }
  }
  return { ok: true, body: r as unknown as RecallRequest };
}

export async function POST(req: NextRequest): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const parsed = parseRecallBody(raw);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const body = parsed.body;

  // Guardrail: if the caller doesn't scope the query to a run, session, or
  // workspace, they're asking for "everything across the whole ledger". At
  // prototype scale that's fine (SQLite will chew through it), but forcing
  // the caller to make an explicit choice catches malformed agent plans.
  if (!body.swarmRunID && !body.sessionID && !body.workspace) {
    return Response.json(
      {
        error: 'query too broad',
        detail: 'set at least one of swarmRunID, sessionID, workspace',
      },
      { status: 400 }
    );
  }

  try {
    const response = recall(body);
    return Response.json(response);
  } catch (err) {
    return Response.json(
      { error: 'recall failed', detail: (err as Error).message },
      { status: 500 }
    );
  }
}
