// POST /api/swarm/run/:swarmRunID/nudge — send a mid-run message to
// one or all sessions in a running swarm.
//
// Body shape:
//   { message: string, sessionID?: string }
//     message    — the text to post (prepended with a [nudge] prefix)
//     sessionID  — target session; omit to broadcast to all sessions
//
// The nudge is fire-and-forget — the message is posted via
// postSessionMessageServer and no wait-for-idle happens. The
// operator can use this to redirect, correct, or encourage agents
// mid-run without stopping the swarm.
//
// Not authenticated — personal-use deployment.

import type { NextRequest } from 'next/server';

import { getRun } from '@/lib/server/swarm-registry';
import { postSessionMessageServer } from '@/lib/server/opencode-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NUDGE_PREFIX = '[nudge] ';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ swarmRunID: string }> },
): Promise<Response> {
  const { swarmRunID } = await params;
  let body: { message?: string; sessionID?: string } = {};
  try {
    const raw = await req.text();
    if (raw.trim()) body = JSON.parse(raw) as typeof body;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { message, sessionID } = body;
  if (!message || typeof message !== 'string') {
    return Response.json({ error: 'message is required' }, { status: 400 });
  }

  const text = NUDGE_PREFIX + message;

  const meta = await getRun(swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }

  const targets = sessionID
    ? meta.sessionIDs.includes(sessionID)
      ? [sessionID]
      : []
    : meta.sessionIDs;

  if (targets.length === 0) {
    return Response.json({ error: 'no matching sessions' }, { status: 404 });
  }

  const results = await Promise.allSettled(
    targets.map((sid) =>
      postSessionMessageServer(sid, meta.workspace, text),
    ),
  );

  const sent = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.length - sent;

  return Response.json({ sent, failed, targets: targets.length });
}