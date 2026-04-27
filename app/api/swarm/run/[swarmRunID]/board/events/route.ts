// GET /api/swarm/run/:swarmRunID/board/events — SSE stream of board mutations.
//
// Replaces the 2s poll on /board for the board rail + board-preview page.
// Per-connection lifecycle:
//   1. `board.snapshot` — initial frame with the full current item list
//   2. N × `board.item.inserted` / `board.item.updated` as the store mutates
//   3. heartbeats every 30s so proxies / load balancers don't drop the socket
//
// Fan-in: listeners subscribe to the process-local `blackboard/bus`; the
// store emits after every successful insert / transition. Runs with no
// board activity still get a stable stream (handshake + heartbeats) so
// the client can tell "nothing happening" from "connection dropped".

import type { NextRequest } from 'next/server';

import { getRun } from '@/lib/server/swarm-registry';
import { listBoardItems } from '@/lib/server/blackboard/store';
import { subscribeBoardEvents, type BoardEvent } from '@/lib/server/blackboard/bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HEARTBEAT_INTERVAL_MS = 30_000;

export async function GET(
  req: NextRequest,
  { params }: { params: { swarmRunID: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }

  const swarmRunID = params.swarmRunID;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      const emit = (type: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type, ...(data as object) })}\n\n`),
          );
        } catch {
          // enqueue throws once the stream is closed — flag and stop so
          // subsequent listener fires don't loop the same error.
          closed = true;
        }
      };

      // Initial snapshot so the client can render immediately without a
      // separate GET /board round-trip. Subsequent updates are delta-only.
      emit('board.snapshot', { items: listBoardItems(swarmRunID) });

      const unsubscribe = subscribeBoardEvents(swarmRunID, (event: BoardEvent) => {
        switch (event.type) {
          case 'item.inserted':
            emit('board.item.inserted', { item: event.item });
            return;
          case 'item.updated':
            emit('board.item.updated', { item: event.item });
            return;
          case 'ticker.tick':
            emit('board.ticker.tick', { snapshot: event.snapshot });
            return;
          case 'strategy.update':
            emit('board.strategy.update', { revision: event.revision });
            return;
        }
      });

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_INTERVAL_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch {}
      };

      req.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
