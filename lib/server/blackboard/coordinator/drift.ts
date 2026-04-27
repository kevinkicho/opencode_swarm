//
// Fired from the commit-time drift check in dispatch. Schedules a fresh
// planner sweep so a replacement todo lands within seconds of drift,
// rather than waiting for the next periodic sweep cadence.
//
// Throttle: read the run's plan_revisions ledger; skip the call if a
// sweep landed in the last CAS_REPLAN_MIN_INTERVAL_MS window. Several
// concurrent workers hitting drift on adjacent files all schedule a
// replan but only the first one gets through; the rest no-op.
//
// Dynamic import of './planner' breaks the otherwise-circular dep
// (planner imports waitForSessionIdle from this module's wait.ts).
//
// Extracted from coordinator.ts in #107 phase 5.

import 'server-only';

const CAS_REPLAN_MIN_INTERVAL_MS = 60 * 1000;

export async function scheduleCasDriftReplan(
  swarmRunID: string,
  driftedPaths: string[],
): Promise<void> {
  try {
    const { listPlanRevisions } = await import('../plan-revisions');
    const revisions = listPlanRevisions(swarmRunID);
    const last = revisions[0]; // newest-first
    if (last && Date.now() - last.createdAt < CAS_REPLAN_MIN_INTERVAL_MS) {
      console.log(
        `[coordinator] CAS-drift replan throttled (${swarmRunID}): last sweep ${Math.round((Date.now() - last.createdAt) / 1000)}s ago — skipping`,
      );
      return;
    }
    const { runPlannerSweep } = await import('../planner');
    console.log(
      `[coordinator] CAS-drift replan firing for ${swarmRunID} on ${driftedPaths.length} drifted file(s)`,
    );
    await runPlannerSweep(swarmRunID, {
      overwrite: true,
      includeBoardContext: true,
    });

    // Reopen items tagged as stale due to CAS drift so they can be re-picked.
    const { bulkReopenStaleItems, listBoardItems } = await import('../store');
    const all = listBoardItems(swarmRunID);
    const staleItems = all
      .filter((i) => i.status === 'stale' && i.staleSinceSha)
      .map((i) => i.id);
    if (staleItems.length > 0) {
      const count = bulkReopenStaleItems(swarmRunID, staleItems);
      console.log(`[coordinator] CAS-drift: reopened ${count}/${staleItems.length} stale items`);
    }
  } catch (err) {
    console.warn(
      `[coordinator] CAS-drift replan failed for ${swarmRunID}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
