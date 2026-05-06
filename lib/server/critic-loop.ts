// Critic-loop pattern — hierarchical pattern #4.
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

import 'server-only';

import { postSessionMessageServer } from './opencode-server';
import { waitForSessionIdle } from './blackboard/coordinator';
import { buildLessonsBlock } from './lesson-inject';
import { withRunGuard } from './run-guard';
import { checkWallClockExpired } from './swarm-bounds';
import { recordPartialOutcome } from './degraded-completion';
import { extractLatestAssistantText, snapshotKnownIDs } from './harvest-drafts';
import {
  buildWorkerIntroPrompt,
  buildCriticIntroPrompt,
  buildReviewPrompt,
  buildRevisionPrompt,
  classifyCriticReply,
} from './critic-loop/parsers';
import type { ParsedVerdict, VerdictScope } from './critic-loop/parsers';

export { classifyCriticReply } from './critic-loop/parsers';
export type { ParsedVerdict, VerdictScope } from './critic-loop/parsers';

const WORKER_AGENT_NAME = 'worker';
const CRITIC_AGENT_NAME = 'critic';

// Per-iteration wait ceiling for either side's assistant turn. 15 min
// is generous for substantive work — critic usually replies faster
// (~1-2 min) but the worker's first draft or a deep revision can run
// 5-10 min.
// pattern-tunables.ts.
import { THRESHOLDS, TIMINGS } from './pattern-tunables';
const ITERATION_WAIT_MS = TIMINGS.critic.iterationWaitMs;

// Maximum iterations when the request body doesn't specify. 3 rounds
// (initial draft + 2 revisions) is enough to surface most critic
// feedback without looping on perfection-seeking.
const DEFAULT_MAX_ITERATIONS = 3;



export async function runCriticLoopKickoff(
  swarmRunID: string,
  opts: { maxIterations?: number } = {},
): Promise<void> {
  await withRunGuard(
    swarmRunID,
    { expectedPattern: 'critic-loop', context: 'critic-loop' },
    async (meta) => {
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
  // Session index mapping for teamModels lookup: workerSID = [0],
  // criticSID = [1]. Applies to every dispatch in the loop.
  const workerModel = meta.teamModels?.[0];
  const criticModel = meta.teamModels?.[1];

  // I4 — kickoff WARN if worker and critic share a model. The whole
  // point of the critic loop is independent perspective; same model
  // tends to approve too eagerly because the failure modes overlap.
  // Don't block the run — the user might be testing intentionally —
  // but make the risk visible in the dev console.
  if (workerModel && criticModel && workerModel === criticModel) {
    console.warn(
      `[critic-loop] run ${swarmRunID}: worker and critic share model '${workerModel}' — feedback quality may regress toward self-approval`,
    );
  }

  try {
    // // 2026-04-25 fix: dropped `agent: CRITIC_AGENT_NAME / WORKER_AGENT_NAME`
    // — custom agent names that aren't in the user's opencode.json (the
    // built-ins are build/compaction/explore/general/plan/summary/title)
    // cause opencode's prompt_async to return HTTP 204 success but never
    // persist the user message or start an assistant turn. Same root
    // cause as the picker-dispatch fix in lib/blackboard/roles.ts. Role
    // display in our UI continues working via roleNamesBySessionID.
    const lessons = await buildLessonsBlock(meta.workspace);
    const criticPrompt = buildCriticIntroPrompt(meta.directive);
    const workerPrompt = buildWorkerIntroPrompt(meta.directive);
    await postSessionMessageServer(
      criticSID,
      meta.workspace,
      lessons ? lessons + '\n\n' + criticPrompt : criticPrompt,
      { model: criticModel },
    );
    await postSessionMessageServer(
      workerSID,
      meta.workspace,
      lessons ? lessons + '\n\n' + workerPrompt : workerPrompt,
      { model: workerModel },
    );
  } catch (err) {
    console.warn(
      `[critic-loop] run ${swarmRunID}: initial intro post failed:`,
      err instanceof Error ? err.message : String(err),
    );
    recordPartialOutcome(swarmRunID, {
      pattern: 'critic-loop',
      phase: 'intro-post',
      reason: err instanceof Error ? err.message.slice(0, 80) : 'unknown',
      summary: 'Critic-loop aborted before any iteration ran — initial intro posts to worker/critic sessions failed.',
    });
    return;
  }
  console.log(`[critic-loop] run ${swarmRunID}: worker + critic intros posted`);

  const knownAll = await snapshotKnownIDs(meta, '[critic-loop]');
  const knownWorkerIDs = knownAll.get(workerSID) ?? new Set<string>();
  const knownCriticIDs = knownAll.get(criticSID) ?? new Set<string>();

  // loop. Track the last few verdicts; if iterations N-1 and N are
  // both REVISE + WORDING + confidence ≤ 3, the critic is fixating
  // on phrasing rather than substance — ship the current draft and
  // stop. Spec calls for a 2-iteration look-back; we keep history
  // longer for log clarity.
  const verdictHistory: ParsedVerdict[] = [];
  const NITPICK_CONF_MAX = THRESHOLDS.critic.nitpickConfMax;
  function isNitpickStreak(): boolean {
    if (verdictHistory.length < 2) return false;
    const last2 = verdictHistory.slice(-2);
    return last2.every(
      (v) =>
        v.verdict === 'revise' &&
        v.scope === 'WORDING' &&
        v.confidence > 0 &&
        v.confidence <= NITPICK_CONF_MAX,
    );
  }

  // #73 — track latest worker draft so a partial-outcome record can
  // capture what survived if the loop aborts mid-iteration. Updated at
  // the end of each successful worker wait.
  let latestDraft: string | null = null;
  function buildPartialSummary(iter: number): string {
    const parts: string[] = [];
    parts.push(`Critic-loop aborted at iteration ${iter}/${maxIterations}.`);
    parts.push(`Verdicts so far: ${verdictHistory.length}`);
    if (verdictHistory.length > 0) {
      parts.push('');
      parts.push('Verdict history:');
      verdictHistory.forEach((v, i) => {
        parts.push(`  ${i + 1}. ${v.verdict.toUpperCase()}${v.scope ? ` (${v.scope})` : ''}${v.confidence ? ` confidence=${v.confidence}` : ''}`);
      });
    }
    if (latestDraft) {
      parts.push('');
      parts.push('Latest worker draft:');
      parts.push(latestDraft);
    }
    return parts.join('\n');
  }

  // Main loop.
  for (let iter = 1; iter <= maxIterations; iter += 1) {
    // Wall-clock cap (#85). Stops new iterations from launching once
    // bounds.minutesCap is exceeded. The current draft (last completed
    // worker turn) stays in opencode regardless.
    if (checkWallClockExpired(swarmRunID, meta, `iter ${iter}/${maxIterations}`, buildPartialSummary(iter))) {
      return;
    }
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
      recordPartialOutcome(swarmRunID, {
        pattern: 'critic-loop',
        phase: `iter ${iter}/${maxIterations} worker-wait`,
        reason: workerWait.reason,
        summary: buildPartialSummary(iter),
      });
      return;
    }
    // Refresh known IDs to include the new worker turn.
    for (const m of workerWait.messages) knownWorkerIDs.add(m.info.id);
    const draft = extractLatestAssistantText(workerWait.messages);
    if (!draft) {
      console.warn(
        `[critic-loop] run ${swarmRunID} iter ${iter}: worker produced no text — aborting loop`,
      );
      recordPartialOutcome(swarmRunID, {
        pattern: 'critic-loop',
        phase: `iter ${iter}/${maxIterations} worker-no-text`,
        reason: 'no-text',
        summary: buildPartialSummary(iter),
      });
      return;
    }
    latestDraft = draft;

    // 2. Send draft to critic for review.
    try {
      await postSessionMessageServer(
        criticSID,
        meta.workspace,
        buildReviewPrompt(draft, iter),
        { model: criticModel },
      );
    } catch (err) {
      console.warn(
        `[critic-loop] run ${swarmRunID} iter ${iter}: review-post failed:`,
        err instanceof Error ? err.message : String(err),
      );
      recordPartialOutcome(swarmRunID, {
        pattern: 'critic-loop',
        phase: `iter ${iter}/${maxIterations} review-post`,
        reason: err instanceof Error ? err.message.slice(0, 80) : 'unknown',
        summary: buildPartialSummary(iter),
      });
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
      recordPartialOutcome(swarmRunID, {
        pattern: 'critic-loop',
        phase: `iter ${iter}/${maxIterations} critic-wait`,
        reason: criticWait.reason,
        summary: buildPartialSummary(iter),
      });
      return;
    }
    for (const m of criticWait.messages) knownCriticIDs.add(m.info.id);
    const criticReply = extractLatestAssistantText(criticWait.messages);
    if (!criticReply) {
      console.warn(
        `[critic-loop] run ${swarmRunID} iter ${iter}: critic produced no text — aborting loop`,
      );
      recordPartialOutcome(swarmRunID, {
        pattern: 'critic-loop',
        phase: `iter ${iter}/${maxIterations} critic-no-text`,
        reason: 'no-text',
        summary: buildPartialSummary(iter),
      });
      return;
    }

    const classified = classifyCriticReply(criticReply);
    verdictHistory.push(classified);

    if (classified.verdict === 'approved') {
      console.log(
        `[critic-loop] run ${swarmRunID} iter ${iter}: APPROVED — "${classified.body.slice(0, 80)}" (confidence=${classified.confidence || '?'})`,
      );
      return;
    }

    // I2 — nitpick-loop auto-terminate. Triggers from iter ≥ 2 once
    // we have a two-iteration window of WORDING+low-confidence REVISE.
    if (iter >= 2 && isNitpickStreak()) {
      console.log(
        `[critic-loop] run ${swarmRunID} iter ${iter}: auto-terminating — nitpick streak (last 2 = REVISE+WORDING+confidence≤${NITPICK_CONF_MAX}). Shipping draft N=${iter}`,
      );
      const dissentText = classified.issues.length > 0
        ? `Nitpick-override: ${classified.issues.join('; ')}`
        : 'Nitpick-override: critic stuck on WORDING revisions with low confidence';
      const { writeDissentLesson } = await import('./memory/memory-store');
      await writeDissentLesson(
        meta.workspace,
        swarmRunID,
        'critic-loop',
        dissentText,
      ).catch(() => {});
      try {
        await postSessionMessageServer(
          workerSID,
          meta.workspace,
          `Critic-loop terminated by orchestrator: the last two reviews were low-confidence WORDING revisions, indicating the critic is rewording rather than improving substance. Shipping your draft from this iteration as final.`,
          { model: workerModel },
        );
      } catch {
        // Non-fatal; the loop's already terminating.
      }
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
          { model: workerModel },
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
        { model: workerModel },
      );
    } catch (err) {
      console.warn(
        `[critic-loop] run ${swarmRunID} iter ${iter}: revision-post to worker failed:`,
        err instanceof Error ? err.message : String(err),
      );
      recordPartialOutcome(swarmRunID, {
        pattern: 'critic-loop',
        phase: `iter ${iter}/${maxIterations} revision-post`,
        reason: err instanceof Error ? err.message.slice(0, 80) : 'unknown',
        summary: buildPartialSummary(iter),
      });
      return;
    }
    console.log(
      `[critic-loop] run ${swarmRunID} iter ${iter}: REVISE → worker ("${classified.body.slice(0, 80)}")`,
    );
  }
    },
  );
}
