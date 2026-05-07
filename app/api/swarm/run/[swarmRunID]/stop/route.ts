// POST /api/swarm/run/:swarmRunID/stop
//
// Stop a swarm run (operator-initiated). Used by both AbortChip (soft
// abort) and HardStopChip (force-stop). The `?reason=abort|hard-stop`
// query parameter controls the ticker stop reason and partial-outcome
// wording. Both paths tear down the whole run:
//
//   1. Stop the auto-ticker if one is running (handles its own abort
//      cascade + per-session abort + run-end audit + persisted snapshot).
//   2. For runs WITHOUT a ticker (council, debate-judge, critic-loop,
//      map-reduce phase 1), abort every session in meta.sessionIDs +
//      critic/verifier/auditor explicitly.
//   3. Record a partial-outcome finding so the board carries durable
//      evidence of the action.
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


export async function POST(
  req: NextRequest,
  { params }: { params: { swarmRunID: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }

  // reason: 'abort' (from AbortChip) or 'hard-stop' (from HardStopChip).
  // Controls ticker stop reason and partial-outcome wording.
  const urlReason = req.nextUrl.searchParams.get('reason');
  const isAbort = urlReason === 'abort';
  const stopReason = isAbort ? 'operator-abort' : 'operator-hard-stop';
  const humanLabel = isAbort ? 'aborted' : 'force-stopped';

  // Build the abort target list once; used both for the explicit-abort
  // path (no ticker) and for the response payload.
  const targets = [
    ...meta.sessionIDs,
    ...(meta.criticSessionID ? [meta.criticSessionID] : []),
    ...(meta.verifierSessionID ? [meta.verifierSessionID] : []),
    ...(meta.auditorSessionID ? [meta.auditorSessionID] : []),
  ];

  // Path 1: ticker-bearing pattern. stopAutoTicker handles its own
  // session abort cascade internally (fire-and-forget), but the
  // aborts are async and may not land before we respond. We still
  // attempt direct aborts below for safety — duplicate aborts are
  // idempotent (opencode treats abort-on-already-stopped as a no-op),
  // so there's no race condition.
  const snap = getTickerSnapshot(params.swarmRunID);
  const tickerActive = snap !== null && !snap.stopped;
  if (tickerActive) {
    stopAutoTicker(params.swarmRunID, stopReason);
  }

  // Always attempt direct session aborts regardless of ticker state.
  // For ticker-backed runs this is a safety net in case stopAutoTicker's
  // fire-and-forget abort hasn't landed yet. For non-ticker runs
  // (council, debate-judge, etc.) this is the primary abort path.
  await Promise.allSettled(
    targets.map((sid) =>
      abortSessionServer(sid, meta.workspace).catch(() => undefined),
    ),
  );

  // Record durable evidence of the operator action so the board shows
  // why the run stopped. recordPartialOutcome is best-effort (writes
  // a finding row); a failure to write doesn't undo the abort.
  try {
    recordPartialOutcome(params.swarmRunID, {
      pattern: meta.pattern,
      phase: stopReason,
      reason: stopReason,
      summary: [
        `Operator ${humanLabel} this run via the ${isAbort ? 'abort' : 'force-stop'} button.`,
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
