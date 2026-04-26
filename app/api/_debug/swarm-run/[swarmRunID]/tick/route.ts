// Coordinator tick endpoint — one round of "pick an open todo + idle
// session, claim it, send work, finalize". Step 3b/3c of SWARM_PATTERNS.md §1.
//
// POST /api/_debug/swarm-run/:swarmRunID/tick
//   body: { timeoutMs?: number }
//
// Synchronous — the response returns after the assistant turn finishes or
// the timeout fires. The auto-ticker drives progress in production runs;
// this route is for smoke-scripts/curl ops debugging only.
//
// HARDENING_PLAN.md#C9 / FU.5 — moved from /api/swarm/run/[id]/board/tick
// to /api/_debug/swarm-run/[id]/tick 2026-04-26 because this is an
// ops-only endpoint, not used from the UI. Path matches the sweep
// endpoint's _debug-namespace move.
//
// Single caller assumption: two concurrent POSTs to this route for the
// same run would both see the same 'open' todo, one would win the CAS and
// the other would skip with 'claim lost race'. That's fine for serialized
// drivers; don't build a parallel fan-out against this route without
// revisiting the tick's idempotency story.

import type { NextRequest } from 'next/server';

import { getRun } from '@/lib/server/swarm-registry';
import { tickCoordinator } from '@/lib/server/blackboard/coordinator';
import type { BoardTickBody } from '@/lib/api-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

// HARDENING_PLAN.md#C5 — `TickBody` lifted to lib/api-types.ts as
// BoardTickBody.
type TickBody = BoardTickBody;

export async function POST(
  req: NextRequest,
  { params }: { params: { swarmRunID: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }

  let body: TickBody = {};
  try {
    const raw = await req.text();
    if (raw.trim()) body = JSON.parse(raw) as TickBody;
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

  try {
    const outcome = await tickCoordinator(params.swarmRunID, { timeoutMs });
    // 200 for every completed tick — even 'skipped' and 'stale' are known
    // outcomes the caller reasons about, not server failures.
    return Response.json(outcome, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: 'tick failed', detail: message },
      { status: 500 },
    );
  }
}
