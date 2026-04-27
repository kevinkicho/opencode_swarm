//
// dispatchPrompt — post the worker's todo prompt to opencode. Snapshots
// the message-ID set immediately before the post so awaitTurn can diff
// "new since dispatch" without races against other concurrent activity
// in the same session (rare but real on the auto-ticker fan-out).
//
// Pattern-aware agent + model routing: hierarchical patterns route via
// opencode agent-config; team-model pinning overrides the agent route
// when the user explicitly chose a per-session model.

import 'server-only';

import {
  getSessionMessagesServer,
  postSessionMessageServer,
} from '../../../opencode-server';
import { opencodeAgentForSession } from '../../../../blackboard/roles';
import { buildWorkPrompt } from '../message-helpers';
import { retryOrStale } from '../retry';
import { turnTimeoutFor } from '../timeouts';
import type { TickOpts, TickOutcome } from '../types';
import type { ClaimContext, DispatchedContext } from './_context';

export type DispatchResult =
  | { kind: 'fail'; outcome: TickOutcome }
  | { kind: 'ok'; context: DispatchedContext };

export async function dispatchPrompt(
  claim: ClaimContext,
  opts: TickOpts,
): Promise<DispatchResult> {
  const { meta, sessionID, todo } = claim;

  // Snapshot existing messages so awaitTurn can diff "new since work-prompt".
  const before = await getSessionMessagesServer(sessionID, meta.workspace);
  const knownIDs = new Set(before.map((m) => m.info.id));

  const prompt = buildWorkPrompt(todo);

  // Pattern-aware opencode agent-config routing for the worker's prompt.
  // Hierarchical patterns (orchestrator-worker, role-differentiated,
  // debate-judge, critic-loop) map session → role → opencode agent-config
  // name from opencode.json. Blackboard's planner/worker labels are
  // display-only — opencodeAgentForSession returns undefined for it.
  const dispatchAgent = opencodeAgentForSession(meta, sessionID);

  // Team-model pinning: per-session model from the new-run-modal team
  // picker. Overrides the agent route when both are set (intended
  // precedence for role-differentiated runs).
  // run's pinned `synthesisModel` regardless of which session claims.
  const sessionIdx = meta.sessionIDs.indexOf(sessionID);
  const pinnedModel =
    todo.kind === 'synthesize' && meta.synthesisModel
      ? meta.synthesisModel
      : sessionIdx >= 0
        ? meta.teamModels?.[sessionIdx]
        : undefined;

  try {
    await postSessionMessageServer(sessionID, meta.workspace, prompt, {
      agent: dispatchAgent,
      model: pinnedModel,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outcome = retryOrStale(
      meta.swarmRunID,
      todo,
      `prompt-send failed: ${message.slice(0, 160)}`,
    );
    return {
      kind: 'fail',
      outcome: {
        status: 'stale',
        sessionID,
        itemID: todo.id,
        reason: `${outcome}: ${message}`,
      },
    };
  }

  const timeoutMs = opts.timeoutMs ?? turnTimeoutFor(meta.pattern);
  const deadline = Date.now() + timeoutMs;

  return {
    kind: 'ok',
    context: { ...claim, knownIDs, deadline, timeoutMs },
  };
}
