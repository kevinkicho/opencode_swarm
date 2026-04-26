// POST /api/swarm/run/:swarmRunID/stop
//
// Hard-stop a swarm run (#105). Soft `abort` (in components/swarm-topbar.tsx)
// only kills the primary session — N-1 worker / critic / verifier / auditor
// sessions keep tokenating, and the orchestrator coroutine keeps waiting.
// This endpoint tears down the whole run in one shot:
//
//   1. Stop the auto-ticker if one is running (handles its own abort
//      cascade + per-session abort + run-end audit + persisted snapshot).
//   2. For runs WITHOUT a ticker (council, debate-judge, critic-loop,
//      map-reduce phase 1), abort every session in meta.sessionIDs +
//      critic/verifier/auditor explicitly.
//   3. Record a partial-outcome finding ("operator hard-stop") so the
//      board carries durable evidence of the action.
//
// Tradeoff: in-flight tool calls land as-is — no rollback. That's the
// alternative to "stuck forever," which is what soft-abort leaves you
// with on a multi-session run.

import type { NextRequest } from 'next/server';

import { getRun } from '@/lib/server/swarm-registry';
import { abortSessionServer } from '@/lib/server/opencode-server';
import {
  getTickerSnapshot,
  stopAutoTicker,
} from '@/lib/server/blackboard/auto-ticker';
import { recordPartialOutcome } from '@/lib/server/degraded-completion';
import type { StopResponse } from '@/lib/api-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// HARDENING_PLAN.md#C5 — `StopResponse` lifted to lib/api-types.ts.

export async function POST(
  _req: NextRequest,
  { params }: { params: { swarmRunID: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }

  // Build the abort target list once; used both for the explicit-abort
  // path (no ticker) and for the response payload.
  const targets = [
    ...meta.sessionIDs,
    ...(meta.criticSessionID ? [meta.criticSessionID] : []),
    ...(meta.verifierSessionID ? [meta.verifierSessionID] : []),
    ...(meta.auditorSessionID ? [meta.auditorSessionID] : []),
  ];

  // Path 1: ticker-bearing pattern. stopAutoTicker is the single source
  // of truth for these — it serializes through its own state machine
  // (timer clear, snapshot persist, run-end audit, session abort), so
  // duplicating any of those steps below would race against it.
  const snap = getTickerSnapshot(params.swarmRunID);
  const tickerActive = snap !== null && !snap.stopped;
  if (tickerActive) {
    stopAutoTicker(params.swarmRunID, 'operator-hard-stop');
  } else {
    // Path 2: no active ticker. Abort sessions ourselves.
    // fire-and-forget per-session: opencode aborts are idempotent and
    // we don't want one slow / dead session to delay the others. The
    // catch-undefined keeps Promise.allSettled returning quickly even
    // when the underlying request errors.
    await Promise.allSettled(
      targets.map((sid) =>
        abortSessionServer(sid, meta.workspace).catch(() => undefined),
      ),
    );
  }

  // Record durable evidence of the operator action so the board shows
  // why the run stopped. recordPartialOutcome is best-effort (writes
  // a finding row); a failure to write doesn't undo the abort.
  try {
    recordPartialOutcome(params.swarmRunID, {
      pattern: meta.pattern,
      phase: 'operator-hard-stop',
      reason: 'operator-hard-stop',
      summary: [
        'Operator force-stopped this run via the run-anchor force-stop button.',
        '',
        `Sessions aborted: ${targets.length} (${meta.sessionIDs.length} workers${
          meta.criticSessionID ? ' + critic' : ''
        }${meta.verifierSessionID ? ' + verifier' : ''}${
          meta.auditorSessionID ? ' + auditor' : ''
        })`,
        tickerActive
          ? 'Auto-ticker stopped via stopAutoTicker.'
          : 'No active auto-ticker; sessions aborted directly.',
        '',
        'In-flight tool calls landed as-is — no rollback. Workspace state may include partial edits from any worker that was mid-edit at stop time.',
      ].join('\n'),
    });
  } catch (err) {
    console.warn(
      `[swarm/run/stop] partial-outcome record failed for ${params.swarmRunID}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  const body: StopResponse = {
    ok: true,
    swarmRunID: params.swarmRunID,
    sessionsAborted: targets.length,
    tickerStopped: tickerActive,
  };
  return Response.json(body, { status: 200 });
}
