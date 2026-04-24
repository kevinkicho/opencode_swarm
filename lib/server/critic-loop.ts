// Critic-loop pattern — hierarchical pattern #4 (see SWARM_PATTERNS.md §8).
//
// Shape: exactly 2 sessions. Session 0 = worker, session 1 = critic.
// Worker produces a draft, critic reviews, worker revises. Loop
// continues until the critic approves (signals with "APPROVED:"
// keyword) or the max-iterations cap fires.
//
// Approval signaling: the critic's intro establishes a contract. Any
// reply whose first line starts with "APPROVED" (case-insensitive)
// ends the loop with the worker's current draft accepted. Any reply
// starting with "REVISE" is forwarded to the worker as revision
// feedback. Anything else gets a gentle nudge back to the critic
// asking for a decisive verdict.
//
// Termination:
//   - critic approves (→ done, draft accepted)
//   - max iterations hit (→ done, current draft shipped with "budget
//     exhausted" note in the transcript)
//   - worker errors / per-turn timeout (→ done, escalate to human)

import { getSessionMessagesServer, postSessionMessageServer } from './opencode-server';
import { waitForSessionIdle } from './blackboard/coordinator';
import { finalizeRun } from './finalize-run';
import { getRun } from './swarm-registry';
import type { OpencodeMessage } from '../opencode/types';

const WORKER_AGENT_NAME = 'worker';
const CRITIC_AGENT_NAME = 'critic';

// Per-iteration wait ceiling for either side's assistant turn. 15 min
// is generous for substantive work — critic usually replies faster
// (~1-2 min) but the worker's first draft or a deep revision can run
// 5-10 min.
const ITERATION_WAIT_MS = 15 * 60 * 1000;

// Maximum iterations when the request body doesn't specify. 3 rounds
// (initial draft + 2 revisions) is enough to surface most critic
// feedback without looping on perfection-seeking.
const DEFAULT_MAX_ITERATIONS = 3;

function extractLatestAssistantText(messages: OpencodeMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.info.role !== 'assistant') continue;
    if (!m.info.time.completed) continue;
    const texts = m.parts.filter(
      (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text',
    );
    if (texts.length === 0) continue;
    return texts[texts.length - 1].text;
  }
  return null;
}

function buildWorkerIntroPrompt(directive: string | undefined): string {
  const base =
    directive?.trim() || 'Achieve the mission implied by the project README.';
  return [
    'You are the **worker** in a critic loop.',
    '',
    `Your task: ${base}`,
    '',
    'Produce your first draft now. Be concrete and implement actual',
    'changes in the codebase if the task asks for them. After your draft,',
    'a critic will review your work and either approve it or send back',
    'revisions. Expect up to 3 review rounds total.',
  ].join('\n');
}

function buildCriticIntroPrompt(directive: string | undefined): string {
  const base =
    directive?.trim() || 'The worker is implementing the project README mission.';
  return [
    'You are the **critic** in a critic loop.',
    '',
    `Context — the worker has been asked to: ${base}`,
    '',
    'Sit tight until the worker produces a draft. You will receive the',
    'draft and your job is to review it rigorously. When you review,',
    'reply in exactly one of these shapes:',
    '',
    '  APPROVED: <one-line reason>',
    '  REVISE: <specific, actionable feedback for the worker>',
    '',
    'Start your reply with one of those two keywords (case-insensitive).',
    'Your verdict determines whether the loop ends or the worker revises.',
    '',
    "Be exacting — your approval is load-bearing. If the worker's draft",
    'has gaps, say so concretely. If it meets the bar, approve and move on.',
  ].join('\n');
}

function buildReviewPrompt(draft: string, iteration: number): string {
  return [
    `## Round ${iteration}: review the worker's draft below`,
    '',
    '---',
    '',
    draft.trim(),
    '',
    '---',
    '',
    'Reply now. Start with "APPROVED:" or "REVISE:" per your contract.',
  ].join('\n');
}

function buildRevisionPrompt(
  feedback: string,
  iteration: number,
  maxIterations: number,
): string {
  return [
    `## Round ${iteration} of ${maxIterations}: critic asked for revisions`,
    '',
    'Critic feedback:',
    '',
    feedback.trim(),
    '',
    'Revise your draft to address the feedback. Implement changes on disk',
    'as appropriate, then reply with your updated draft.',
  ].join('\n');
}

// Classify a critic reply: 'approved' ends the loop, 'revise' feeds
// back to worker, 'unclear' nudges the critic for a decisive call.
function classifyCriticReply(
  text: string,
): { verdict: 'approved' | 'revise' | 'unclear'; body: string } {
  const first = text.split('\n', 1)[0]?.trim() ?? '';
  if (/^approved\b/i.test(first)) return { verdict: 'approved', body: first };
  if (/^revise\b/i.test(first)) {
    // Strip the "REVISE:" prefix from the body that goes to the worker.
    const stripped = text.replace(/^\s*revise[:\s]*/i, '').trim();
    return { verdict: 'revise', body: stripped };
  }
  return { verdict: 'unclear', body: text.trim() };
}

export async function runCriticLoopKickoff(
  swarmRunID: string,
  opts: { maxIterations?: number } = {},
): Promise<void> {
  try {
  const meta = await getRun(swarmRunID);
  if (!meta) {
    console.warn(
      `[critic-loop] run ${swarmRunID} not found — kickoff aborted`,
    );
    return;
  }
  if (meta.pattern !== 'critic-loop') {
    console.warn(
      `[critic-loop] run ${swarmRunID} has pattern '${meta.pattern}', not critic-loop — kickoff aborted`,
    );
    return;
  }
  if (meta.sessionIDs.length !== 2) {
    console.warn(
      `[critic-loop] run ${swarmRunID} requires exactly 2 sessions (got ${meta.sessionIDs.length}) — kickoff aborted`,
    );
    return;
  }

  const maxIterations =
    opts.maxIterations ??
    meta.criticMaxIterations ??
    DEFAULT_MAX_ITERATIONS;
  const [workerSID, criticSID] = meta.sessionIDs;

  // Prime the critic with its contract first (before it sees any draft),
  // then kick off the worker with the task. Both use agent={role} so the
  // roster shows distinct identities.
  try {
    await postSessionMessageServer(
      criticSID,
      meta.workspace,
      buildCriticIntroPrompt(meta.directive),
      { agent: CRITIC_AGENT_NAME },
    );
    await postSessionMessageServer(
      workerSID,
      meta.workspace,
      buildWorkerIntroPrompt(meta.directive),
      { agent: WORKER_AGENT_NAME },
    );
  } catch (err) {
    console.warn(
      `[critic-loop] run ${swarmRunID}: initial intro post failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  console.log(`[critic-loop] run ${swarmRunID}: worker + critic intros posted`);

  // Track known message IDs per session so waitForSessionIdle harvests
  // only NEW turns each iteration. Initialize after the intro posts.
  const knownWorkerIDs = new Set(
    (await getSessionMessagesServer(workerSID, meta.workspace).catch(() => []))
      .map((m) => m.info.id),
  );
  const knownCriticIDs = new Set(
    (await getSessionMessagesServer(criticSID, meta.workspace).catch(() => []))
      .map((m) => m.info.id),
  );

  // Main loop.
  for (let iter = 1; iter <= maxIterations; iter += 1) {
    // 1. Wait for the worker's draft.
    const workerDeadline = Date.now() + ITERATION_WAIT_MS;
    const workerWait = await waitForSessionIdle(
      workerSID,
      meta.workspace,
      knownWorkerIDs,
      workerDeadline,
    );
    if (!workerWait.ok) {
      console.warn(
        `[critic-loop] run ${swarmRunID} iter ${iter}: worker wait failed (${workerWait.reason}) — aborting loop`,
      );
      return;
    }
    // Refresh known IDs to include the new worker turn.
    for (const m of workerWait.messages) knownWorkerIDs.add(m.info.id);
    const draft = extractLatestAssistantText(workerWait.messages);
    if (!draft) {
      console.warn(
        `[critic-loop] run ${swarmRunID} iter ${iter}: worker produced no text — aborting loop`,
      );
      return;
    }

    // 2. Send draft to critic for review.
    try {
      await postSessionMessageServer(
        criticSID,
        meta.workspace,
        buildReviewPrompt(draft, iter),
        { agent: CRITIC_AGENT_NAME },
      );
    } catch (err) {
      console.warn(
        `[critic-loop] run ${swarmRunID} iter ${iter}: review-post failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    // 3. Wait for critic's verdict.
    const criticDeadline = Date.now() + ITERATION_WAIT_MS;
    const criticWait = await waitForSessionIdle(
      criticSID,
      meta.workspace,
      knownCriticIDs,
      criticDeadline,
    );
    if (!criticWait.ok) {
      console.warn(
        `[critic-loop] run ${swarmRunID} iter ${iter}: critic wait failed (${criticWait.reason}) — aborting loop`,
      );
      return;
    }
    for (const m of criticWait.messages) knownCriticIDs.add(m.info.id);
    const criticReply = extractLatestAssistantText(criticWait.messages);
    if (!criticReply) {
      console.warn(
        `[critic-loop] run ${swarmRunID} iter ${iter}: critic produced no text — aborting loop`,
      );
      return;
    }

    const classified = classifyCriticReply(criticReply);
    if (classified.verdict === 'approved') {
      console.log(
        `[critic-loop] run ${swarmRunID} iter ${iter}: APPROVED — "${classified.body.slice(0, 80)}"`,
      );
      return;
    }

    if (iter >= maxIterations) {
      // Out of iterations. Notify the worker so the run's transcript
      // carries the "budget exhausted" signal — humans reviewing the
      // output know why the loop stopped.
      try {
        await postSessionMessageServer(
          workerSID,
          meta.workspace,
          `Critic-loop budget exhausted after ${maxIterations} iterations. Shipping your current draft as-is. Critic's final feedback was: ${classified.body}`,
          { agent: WORKER_AGENT_NAME },
        );
      } catch {
        // Non-fatal; just log.
      }
      console.log(
        `[critic-loop] run ${swarmRunID}: max iterations ${maxIterations} reached — shipping current draft`,
      );
      return;
    }

    // 4. Classification was 'revise' or 'unclear'. Either way, forward
    // feedback to the worker and continue the loop. For 'unclear', we
    // treat the reply as feedback — this is a graceful fallback rather
    // than an extra round-trip nudging the critic to decide.
    try {
      await postSessionMessageServer(
        workerSID,
        meta.workspace,
        buildRevisionPrompt(classified.body, iter + 1, maxIterations),
        { agent: WORKER_AGENT_NAME },
      );
    } catch (err) {
      console.warn(
        `[critic-loop] run ${swarmRunID} iter ${iter}: revision-post to worker failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    console.log(
      `[critic-loop] run ${swarmRunID} iter ${iter}: REVISE → worker ("${classified.body.slice(0, 80)}")`,
    );
  }
  } finally {
    await finalizeRun(swarmRunID, 'critic-loop');
  }
}
