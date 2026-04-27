// HARDENING_PLAN.md#C4 — tickCoordinator decomposition phase 3.
//
// awaitTurn — block until the worker's assistant turn completes, then
// classify the outcome:
//   - ok=true: extract editedPaths from patch parts and continue
//   - ok=false: classify the failure (timeout / silent / errored /
//     provider-unavailable / tool-loop), enrich the error string for
//     'errored' by re-fetching the session, abort the turn on timeout
//     to stop the runaway-token leak, route through retryOrStale.
//
// On timeout the abort is fire-and-forget — the next post will wait
// for the server to accept it regardless. On 'errored' opencode
// already surfaced terminal state. On 'silent' the F1 watchdog inside
// waitForSessionIdle already aborted.

import 'server-only';

import {
  abortSessionServer,
  getSessionMessagesServer,
} from '../../../opencode-server';
import { extractLatestErrorText } from '../message-helpers';
import {
  extractEditedPaths,
  relativizeToWorkspace,
} from '../path-utils';
import { retryOrStale } from '../retry';
import { waitForSessionIdle } from '../wait';
import type { TickOutcome } from '../types';
import type { AwaitedContext, DispatchedContext } from './_context';

export type AwaitResult =
  | { kind: 'fail'; outcome: TickOutcome }
  | { kind: 'ok'; context: AwaitedContext };

export async function awaitTurn(
  dispatched: DispatchedContext,
): Promise<AwaitResult> {
  const { meta, sessionID, todo, knownIDs, deadline, timeoutMs } = dispatched;

  const waited = await waitForSessionIdle(
    sessionID,
    meta.workspace,
    knownIDs,
    deadline,
  );

  if (!waited.ok) {
    let reason =
      waited.reason === 'timeout'
        ? 'turn timed out'
        : waited.reason === 'silent'
          ? 'turn went silent'
          : waited.reason === 'provider-unavailable'
            ? 'provider-unavailable'
            : waited.reason === 'tool-loop'
              ? 'tool-loop'
              : 'turn errored';

    // #96 — for the generic 'error' branch, re-fetch the session and
    // extract the actual provider-level error string so the stale-note
    // (and the operator-visible board) carries something more useful
    // than 'turn errored'.
    if (waited.reason === 'error') {
      try {
        const after = await getSessionMessagesServer(sessionID, meta.workspace);
        const errorText = extractLatestErrorText(after, knownIDs);
        if (errorText) {
          reason = `turn errored: ${errorText.slice(0, 160)}`;
        }
      } catch {
        // Best-effort enrichment — fall through with the generic reason.
      }
    }

    // On timeout, abort the opencode turn eagerly so it doesn't keep
    // consuming tokens for up to ZOMBIE_TURN_THRESHOLD_MS (10 min)
    // before the picker catches it on its next pass. 'errored' skips
    // the abort — opencode already surfaced a terminal signal. 'silent'
    // already aborted inside waitForSessionIdle (F1 watchdog).
    if (waited.reason === 'timeout') {
      console.log(
        `[coordinator] session ${sessionID.slice(-8)}: worker timeout after ${Math.round(timeoutMs / 60_000)}m on ${todo.id} — aborting turn`,
      );
      abortSessionServer(sessionID, meta.workspace).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[coordinator] session ${sessionID.slice(-8)}: timeout-abort failed:`,
          message,
        );
      });
    }
    const outcome = retryOrStale(meta.swarmRunID, todo, reason);
    return {
      kind: 'fail',
      outcome: {
        status: 'stale',
        sessionID,
        itemID: todo.id,
        reason: `${outcome}: ${reason}`,
      },
    };
  }

  const rawEditedPaths = extractEditedPaths(waited.messages, waited.newIDs);
  const editedPaths = rawEditedPaths.map((p) =>
    relativizeToWorkspace(meta.workspace, p),
  );

  return {
    kind: 'ok',
    context: {
      ...dispatched,
      messages: waited.messages,
      newIDs: waited.newIDs,
      editedPaths,
    },
  };
}
