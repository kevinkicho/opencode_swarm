// HARDENING_PLAN.md#R1 — pattern-kickoff sync-throw guard.
//
// The 201-zombie bug class: every per-pattern kickoff in app/api/swarm/run/
// route.ts fires fire-and-forget with `.catch((err) => console.warn(...))`.
// If the kickoff throws on its first await — bad model name, opencode
// unreachable, planner-prompt build error — the user gets a "run created"
// 201 response and the run sits in the registry as a zombie forever.
//
// This guard races the kickoff against a short deadline. If it settles
// (rejects) inside that window, we treat it as a real synchronous failure
// and the route returns 5xx instead of 201. If it's still pending after
// the deadline, the orchestrator owns its own outcome from there — we
// attach a tail console.warn so late failures still leave a trace.

import 'server-only';

export type KickoffSyncResult =
  | { kind: 'pending' } // kickoff is still running after the deadline; treat as success
  | { kind: 'completed' } // kickoff finished within the deadline (rare but possible)
  | { kind: 'rejected'; error: Error }; // kickoff rejected within the deadline

const DEFAULT_SYNC_DEADLINE_MS = 150;

export async function raceKickoffSync(
  kickoff: Promise<unknown>,
  deadlineMs: number = DEFAULT_SYNC_DEADLINE_MS,
): Promise<KickoffSyncResult> {
  const settled: Promise<KickoffSyncResult> = kickoff.then(
    () => ({ kind: 'completed' as const }),
    (err) => ({
      kind: 'rejected' as const,
      error: err instanceof Error ? err : new Error(String(err)),
    }),
  );
  const timer: Promise<KickoffSyncResult> = new Promise((resolve) => {
    setTimeout(() => resolve({ kind: 'pending' }), deadlineMs);
  });
  return Promise.race([settled, timer]);
}

// Attach a tail catch on a kickoff promise that survived the sync window.
// The orchestrator owns its own outcome from here, but a late failure
// should still leave a forensic trace in the dev log.
export function attachLateFailureLog(
  kickoff: Promise<unknown>,
  patternLabel: string,
  swarmRunID: string,
): void {
  kickoff.catch((err) => {
    console.warn(
      `[swarm/run] ${patternLabel} kickoff for ${swarmRunID} failed (post-sync):`,
      err instanceof Error ? err.message : String(err),
    );
  });
}
