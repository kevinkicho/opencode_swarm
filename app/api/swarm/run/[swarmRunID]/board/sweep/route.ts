// Planner sweep endpoint — step 3a of SWARM_PATTERNS.md §1.
//
// POST /api/swarm/run/:swarmRunID/board/sweep
//   body: { overwrite?: boolean, timeoutMs?: number }
//
// Triggers one round of todowrite-from-a-session on the run and translates
// each todo into an open board item. Synchronous on the client side — the
// response lands after the assistant turn completes or the timeout fires.
//
// Separate route from /board and /board/:itemId because sweep is a
// coordinator action, not a per-item or per-board CRUD verb. Living under
// /board keeps all coordinator plumbing in one tree.
//
// The route's job is input validation + timeouts + surfacing planner errors
// as HTTP codes. The actual opencode roundtrip happens in
// lib/server/blackboard/planner.ts.

import type { NextRequest } from 'next/server';

import { getRun } from '@/lib/server/swarm-registry';
import { runPlannerSweep } from '@/lib/server/blackboard/planner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Guard against a caller passing a small timeout that races the assistant
// turn, or a huge one that ties up the request for minutes. 5s min gives
// the sweep at least one poll cycle, 5min cap matches opencode's default
// per-turn budget for planner-style prompts.
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 5 * 60_000;

interface SweepBody {
  overwrite?: unknown;
  timeoutMs?: unknown;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { swarmRunID: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }

  let body: SweepBody = {};
  // Sweep takes no required fields; an empty or missing body is valid.
  try {
    const raw = await req.text();
    if (raw.trim()) body = JSON.parse(raw) as SweepBody;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  let timeoutMs: number | undefined;
  if (body.timeoutMs !== undefined) {
    if (typeof body.timeoutMs !== 'number' || !Number.isFinite(body.timeoutMs)) {
      return Response.json({ error: 'timeoutMs must be a number' }, { status: 400 });
    }
    if (body.timeoutMs < MIN_TIMEOUT_MS || body.timeoutMs > MAX_TIMEOUT_MS) {
      return Response.json(
        { error: `timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}` },
        { status: 400 },
      );
    }
    timeoutMs = body.timeoutMs;
  }

  const overwrite = body.overwrite === true;

  try {
    const result = await runPlannerSweep(params.swarmRunID, {
      timeoutMs,
      overwrite,
    });
    return Response.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('already populated')) {
      return Response.json(
        { error: message, hint: 'pass { "overwrite": true } to re-sweep' },
        { status: 409 },
      );
    }
    if (message.includes('timed out')) {
      return Response.json({ error: message }, { status: 504 });
    }
    return Response.json(
      { error: 'sweep failed', detail: message },
      { status: 500 },
    );
  }
}
