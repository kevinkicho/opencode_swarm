// Coordinator tick — steps 3b (idle detection) + 3c (claim + work + commit)
// of .
//
// lib/server/blackboard/coordinator/dispatch/ on 2026-04-26. Pre-split,
// tickCoordinatorImpl was 832 LOC with 14 exit paths. The helpers are
// each independently legible:
//
//   pickClaim → dispatchPrompt → awaitTurn → runGateChecks → commitDone
//
// One tick walks the chain. Each phase either returns an early
// TickOutcome (skipped/stale) or extends the shared ClaimContext with
// its outputs. The dispatch-mutex still wraps the entry point regardless
// of decomp (D9), so concurrent calls within a run still serialize.
//
// Concurrency model: concurrent calls are safe IFF each call targets a
// distinct session via opts.restrictToSessionID. The auto-ticker uses this
// to fan out per-session tickers for parallelism (
// Open questions → Blackboard parallelism). CAS at the SQL layer protects
// against two sessions racing on the same todo (the loser gets `skipped:
// claim lost race`). Calls without restrictToSessionID still use the
// "first idle session wins" picker and should NOT overlap — the map-reduce
// synthesis loop relies on that.
//
// Server-only. Never imported from client code. Extracted from
// coordinator.ts in #107 phase 5.

import 'server-only';

import type { TickOpts, TickOutcome } from './types';

import { pickClaim } from './dispatch/pick-claim';
import { dispatchPrompt } from './dispatch/dispatch-prompt';
import { awaitTurn } from './dispatch/await-turn';
import { runGateChecks } from './dispatch/run-gate-checks';
import { commitDone } from './dispatch/commit-done';

//
// Pre-fix: tickCoordinator had no per-run lock. The auto-ticker fans out
// via restrictToSessionID with a per-session inFlight flag, but a user
// POST to /api/_debug/swarm-run/<id>/tick (with no restriction) could race
// the auto-ticker on the same swarmRunID — both pick the same idle
// session, both call getSessionMessagesServer, both pick the same todo,
// the second loses CAS at transitionStatus. Lossy-but-correct (the SQL
// CAS was the only real protection) but expensive — one full opencode
// read trip wasted per race.
//
// The mutex serializes all entries to tickCoordinator(runID) per run
// regardless of caller. The per-session inFlight flag still exists
// inside fanout() for same-session re-entry within the mutex.
//
// globalThis-keyed so HMR doesn't reset the mutex map mid-flight (same
// pattern as criticLocks/verifierLocks/auditLocks per D2).
const DISPATCH_MUTEX_KEY = Symbol.for('opencode_swarm.dispatchMutexByRun.v1');
function dispatchMutexByRun(): Map<string, Promise<unknown>> {
  const g = globalThis as { [DISPATCH_MUTEX_KEY]?: Map<string, Promise<unknown>> };
  const slot = g[DISPATCH_MUTEX_KEY];
  if (slot instanceof Map) return slot;
  const next = new Map<string, Promise<unknown>>();
  g[DISPATCH_MUTEX_KEY] = next;
  return next;
}

async function withDispatchMutex<T>(
  swarmRunID: string,
  fn: () => Promise<T>,
): Promise<T> {
  const locks = dispatchMutexByRun();
  const prior = locks.get(swarmRunID) ?? Promise.resolve();
  // Chain via then(fn, fn) so a prior rejection doesn't poison the chain
  // — each tick runs after the prior settles regardless of outcome.
  const next = prior.then(fn, fn) as Promise<T>;
  locks.set(swarmRunID, next);
  try {
    return await next;
  } finally {
    if (locks.get(swarmRunID) === next) {
      locks.delete(swarmRunID);
    }
  }
}

// Public entry point — serializes per swarmRunID. Internal logic in
// tickCoordinatorImpl below; keeping the wrapper thin makes the mutex
// boundary obvious for future readers.
export async function tickCoordinator(
  swarmRunID: string,
  opts: TickOpts = {},
): Promise<TickOutcome> {
  return withDispatchMutex(swarmRunID, () =>
    tickCoordinatorImpl(swarmRunID, opts),
  );
}

async function tickCoordinatorImpl(
  swarmRunID: string,
  opts: TickOpts,
): Promise<TickOutcome> {
  const pick = await pickClaim(swarmRunID, opts);
  if (pick.kind === 'skip') return pick.outcome;

  const dispatch = await dispatchPrompt(pick.context, opts);
  if (dispatch.kind === 'fail') return dispatch.outcome;

  const wait = await awaitTurn(dispatch.context);
  if (wait.kind === 'fail') return wait.outcome;

  const gates = await runGateChecks(wait.context);
  if (gates.kind === 'fail') return gates.outcome;

  return commitDone(gates.context);
}
