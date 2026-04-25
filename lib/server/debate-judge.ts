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
import { formatWallClockState, isWallClockExpired } from './swarm-bounds';
import { withRunGuard } from './run-guard';
import { recordPartialOutcome } from './degraded-completion';
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
    'verdict in exactly this structured shape (PATTERN_DESIGN/debate-',
    'judge.md I1):',
    '',
    '  WINNER: generator-N (confidence: K/5) — <one-line reason>',
    '  MERGE: (confidence: K/5) <synthesis of best elements across proposals>',
    '  REVISE — generator-N:',
    '    - <specific change 1>',
    '    - <specific change 2>',
    '    - <specific change 3>',
    '  REVISE — generator-M:',
    '    - <…>',
    '',
    'Start your reply with one of WINNER / MERGE / REVISE (case-',
    'insensitive). On WINNER and MERGE, include `(confidence: K/5)`',
    'where K is 1-5 (PATTERN_DESIGN/debate-judge.md I4). 5 = clearly',
    'best, 4 = strong preference, 3 = better-than-others, 2 = close',
    'call, 1 = could go either way. Be honest about close calls — the',
    'UI shows the score so the user can spot when a winner barely',
    'edged out the others. On REVISE, list 2-4 specific bullet-point',
    'changes per generator who needs revision. Bullets must name a',
    'concrete edit, not a vague critique — "tighten the second',
    'paragraph" beats "improve flow."',
    '',
    'Your verdict is authoritative. WINNER or MERGE ends the debate.',
    'REVISE sends per-generator bullets back for the next round.',
    'Note: the orchestrator auto-stops if generators fail to engage',
    "with your REVISE bullets across consecutive rounds, so the",
    'feedback shape is load-bearing.',
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
  // PATTERN_DESIGN/debate-judge.md I1 — per-generator structured
  // bullets. Map keys are generator indices (1..N); values are the
  // verdict's bullet list for that generator. Empty when the reply
  // didn't conform to the structured contract — fallback path.
  bulletsByGenerator: Map<number, string[]>;
  // PATTERN_DESIGN/debate-judge.md I4 — judge confidence on
  // WINNER/MERGE verdicts. 1-5 scale; null when the judge didn't
  // emit a parseable score (older models, REVISE verdicts where
  // confidence isn't applicable, or non-conforming replies).
  // Surfaced in the debate-rail's verdict cell as a small bar.
  confidence: number | null;
}

// Parse `(confidence: K/5)` or `confidence: K` from a verdict line.
// Tolerant of capitalization and surrounding punctuation.
const CONFIDENCE_RE = /confidence\s*[:=]\s*([1-5])\s*(?:\/\s*5)?/i;
function parseConfidence(text: string): number | null {
  const m = CONFIDENCE_RE.exec(text);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
}

// Parse REVISE bullets per generator. Pattern: a line like
// "REVISE — generator-2:" introduces a generator block, followed
// by bulleted lines starting with "- " until the next block or
// end-of-text. Tolerant of variants ("REVISE generator-2:",
// "Generator 2:" inside a single REVISE block).
function parseGeneratorBullets(text: string): Map<number, string[]> {
  const map = new Map<number, string[]>();
  // Match section headers like "REVISE — generator-2:" or
  // "Generator 2:" optionally preceded by whitespace.
  const sectionRe = /(?:^|\n)\s*(?:revise[\s:—-]+)?generator[\s-]*(\d+)\s*:\s*\n([\s\S]*?)(?=(?:\n\s*(?:revise[\s:—-]+)?generator[\s-]*\d+\s*:)|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = sectionRe.exec(text)) !== null) {
    const idx = parseInt(match[1], 10);
    if (!Number.isFinite(idx)) continue;
    const block = match[2];
    const bullets: string[] = [];
    const bulletRe = /^\s*[-*+]\s+(.+)$/gm;
    let bm: RegExpExecArray | null;
    while ((bm = bulletRe.exec(block)) !== null) {
      const cleaned = bm[1].trim();
      if (cleaned) bullets.push(cleaned);
    }
    if (bullets.length > 0) map.set(idx, bullets);
  }
  return map;
}

function classifyJudgeReply(text: string): JudgeVerdict {
  const first = text.split('\n', 1)[0]?.trim() ?? '';
  // I4: confidence comes from anywhere in the WINNER / MERGE line.
  // Parsed once across the first ~200 chars (the verdict line);
  // null when missing.
  const headerSlice = text.slice(0, 200);
  const confidence = parseConfidence(headerSlice);
  if (/^winner\b/i.test(first)) {
    return {
      verdict: 'winner',
      body: text.trim(),
      bulletsByGenerator: new Map(),
      confidence,
    };
  }
  if (/^merge\b/i.test(first)) {
    return {
      verdict: 'merge',
      body: text.trim(),
      bulletsByGenerator: new Map(),
      confidence,
    };
  }
  if (/^revise\b/i.test(first)) {
    const stripped = text.replace(/^\s*revise[:\s]*/i, '').trim();
    return {
      verdict: 'revise',
      body: stripped,
      bulletsByGenerator: parseGeneratorBullets(text),
      // REVISE verdicts don't have confidence (they're not picking a
      // winner). Always null.
      confidence: null,
    };
  }
  return {
    verdict: 'unclear',
    body: text.trim(),
    bulletsByGenerator: new Map(),
    confidence: null,
  };
}

// PATTERN_DESIGN/debate-judge.md I2 — feedback-addressed detection.
// Given a generator's R(N+1) proposal text and the bullets the judge
// asked it to address in R(N), count how many bullets the proposal
// engaged with. Engagement is detected by token-jaccard ≥ 0.4 against
// the bullet text — captures rephrasing without forcing exact
// substring match. Returns the addressed-fraction in [0, 1].
function tokenizeForAddress(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 4) continue;
    out.add(raw);
  }
  return out;
}

function bulletAddressedFraction(
  proposalText: string,
  bullets: string[],
): number {
  if (bullets.length === 0) return 1; // nothing to address = trivially "addressed"
  const proposalTok = tokenizeForAddress(proposalText);
  let addressed = 0;
  for (const b of bullets) {
    const bulletTok = tokenizeForAddress(b);
    if (bulletTok.size === 0) continue;
    let intersect = 0;
    for (const t of bulletTok) if (proposalTok.has(t)) intersect += 1;
    const union = proposalTok.size + bulletTok.size - intersect;
    const jaccard = union === 0 ? 0 : intersect / union;
    // Use a low threshold (0.10) — proposals are typically much
    // longer than the bullet, so even partial overlap usually means
    // engagement. We just want to catch the "totally ignored" case.
    if (jaccard >= 0.1) addressed += 1;
  }
  return addressed / bullets.length;
}

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
          `[debate-judge] run ${swarmRunID}: ${generatorCount} generators all use '${generatorModels[0]}' — debate may converge trivially (PATTERN_DESIGN/debate-judge.md I3)`,
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
  try {
    await postSessionMessageServer(
      judgeSID,
      meta.workspace,
      buildJudgeIntroPrompt(meta.directive, generatorCount),
      { model: judgeModel },
    );
    await Promise.all(
      generatorSIDs.map((sid, idx) =>
        postSessionMessageServer(
          sid,
          meta.workspace,
          buildGeneratorIntroPrompt(meta.directive, idx + 1, generatorCount),
          {
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

  // PATTERN_DESIGN/debate-judge.md I2 — feedback-addressed detection
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
    if (isWallClockExpired(meta, meta.createdAt)) {
      console.warn(
        `[debate-judge] run ${swarmRunID}: wall-clock cap reached (${formatWallClockState(meta, meta.createdAt)}) — aborting at round ${round}/${maxRounds}`,
      );
      recordPartialOutcome(swarmRunID, {
        pattern: 'debate-judge',
        phase: `round ${round}/${maxRounds} (wall-clock)`,
        reason: 'wall-clock-cap',
        summary: buildPartialSummary(round),
      });
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
            `[debate-judge] run ${swarmRunID} round ${round}: generators addressed only ${(meanFrac * 100).toFixed(0)}% of judge's prior REVISE bullets (${totalGen} gen with bullets) — auto-stopping (PATTERN_DESIGN/debate-judge.md I2)`,
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
