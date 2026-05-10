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
// its outputs.
//
// Concurrency model (post 2026-05-07 parallelism fix):
//   - Per-session mutex when opts.restrictToSessionID is set (auto-ticker
//     always sets this). Different sessions run in PARALLEL — two workers
//     can claim different todos and execute their LLM turns simultaneously.
//     CAS at the SQL layer protects against two sessions racing on the same
//     todo (the loser gets `skipped: claim lost race`).
//   - Per-run mutex when restrictToSessionID is NOT set (manual debug ticks,
//     map-reduce synthesis). These unrestricted calls serialize per run so
//     the "first idle session wins" picker stays coherent.
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
import { FileLockSet } from './file-locks';
import { assertItemStatus, recordStateViolation } from './state-assert';

//
// Concurrency model: the auto-ticker fans out per-session ticks via
// `void tickSession(s, sessionID)` in tick.ts. Each session gets its
// own inFlight guard. Sessions should be able to run in PARALLEL —
// two workers can claim different todos and execute their LLM turns
// simultaneously. CAS at the SQL layer protects against two sessions
// racing on the same todo (the loser gets `skipped: claim lost race`).
//
// The pre-fix mutex serialized ALL sessions per run, which meant
// workers took turns instead of working in parallel — wasting ~60% of
// wall-clock time on idle waits. The post-fix uses TWO mutex levels:
//
//   - Per-session: when opts.restrictToSessionID is set (auto-ticker
//     always sets this), the mutex key includes the session ID so
//     different sessions can dispatch concurrently.
//   - Per-run: when opts.restrictToSessionID is NOT set (manual debug
//     ticks, map-reduce synthesis), the mutex key is the run ID so
//     these unrestricted calls still serialize per run.
//
// globalThis-keyed so HMR doesn't reset the mutex map mid-flight (same
// pattern as criticLocks/verifierLocks/auditLocks per D2).
const DISPATCH_MUTEX_KEY = Symbol.for('opencode_swarm.dispatchMutex.v2');
function dispatchMutexMap(): Map<string, Promise<unknown>> {
  const g = globalThis as { [DISPATCH_MUTEX_KEY]?: Map<string, Promise<unknown>> };
  const slot = g[DISPATCH_MUTEX_KEY];
  if (slot instanceof Map) return slot;
  const next = new Map<string, Promise<unknown>>();
  g[DISPATCH_MUTEX_KEY] = next;
  return next;
}

// Mutex key: per-session when restrictToSessionID is set (parallelism),
// per-run when not (serial safety for unrestricted callers like map-reduce).
function mutexKey(swarmRunID: string, opts: TickOpts): string {
  if (opts.restrictToSessionID) {
    return `${swarmRunID}::${opts.restrictToSessionID}`;
  }
  return swarmRunID;
}

async function withDispatchMutex<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const locks = dispatchMutexMap();
  const prior = locks.get(key) ?? Promise.resolve();
  // Chain via then(fn, fn) so a prior rejection doesn't poison the chain
  // — each tick runs after the prior settles regardless of outcome.
  const next = prior.then(fn, fn) as Promise<T>;
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) {
      locks.delete(key);
    }
  }
}

// Public entry point — serializes per-session (when restricted) or per-run
// (when unrestricted). The mutex boundary ensures no two unrestricted
// calls race on the same run, while per-session calls run in parallel.
export async function tickCoordinator(
  swarmRunID: string,
  opts: TickOpts = {},
): Promise<TickOutcome> {
  const key = mutexKey(swarmRunID, opts);
  return withDispatchMutex(key, () =>
    tickCoordinatorImpl(swarmRunID, opts),
  );
}

async function tickCoordinatorImpl(
  swarmRunID: string,
  opts: TickOpts,
): Promise<TickOutcome> {
  const pick = await pickClaim(swarmRunID, opts);
  if (pick.kind === 'skip') return pick.outcome;

  // State-machine hardening: verify item is in-progress after successful claim.
  const claimed = assertItemStatus(swarmRunID, pick.context.todo.id, 'in-progress');
  if (!claimed.ok) {
    recordStateViolation(swarmRunID, pick.context.todo.id, 'in-progress', claimed.status, 'post-claim');
    // Continue fail-open — the item may have moved but dispatch may still work
  }

  const dispatch = await dispatchPrompt(pick.context, opts);
  if (dispatch.kind === 'fail') return dispatch.outcome;

  // Verify item still in-progress before waiting for turn.
  const preWait = assertItemStatus(swarmRunID, dispatch.context.todo.id, 'in-progress');
  if (!preWait.ok) {
    recordStateViolation(swarmRunID, dispatch.context.todo.id, 'in-progress', preWait.status, 'pre-wait');
  }

  const wait = await awaitTurn(dispatch.context);
  if (wait.kind === 'fail') return wait.outcome;

  const gates = await runGateChecks(wait.context);
  if (gates.kind === 'fail') {
    FileLockSet.release(swarmRunID, wait.context.todo.id);
    return gates.outcome;
  }

  // Verify item still in-progress before committing to done.
  const preCommit = assertItemStatus(swarmRunID, gates.context.todo.id, 'in-progress');
  if (!preCommit.ok) {
    recordStateViolation(swarmRunID, gates.context.todo.id, 'in-progress', preCommit.status, 'pre-commit');
  }

  return await commitDone(gates.context);
}
