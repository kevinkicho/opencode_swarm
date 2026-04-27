// Board auto-ticker control + observation.
//
// GET  /api/swarm/run/:swarmRunID/board/ticker   — current ticker snapshot
//   returns 200 with a TickerSnapshot, or 200 with { state: 'none' } if no
//   ticker has ever run for this id (vs. stopped, which returns snapshot
//   with stopped:true). Distinguishing lets the UI show "never started"
//   separately from "auto-stopped — restart?".
//
// POST /api/swarm/run/:swarmRunID/board/ticker
//   body: { action: 'start' | 'stop' }
//   204 on success. Start is idempotent — hitting it on a running ticker
//   resets the idle counter but doesn't restart the timer. Stop with
//   reason='manual' survives in the map so the UI can show "last stop:
//   manual 3m ago".

import type { NextRequest } from 'next/server';

import { getRun } from '@/lib/server/swarm-registry';
// state-only `getTickerSnapshot` directly from the leaf module so the
// 5s-polled GET handler doesn't transitively pull tick.ts → coordinator
// → planner. start/stop only run on POST and are dynamic-imported there.
import { getTickerSnapshot } from '@/lib/server/blackboard/auto-ticker/state';
import type { TickerSnapshot } from '@/lib/server/blackboard/auto-ticker/types';
import type { BoardTickerPostBody } from '@/lib/api-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type GetResponse =
  | { state: 'none' }
  | ({ state: 'active' | 'stopped' } & TickerSnapshot);

export async function GET(
  _req: NextRequest,
  { params }: { params: { swarmRunID: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }
  const snap = getTickerSnapshot(params.swarmRunID);
  const body: GetResponse = snap
    ? { state: snap.stopped ? 'stopped' : 'active', ...snap }
    : { state: 'none' };
  return Response.json(body, { status: 200 });
}

// BoardTickerPostBody. Field comments live with the canonical type.
type PostBody = BoardTickerPostBody;

export async function POST(
  req: NextRequest,
  { params }: { params: { swarmRunID: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }
  if (meta.pattern !== 'blackboard') {
    return Response.json(
      { error: `ticker applies to blackboard runs only (got pattern='${meta.pattern}')` },
      { status: 400 },
    );
  }

  let body: PostBody = {};
  try {
    const raw = await req.text();
    if (raw.trim()) body = JSON.parse(raw) as PostBody;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (body.action === 'start') {
    // Parse optional periodicSweepMinutes → ms. Guard non-negative finite;
    // anything else falls back to 0 (default short-run shape).
    let periodicSweepMs = 0;
    if (
      typeof body.periodicSweepMinutes === 'number' &&
      Number.isFinite(body.periodicSweepMinutes) &&
      body.periodicSweepMinutes > 0
    ) {
      periodicSweepMs = Math.round(body.periodicSweepMinutes * 60_000);
    }
    // E6 — dynamic import keeps start/stop's tick.ts → coordinator chain
    // out of the GET handler's compile graph.
    const { startAutoTicker } = await import(
      '@/lib/server/blackboard/auto-ticker'
    );
    startAutoTicker(params.swarmRunID, { periodicSweepMs });
  } else if (body.action === 'stop') {
    const { stopAutoTicker } = await import(
      '@/lib/server/blackboard/auto-ticker'
    );
    stopAutoTicker(params.swarmRunID, 'manual');
  } else {
    return Response.json(
      { error: "action must be 'start' or 'stop'" },
      { status: 400 },
    );
  }

  const snap = getTickerSnapshot(params.swarmRunID);
  return Response.json(
    snap
      ? { state: snap.stopped ? 'stopped' : 'active', ...snap }
      : { state: 'none' },
    { status: 200 },
  );
}
