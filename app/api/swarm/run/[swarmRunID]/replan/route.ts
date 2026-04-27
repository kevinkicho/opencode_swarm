//
// POST /api/swarm/run/:swarmRunID/replan
//   body: {} (or omitted)
//   response: 202 + { queued: true, swarmRunID }
//
// Triggers a fresh planner sweep in the background. Distinct from
// /board/sweep:
//   - Sweep is synchronous (caller awaits the assistant turn). Suited
//     to the initial-sweep on run creation when the page is blocking
//     on the first batch of todos.
//   - Replan is asynchronous (returns immediately). Suited to a
//     human operator spotting the orchestrator drifting and wanting
//     to nudge a re-plan without holding a UI request open for 5+
//     minutes.
//
// Pre-sets `overwrite: true` + `includeBoardContext: true` because
// any human-triggered replan against an existing run wants the
// fresh prompt to see what's already been done. No timeout override
// — uses the planner's DEFAULT_TIMEOUT_MS which is sized for
// ollama-cloud's worst-case latency.
//
// Pattern-agnostic: works on any pattern that uses the blackboard's
// planner sweep (blackboard, orchestrator-worker, role-differentiated,
// deliberate-execute's execution phase). The strategy tab on the
// orchestrator-worker pattern is the primary consumer; other
// patterns can hit this endpoint too if/when they grow a re-plan UI.

import type { NextRequest } from 'next/server';

import { getRun } from '@/lib/server/swarm-registry';
import { runPlannerSweep } from '@/lib/server/blackboard/planner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  _req: NextRequest,
  { params }: { params: { swarmRunID: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }

  // Fire-and-forget. The caller gets 202 immediately; the sweep
  // continues in the Node event loop. Errors are logged server-
  // side — there's no client to surface them to once we've
  // returned. The strategy tab will see the new revision row
  // (or a no-op row, on planner returning empty) on its next
  // 5s poll cycle.
  void runPlannerSweep(params.swarmRunID, {
    overwrite: true,
    includeBoardContext: true,
  }).catch((err) => {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
      `[replan] run ${params.swarmRunID}: background sweep failed: ${detail}`,
    );
  });

  return Response.json(
    { queued: true, swarmRunID: params.swarmRunID },
    { status: 202 },
  );
}
