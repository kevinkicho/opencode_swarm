// Session cleanup on run end for non-ticker patterns.
//
// Ticker-backed patterns (blackboard / orchestrator-worker /
// role-differentiated / deliberate-execute) already abort their
// sessions via `stopAutoTicker` when the ticker stops (commit 21ee57e
// and the shutdown-hook work). The other four patterns
// (council / map-reduce / debate-judge / critic-loop) orchestrate to
// completion in a single async function and then return — with no
// abort, their sessions may carry a lingering in-flight turn past
// orchestrator end.
//
// `finalizeRun` is the counterpart: a one-shot "abort every session
// on this run" that non-ticker orchestrators call in a try/finally
// wrapping their body. Aborting an idle session is a no-op; aborting
// an in-flight turn cancels it. Safe to call at any point — matches
// the behavior of the ticker's abort-sessions path.

import { getRun } from './swarm-registry';
import { abortSessionServer } from './opencode-server';

export async function finalizeRun(
  swarmRunID: string,
  context = 'finalize',
): Promise<void> {
  const meta = await getRun(swarmRunID).catch(() => null);
  if (!meta) return;
  const targets = [...meta.sessionIDs];
  if (meta.criticSessionID) targets.push(meta.criticSessionID);
  if (meta.verifierSessionID) targets.push(meta.verifierSessionID);
  if (targets.length === 0) return;
  const results = await Promise.allSettled(
    targets.map((sid) =>
      abortSessionServer(sid, meta.workspace).catch(() => undefined),
    ),
  );
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  console.log(
    `[${context}] ${swarmRunID}: finalized — aborted ${ok}/${targets.length} session(s)`,
  );
}
