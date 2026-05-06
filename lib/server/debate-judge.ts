// Debate-judge pattern — hierarchical pattern #3.
//
// Shape: N sessions. Session 0 = judge. Sessions 1..N-1 = generators.
// Generators each produce a proposal for the directive (independently,
// council-style). The judge evaluates and returns a verdict — approving
// one proposal, requesting revisions, or declaring a winner via merge.
// Loop for up to debateMaxRounds rounds (default 2) or until the judge
// declares a final verdict.
//
// Contrasted with council: council's round-2 is peer-revise; judge's
// verdict is authoritative. No human-in-the-loop reconcile needed — the
// judge is the decision surface. Pairs well with tasks that have a
// legible quality signal: choosing between two API shapes, picking a
// refactor approach, deciding an architectural tradeoff.

import 'server-only';

import { getSessionMessagesServer, postSessionMessageServer } from './opencode-server';
import { waitForSessionIdle } from './blackboard/coordinator';
import { checkWallClockExpired } from './swarm-bounds';
import { withRunGuard } from './run-guard';
import { recordPartialOutcome } from './degraded-completion';
import { buildLessonsBlock } from './lesson-inject';
import { extractLatestAssistantText, snapshotKnownIDs } from './harvest-drafts';
import {
  JudgeVerdict,
  buildGeneratorIntroPrompt,
  buildJudgeIntroPrompt,
  buildJudgmentPrompt,
  buildRevisionPrompt,
  classifyJudgeReply,
  bulletAddressedFraction,
} from './debate-judge/parsers';

import { TIMINGS } from './pattern-tunables';
const ROUND_WAIT_MS = TIMINGS.debate.roundWaitMs;
const DEFAULT_MAX_ROUNDS = 2;

export async function runDebateJudgeKickoff(
  swarmRunID: string,
  opts: { maxRounds?: number } = {},
): Promise<void> {
  await withRunGuard(
    swarmRunID,
    { expectedPattern: 'debate-judge', context: 'debate-judge' },
    async (meta) => {
  if (meta.sessionIDs.length < 3) {
    console.warn(
      `[debate-judge] run ${swarmRunID} requires at least 3 sessions (1 judge + 2 generators); got ${meta.sessionIDs.length} — kickoff aborted`,
    );
    return;
  }

  const maxRounds =
    opts.maxRounds ?? meta.debateMaxRounds ?? DEFAULT_MAX_ROUNDS;
  const [judgeSID, ...generatorSIDs] = meta.sessionIDs;
  const generatorCount = generatorSIDs.length;
  // Session index mapping: judge=[0], generators=[1..N-1]. meta.teamModels
  // is populated by the per-pattern defaults when the request omits it.
  const judgeModel = meta.teamModels?.[0];
  const generatorModel = (idx: number) => meta.teamModels?.[idx + 1];

  // I3 — generator-model diversity kickoff WARN. With ≥3 generators
  // sharing one model, the debate produces near-identical proposals
  // by construction (same model = same priors). Don't block the run
  // — single-model-with-different-temps is a legitimate experiment —
  // but surface the risk in the dev console.
  if (generatorCount >= 3) {
    const generatorModels = generatorSIDs
      .map((_, i) => generatorModel(i))
      .filter((m): m is string => typeof m === 'string' && m.length > 0);
    if (generatorModels.length === generatorCount) {
      const distinct = new Set(generatorModels);
      if (distinct.size === 1) {
        console.warn(
          `[debate-judge] run ${swarmRunID}: ${generatorCount} generators all use '${generatorModels[0]}' — debate may converge trivially`,
        );
      }
    }
  }

  // Prime judge first (sets up its contract), then fan-post to generators.
  // 2026-04-25 fix: dropped `agent: JUDGE_AGENT_NAME / generator-N` —
  // see lib/server/critic-loop.ts for the full root-cause writeup. Custom
  // agent names not in opencode's built-in list (build/compaction/explore/
  // general/plan/summary/title) cause prompt_async to silently drop the
  // user message + never start an assistant turn.
  const lessons = await buildLessonsBlock(meta.workspace);
  try {
    const judgePrompt = buildJudgeIntroPrompt(meta.directive, generatorCount);
    await postSessionMessageServer(
      judgeSID,
      meta.workspace,
      lessons ? lessons + '\n\n' + judgePrompt : judgePrompt,
      { model: judgeModel },
    );
    await Promise.all(
      generatorSIDs.map((sid, idx) => {
        const genPrompt = buildGeneratorIntroPrompt(meta.directive, idx + 1, generatorCount);
        return postSessionMessageServer(
          sid,
          meta.workspace,
          lessons ? lessons + '\n\n' + genPrompt : genPrompt,
          {
            model: generatorModel(idx),
          },
        );
      }),
    );
  } catch (err) {
    console.warn(
      `[debate-judge] run ${swarmRunID}: initial intro posts failed:`,
      err instanceof Error ? err.message : String(err),
    );
    recordPartialOutcome(swarmRunID, {
      pattern: 'debate-judge',
      phase: 'intro-posts',
      reason: err instanceof Error ? err.message.slice(0, 80) : 'unknown',
      summary:
        'Debate-judge aborted before any round ran — initial intro posts to judge/generator sessions failed.',
    });
    return;
  }
  console.log(
    `[debate-judge] run ${swarmRunID}: judge + ${generatorCount} generators primed`,
  );

  const knownAll = await snapshotKnownIDs(meta, '[debate-judge]');
  const knownByGenerator = new Map<string, Set<string>>();
  for (const sid of generatorSIDs) {
    knownByGenerator.set(sid, knownAll.get(sid) ?? new Set());
  }
  const knownJudge = knownAll.get(judgeSID) ?? new Set<string>();

  // bookkeeping. Stores the prior round's per-generator bullets so
  // the current round's drafts can be checked against them. Empty
  // until the first REVISE verdict.
  let lastReviseBullets: Map<number, string[]> = new Map();
  const I2_ADDRESSED_THRESHOLD = 0.3;

  // #73 — accumulate per-round summary so a partial-outcome record
  // can capture which rounds completed and what survived if the
  // orchestrator aborts mid-debate.
  type RoundRecord = {
    round: number;
    drafts: number;
    judgeVerdict?: string;
  };
  const roundsCompleted: RoundRecord[] = [];
  let lastDrafts: Array<{ index: number; text: string | null }> = [];
  let lastJudgeReply: string | null = null;
  function buildPartialSummary(round: number): string {
    const parts: string[] = [];
    parts.push(
      `Debate-judge aborted at round ${round}/${maxRounds}.`,
    );
    parts.push(`Rounds completed cleanly: ${roundsCompleted.length}`);
    if (roundsCompleted.length > 0) {
      parts.push('');
      parts.push('Round history:');
      for (const r of roundsCompleted) {
        parts.push(
          `  Round ${r.round}: ${r.drafts} draft(s)${r.judgeVerdict ? ` → ${r.judgeVerdict}` : ''}`,
        );
      }
    }
    if (lastDrafts.length > 0) {
      parts.push('');
      parts.push('Latest drafts (this round):');
      for (const d of lastDrafts) {
        if (d.text) {
          parts.push(`--- generator ${d.index} ---`);
          parts.push(d.text);
          parts.push('');
        }
      }
    }
    if (lastJudgeReply) {
      parts.push('');
      parts.push('Latest judge reply:');
      parts.push(lastJudgeReply);
    }
    return parts.join('\n');
  }

  for (let round = 1; round <= maxRounds; round += 1) {
    // Wall-clock cap (#85) — log + abort cleanly if elapsed exceeds
    // bounds.minutesCap. Partial debate (drafts + verdicts already
    // produced) stays in opencode for the human's review.
    if (checkWallClockExpired(swarmRunID, meta, `round ${round}/${maxRounds}`, buildPartialSummary(round))) {
      return;
    }
    // 1. Wait for each generator to produce their round's draft.
    const deadline = Date.now() + ROUND_WAIT_MS;
    const drafts: Array<{ index: number; text: string | null }> = [];
    for (let i = 0; i < generatorSIDs.length; i += 1) {
      const sid = generatorSIDs[i];
      const known = knownByGenerator.get(sid) ?? new Set<string>();
      const wait = await waitForSessionIdle(
        sid,
        meta.workspace,
        known,
        deadline,
      );
      const waitOk = wait.ok;
      if (!waitOk) {
        console.warn(
          `[debate-judge] run ${swarmRunID} round ${round}: generator-${i + 1} wait failed (${wait.reason})`,
        );
      }
      let text: string | null = null;
      try {
        const msgs = await getSessionMessagesServer(sid, meta.workspace);
        // #7.Q22 — only count messages that landed AFTER our prompt was
        // posted. Without this filter, a silent-freeze on the actual draft
        // turn falls through to the generator's prime-ack from the intro
        // post (which IS a completed assistant message with text), and
        // that prime-ack becomes the "draft" the judge sees. Result on
        // run_mofpvnu3_4b9n5i: both generators silent-frozen, judge
        // declared WINNER from two prime-acks. Filtering by `known` makes
        // a silent freeze surface as text=null, which falls through to
        // the `present.length < 2` abort gate below.
        const newMsgs = msgs.filter((m) => !known.has(m.info.id));
        text = extractLatestAssistantText(newMsgs);
        knownByGenerator.set(sid, new Set(msgs.map((m) => m.info.id)));
      } catch {
        // tolerate fetch failure; proceed with null text
      }
      drafts.push({ index: i + 1, text });
    }
    lastDrafts = drafts;
    const present = drafts.filter((d) => d.text !== null);
    if (present.length < 2) {
      console.warn(
        `[debate-judge] run ${swarmRunID} round ${round}: only ${present.length} proposal(s) — aborting`,
      );
      recordPartialOutcome(swarmRunID, {
        pattern: 'debate-judge',
        phase: `round ${round}/${maxRounds} generator-fan-in`,
        reason: 'too-few-drafts',
        summary: buildPartialSummary(round),
      });
      return;
    }

    // I2 — feedback-addressed detection. Only fires from round 2+ and
    // only when the prior round produced REVISE bullets. If the
    // average addressed-fraction across generators with bullets falls
    // below I2_ADDRESSED_THRESHOLD, the generators are ignoring the
    // judge — escalate to human rather than burning more rounds.
    if (round >= 2 && lastReviseBullets.size > 0) {
      let totalGen = 0;
      let totalFrac = 0;
      for (const d of drafts) {
        if (d.text === null) continue;
        const bullets = lastReviseBullets.get(d.index);
        if (!bullets || bullets.length === 0) continue;
        totalGen += 1;
        totalFrac += bulletAddressedFraction(d.text, bullets);
      }
      if (totalGen > 0) {
        const meanFrac = totalFrac / totalGen;
        if (meanFrac < I2_ADDRESSED_THRESHOLD) {
          console.warn(
            `[debate-judge] run ${swarmRunID} round ${round}: generators addressed only ${(meanFrac * 100).toFixed(0)}% of judge's prior REVISE bullets (${totalGen} gen with bullets) — auto-stopping`,
          );
          recordPartialOutcome(swarmRunID, {
            pattern: 'debate-judge',
            phase: `round ${round}/${maxRounds} feedback-not-addressed`,
            reason: 'I2-auto-stop',
            summary: buildPartialSummary(round),
          });
          return;
        } else {
          console.log(
            `[debate-judge] run ${swarmRunID} round ${round}: generators addressed ${(meanFrac * 100).toFixed(0)}% of prior REVISE bullets — proceeding`,
          );
        }
      }
    }

    // 2. Send proposals to judge for verdict.
    try {
      await postSessionMessageServer(
        judgeSID,
        meta.workspace,
        buildJudgmentPrompt(drafts, round, maxRounds),
        { model: judgeModel },
      );
    } catch (err) {
      console.warn(
        `[debate-judge] run ${swarmRunID} round ${round}: judgment post failed:`,
        err instanceof Error ? err.message : String(err),
      );
      recordPartialOutcome(swarmRunID, {
        pattern: 'debate-judge',
        phase: `round ${round}/${maxRounds} judgment-post`,
        reason: err instanceof Error ? err.message.slice(0, 80) : 'unknown',
        summary: buildPartialSummary(round),
      });
      return;
    }

    // 3. Wait for judge's verdict.
    const judgeDeadline = Date.now() + ROUND_WAIT_MS;
    const judgeWait = await waitForSessionIdle(
      judgeSID,
      meta.workspace,
      knownJudge,
      judgeDeadline,
    );
    if (!judgeWait.ok) {
      console.warn(
        `[debate-judge] run ${swarmRunID} round ${round}: judge wait failed (${judgeWait.reason}) — aborting`,
      );
      recordPartialOutcome(swarmRunID, {
        pattern: 'debate-judge',
        phase: `round ${round}/${maxRounds} judge-wait`,
        reason: judgeWait.reason,
        summary: buildPartialSummary(round),
      });
      return;
    }
    for (const m of judgeWait.messages) knownJudge.add(m.info.id);
    const judgeReply = extractLatestAssistantText(judgeWait.messages);
    if (!judgeReply) {
      console.warn(
        `[debate-judge] run ${swarmRunID} round ${round}: judge produced no text — aborting`,
      );
      recordPartialOutcome(swarmRunID, {
        pattern: 'debate-judge',
        phase: `round ${round}/${maxRounds} judge-no-text`,
        reason: 'no-text',
        summary: buildPartialSummary(round),
      });
      return;
    }
    lastJudgeReply = judgeReply;

    const verdict = classifyJudgeReply(judgeReply);
    roundsCompleted.push({
      round,
      drafts: present.length,
      judgeVerdict: verdict.verdict,
    });
    if (verdict.verdict === 'winner' || verdict.verdict === 'merge') {
      console.log(
        `[debate-judge] run ${swarmRunID} round ${round}: ${verdict.verdict.toUpperCase()} — debate complete`,
      );
      if (verdict.body) {
        const { writeDissentLesson } = await import('./memory/memory-store');
        await writeDissentLesson(
          meta.workspace,
          swarmRunID,
          'debate-judge',
          `Overruled stance: ${verdict.body}`,
        ).catch(() => {});
      }
      return;
    }

    if (round >= maxRounds) {
      console.log(
        `[debate-judge] run ${swarmRunID}: max rounds ${maxRounds} reached with no decisive verdict — ending`,
      );
      return;
    }

    // 4. Judge asked for revise (or gave unclear verdict — treated as
    // revise with full text forwarded). Fan-post revision prompt to
    // every generator in parallel. Save the structured bullets for
    // I2's next-round addressed-detection.
    lastReviseBullets = verdict.bulletsByGenerator;
    try {
      await Promise.allSettled(
        generatorSIDs.map((sid, idx) =>
          postSessionMessageServer(
            sid,
            meta.workspace,
            buildRevisionPrompt(verdict.body, round + 1, maxRounds),
            {
              model: generatorModel(idx),
            },
          ),
        ),
      );
    } catch (err) {
      console.warn(
        `[debate-judge] run ${swarmRunID} round ${round}: revision fan-out failed:`,
        err instanceof Error ? err.message : String(err),
      );
      recordPartialOutcome(swarmRunID, {
        pattern: 'debate-judge',
        phase: `round ${round}/${maxRounds} revision-fanout`,
        reason: err instanceof Error ? err.message.slice(0, 80) : 'unknown',
        summary: buildPartialSummary(round),
      });
      return;
    }
    console.log(
      `[debate-judge] run ${swarmRunID} round ${round}: REVISE — feedback fanned to ${generatorSIDs.length} generators`,
    );
  }
    },
  );
}
