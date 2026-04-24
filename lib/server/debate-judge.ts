// Debate-judge pattern — hierarchical pattern #3 (see SWARM_PATTERNS.md §7).
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

import { getSessionMessagesServer, postSessionMessageServer } from './opencode-server';
import { waitForSessionIdle } from './blackboard/coordinator';
import { finalizeRun } from './finalize-run';
import { getRun } from './swarm-registry';
import type { OpencodeMessage } from '../opencode/types';

const JUDGE_AGENT_NAME = 'judge';
const GENERATOR_AGENT_PREFIX = 'generator-';

const ROUND_WAIT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_ROUNDS = 2;

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

function buildGeneratorIntroPrompt(
  directive: string | undefined,
  generatorIndex: number,
  totalGenerators: number,
): string {
  const base =
    directive?.trim() ||
    'Address the mission implied by the project README.';
  return [
    `You are **generator ${generatorIndex} of ${totalGenerators}** in a debate.`,
    '',
    `Mission: ${base}`,
    '',
    'Produce YOUR proposal for how to approach this. Be concrete —',
    'describe the approach, make explicit trade-offs, and commit to',
    'specifics. Other generators are working in parallel without seeing',
    'your draft. A judge will evaluate all proposals and select one',
    '(possibly asking for revisions).',
    '',
    'Focus on genuine divergence — do NOT try to guess what the other',
    'generators will say. Your value is the distinct perspective you',
    'bring. The judge picks winners based on quality + fit, not consensus.',
  ].join('\n');
}

function buildJudgeIntroPrompt(
  directive: string | undefined,
  generatorCount: number,
): string {
  const base =
    directive?.trim() ||
    'The generators are addressing the mission from the project README.';
  return [
    `You are the **judge** in a debate between ${generatorCount} generators.`,
    '',
    `Mission: ${base}`,
    '',
    'Sit tight until the generators produce their proposals. Once you',
    "receive them, your job is to evaluate rigorously and deliver a",
    'verdict. Reply in exactly one of these shapes:',
    '',
    '  WINNER: <generator-N> — <one-line reason>',
    '  MERGE: <synthesis of best elements across proposals>',
    '  REVISE: <specific feedback for each generator who needs revision>',
    '',
    'Start your reply with one of those keywords (case-insensitive).',
    'Your verdict is authoritative. If you pick a WINNER or deliver a',
    'MERGE, the debate ends. REVISE sends specific feedback back to',
    'generators for another round (limited rounds available).',
  ].join('\n');
}

function buildJudgmentPrompt(
  drafts: Array<{ index: number; text: string | null }>,
  round: number,
  maxRounds: number,
): string {
  const proposalBlocks = drafts
    .filter((d) => d.text !== null)
    .map(
      (d) =>
        `### Proposal from generator-${d.index}\n\n${(d.text ?? '').trim()}`,
    )
    .join('\n\n---\n\n');
  return [
    `## Round ${round} of ${maxRounds}: evaluate the proposals below`,
    '',
    proposalBlocks,
    '',
    '---',
    '',
    'Reply now. Start with WINNER, MERGE, or REVISE per your contract.',
  ].join('\n');
}

function buildRevisionPrompt(
  feedback: string,
  round: number,
  maxRounds: number,
): string {
  return [
    `## Round ${round} of ${maxRounds}: judge requested revisions`,
    '',
    'Judge feedback:',
    '',
    feedback.trim(),
    '',
    'Revise your proposal to address the feedback. Reply with your',
    'updated proposal.',
  ].join('\n');
}

interface JudgeVerdict {
  verdict: 'winner' | 'merge' | 'revise' | 'unclear';
  body: string;
}

function classifyJudgeReply(text: string): JudgeVerdict {
  const first = text.split('\n', 1)[0]?.trim() ?? '';
  if (/^winner\b/i.test(first)) return { verdict: 'winner', body: text.trim() };
  if (/^merge\b/i.test(first)) return { verdict: 'merge', body: text.trim() };
  if (/^revise\b/i.test(first)) {
    const stripped = text.replace(/^\s*revise[:\s]*/i, '').trim();
    return { verdict: 'revise', body: stripped };
  }
  return { verdict: 'unclear', body: text.trim() };
}

export async function runDebateJudgeKickoff(
  swarmRunID: string,
  opts: { maxRounds?: number } = {},
): Promise<void> {
  try {
  const meta = await getRun(swarmRunID);
  if (!meta) {
    console.warn(`[debate-judge] run ${swarmRunID} not found — kickoff aborted`);
    return;
  }
  if (meta.pattern !== 'debate-judge') {
    console.warn(
      `[debate-judge] run ${swarmRunID} has pattern '${meta.pattern}', not debate-judge — kickoff aborted`,
    );
    return;
  }
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
          `[debate-judge] run ${swarmRunID}: ${generatorCount} generators all use '${generatorModels[0]}' — debate may converge trivially (PATTERN_DESIGN/debate-judge.md I3)`,
        );
      }
    }
  }

  // Prime judge first (sets up its contract), then fan-post to generators.
  try {
    await postSessionMessageServer(
      judgeSID,
      meta.workspace,
      buildJudgeIntroPrompt(meta.directive, generatorCount),
      { agent: JUDGE_AGENT_NAME, model: judgeModel },
    );
    await Promise.all(
      generatorSIDs.map((sid, idx) =>
        postSessionMessageServer(
          sid,
          meta.workspace,
          buildGeneratorIntroPrompt(meta.directive, idx + 1, generatorCount),
          {
            agent: `${GENERATOR_AGENT_PREFIX}${idx + 1}`,
            model: generatorModel(idx),
          },
        ),
      ),
    );
  } catch (err) {
    console.warn(
      `[debate-judge] run ${swarmRunID}: initial intro posts failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  console.log(
    `[debate-judge] run ${swarmRunID}: judge + ${generatorCount} generators primed`,
  );

  // Track known IDs per session so subsequent rounds only harvest new turns.
  const knownByGenerator = new Map<string, Set<string>>();
  const knownJudge = new Set<string>();
  for (const sid of generatorSIDs) {
    const msgs = await getSessionMessagesServer(sid, meta.workspace).catch(
      () => [],
    );
    knownByGenerator.set(sid, new Set(msgs.map((m) => m.info.id)));
  }
  {
    const msgs = await getSessionMessagesServer(judgeSID, meta.workspace).catch(
      () => [],
    );
    for (const m of msgs) knownJudge.add(m.info.id);
  }

  for (let round = 1; round <= maxRounds; round += 1) {
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
      if (!wait.ok) {
        console.warn(
          `[debate-judge] run ${swarmRunID} round ${round}: generator-${i + 1} wait failed (${wait.reason})`,
        );
      }
      let text: string | null = null;
      try {
        const msgs = await getSessionMessagesServer(sid, meta.workspace);
        text = extractLatestAssistantText(msgs);
        knownByGenerator.set(sid, new Set(msgs.map((m) => m.info.id)));
      } catch {
        // tolerate fetch failure; proceed with null text
      }
      drafts.push({ index: i + 1, text });
    }
    const present = drafts.filter((d) => d.text !== null);
    if (present.length < 2) {
      console.warn(
        `[debate-judge] run ${swarmRunID} round ${round}: only ${present.length} proposal(s) — aborting`,
      );
      return;
    }

    // 2. Send proposals to judge for verdict.
    try {
      await postSessionMessageServer(
        judgeSID,
        meta.workspace,
        buildJudgmentPrompt(drafts, round, maxRounds),
        { agent: JUDGE_AGENT_NAME, model: judgeModel },
      );
    } catch (err) {
      console.warn(
        `[debate-judge] run ${swarmRunID} round ${round}: judgment post failed:`,
        err instanceof Error ? err.message : String(err),
      );
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
      return;
    }
    for (const m of judgeWait.messages) knownJudge.add(m.info.id);
    const judgeReply = extractLatestAssistantText(judgeWait.messages);
    if (!judgeReply) {
      console.warn(
        `[debate-judge] run ${swarmRunID} round ${round}: judge produced no text — aborting`,
      );
      return;
    }

    const verdict = classifyJudgeReply(judgeReply);
    if (verdict.verdict === 'winner' || verdict.verdict === 'merge') {
      console.log(
        `[debate-judge] run ${swarmRunID} round ${round}: ${verdict.verdict.toUpperCase()} — debate complete`,
      );
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
    // every generator in parallel.
    try {
      await Promise.allSettled(
        generatorSIDs.map((sid, idx) =>
          postSessionMessageServer(
            sid,
            meta.workspace,
            buildRevisionPrompt(verdict.body, round + 1, maxRounds),
            {
              agent: `${GENERATOR_AGENT_PREFIX}${idx + 1}`,
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
      return;
    }
    console.log(
      `[debate-judge] run ${swarmRunID} round ${round}: REVISE — feedback fanned to ${generatorSIDs.length} generators`,
    );
  }
  } finally {
    await finalizeRun(swarmRunID, 'debate-judge');
  }
}
