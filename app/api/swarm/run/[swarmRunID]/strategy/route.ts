// Strategy / plan-revisions endpoint — reads the plan_revisions ledger
// for a run. Backs the orchestrator-worker pattern's `strategy` tab
//. Pattern-agnostic:
// any run that's done at least one planner sweep has rows here, but
// the UI only surfaces them for orchestrator-worker today.
//
// GET /api/swarm/run/:swarmRunID/strategy
//   → { revisions: PlanRevision[] }   (newest-first, full deltas)
//
// No POST — plan_revisions is a derived ledger, written by the
// planner sweep itself. To force a fresh sweep, hit
// /api/swarm/run/:id/board/sweep with overwrite=true.

import { getRun } from '@/lib/server/swarm-registry';
import { listPlanRevisions } from '@/lib/server/blackboard/plan-revisions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: { swarmRunID: string } },
): Promise<Response> {
  const meta = await getRun(params.swarmRunID);
  if (!meta) {
    return Response.json({ error: 'swarm run not found' }, { status: 404 });
  }
  const revisions = listPlanRevisions(params.swarmRunID);
  return Response.json({ revisions });
}
