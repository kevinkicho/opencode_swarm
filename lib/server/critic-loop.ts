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
import { formatWallClockState, isWallClockExpired } from './swarm-bounds';
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
    'reply in EXACTLY this structured shape (PATTERN_DESIGN/critic-loop.md I1):',
    '',
    '  ```yaml',
    '  verdict: APPROVED | REVISE',
    '  confidence: 1-5  # 5 = certain, 1 = guessing',
    '  scope: STRUCTURAL | WORDING | NONE  # NONE only on APPROVED',
    '  issues:',
    '    - <issue 1>',
    '    - <issue 2>',
    '  ```',
    '',
    'Then a single human paragraph explaining the verdict.',
    '',
    'Rules:',
    '- The yaml block is mandatory; replies that lack it will be re-asked.',
    '- `verdict: APPROVED` ends the loop. Use it when the draft meets the bar.',
    '- `verdict: REVISE` plus your issues feeds back to the worker.',
    '- `scope: STRUCTURAL` = the draft is fundamentally wrong / missing chunks.',
    '- `scope: WORDING` = the substance is right; only phrasing / polish remains.',
    '- `confidence: 1-5` — be honest. The orchestrator auto-terminates a loop',
    '  that drags through low-confidence WORDING revisions in successive rounds.',
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

// PATTERN_DESIGN/critic-loop.md I1 — structured verdict contract.
// Parses the YAML-ish block at the top of the critic's reply and
// returns the verdict + confidence + scope + issues. Tolerant of
// minor formatting variation (loose yaml, missing fields default to
// safe values). Falls back to legacy `APPROVED:` / `REVISE:` first-
// line check when no yaml block is present so older critic prompts
// still classify.
type VerdictScope = 'STRUCTURAL' | 'WORDING' | 'NONE';

interface ParsedVerdict {
  verdict: 'approved' | 'revise' | 'unclear';
  confidence: number; // 1-5; 0 = unknown
  scope: VerdictScope;
  issues: string[];
  body: string; // text payload to feed to the worker on REVISE
}

function classifyCriticReply(text: string): ParsedVerdict {
  // Try YAML block extraction first (the I1 structured contract).
  const yamlMatch = text.match(/```ya?ml\s*\n([\s\S]*?)\n\s*```/i);
  if (yamlMatch) {
    const block = yamlMatch[1];
    const verdictRaw = /^\s*verdict:\s*(APPROVED|REVISE)/im.exec(block)?.[1] ?? '';
    const confRaw = /^\s*confidence:\s*([1-5])/im.exec(block)?.[1] ?? '';
    const scopeRaw =
      /^\s*scope:\s*(STRUCTURAL|WORDING|NONE)/im.exec(block)?.[1] ?? 'NONE';
    const issues: string[] = [];
    const issueLines = block.match(/^\s*-\s+.+/gm) ?? [];
    for (const line of issueLines) {
      const cleaned = line.replace(/^\s*-\s+/, '').trim();
      if (cleaned) issues.push(cleaned);
    }
    if (/^APPROVED$/i.test(verdictRaw)) {
      return {
        verdict: 'approved',
        confidence: parseInt(confRaw, 10) || 0,
        scope: 'NONE',
        issues,
        body: text.trim(),
      };
    }
    if (/^REVISE$/i.test(verdictRaw)) {
      // Body fed to worker: yaml's issues + the trailing paragraph.
      const matchEnd = (yamlMatch.index ?? 0) + yamlMatch[0].length;
      const trailing = text.slice(matchEnd).trim();
      const issuesAsText = issues.length > 0 ? issues.map((i) => `- ${i}`).join('\n') : '';
      const body = [issuesAsText, trailing].filter(Boolean).join('\n\n').trim();
      return {
        verdict: 'revise',
        confidence: parseInt(confRaw, 10) || 0,
        scope: (scopeRaw.toUpperCase() as VerdictScope) || 'WORDING',
        issues,
        body: body || text.trim(),
      };
    }
  }

  // Legacy fallback — first line keyword check.
  const first = text.split('\n', 1)[0]?.trim() ?? '';
  if (/^approved\b/i.test(first)) {
    return {
      verdict: 'approved',
      confidence: 0,
      scope: 'NONE',
      issues: [],
      body: first,
    };
  }
  if (/^revise\b/i.test(first)) {
    const stripped = text.replace(/^\s*revise[:\s]*/i, '').trim();
    return {
      verdict: 'revise',
      confidence: 0,
      scope: 'WORDING',
      issues: [],
      body: stripped,
    };
  }
  return {
    verdict: 'unclear',
    confidence: 0,
    scope: 'NONE',
    issues: [],
    body: text.trim(),
  };
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
      `[critic-loop] run ${swarmRunID}: worker and critic share model '${workerModel}' — feedback quality may regress toward self-approval (PATTERN_DESIGN/critic-loop.md I4)`,
    );
  }

  try {
    // 2026-04-25 fix: dropped `agent: CRITIC_AGENT_NAME / WORKER_AGENT_NAME`
    // — custom agent names that aren't in the user's opencode.json (the
    // built-ins are build/compaction/explore/general/plan/summary/title)
    // cause opencode's prompt_async to return HTTP 204 success but never
    // persist the user message or start an assistant turn. Same root
    // cause as the picker-dispatch fix in lib/blackboard/roles.ts. Role
    // display in our UI continues working via roleNamesBySessionID.
    await postSessionMessageServer(
      criticSID,
      meta.workspace,
      buildCriticIntroPrompt(meta.directive),
      { model: criticModel },
    );
    await postSessionMessageServer(
      workerSID,
      meta.workspace,
      buildWorkerIntroPrompt(meta.directive),
      { model: workerModel },
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

  // PATTERN_DESIGN/critic-loop.md I2 — auto-terminate on nitpick
  // loop. Track the last few verdicts; if iterations N-1 and N are
  // both REVISE + WORDING + confidence ≤ 3, the critic is fixating
  // on phrasing rather than substance — ship the current draft and
  // stop. Spec calls for a 2-iteration look-back; we keep history
  // longer for log clarity.
  const verdictHistory: ParsedVerdict[] = [];
  const NITPICK_CONF_MAX = 3;
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

  // Main loop.
  for (let iter = 1; iter <= maxIterations; iter += 1) {
    // Wall-clock cap (#85). Stops new iterations from launching once
    // bounds.minutesCap is exceeded. The current draft (last completed
    // worker turn) stays in opencode regardless.
    if (isWallClockExpired(meta, meta.createdAt)) {
      console.warn(
        `[critic-loop] run ${swarmRunID}: wall-clock cap reached (${formatWallClockState(meta, meta.createdAt)}) — aborting at iter ${iter}/${maxIterations}`,
      );
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
        { model: criticModel },
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
        `[critic-loop] run ${swarmRunID} iter ${iter}: auto-terminating — nitpick streak (last 2 = REVISE+WORDING+confidence≤${NITPICK_CONF_MAX}). Shipping draft N=${iter} (PATTERN_DESIGN/critic-loop.md I2)`,
      );
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
