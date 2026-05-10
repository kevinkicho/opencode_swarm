import 'server-only';

export interface JudgeVerdict {
  verdict: 'winner' | 'merge' | 'revise' | 'unclear';
  body: string;
  bulletsByGenerator: Map<number, string[]>;
  confidence: number | null;
}

export const CONFIDENCE_RE = /confidence\s*[:=]\s*([1-5])\s*(?:\/\s*5)?/i;

export function buildGeneratorIntroPrompt(
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

export function buildJudgeIntroPrompt(
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
  'verdict in exactly this structured shape (',
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
    'where K is 1-5. 5 = clearly',
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

export function buildJudgmentPrompt(
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

export function buildRevisionPrompt(
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

export function parseConfidence(text: string): number | null {
  const m = CONFIDENCE_RE.exec(text);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
}

export function parseGeneratorBullets(text: string): Map<number, string[]> {
  const map = new Map<number, string[]>();
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

export function classifyJudgeReply(text: string): JudgeVerdict {
  const first = text.split('\n', 1)[0]?.trim() ?? '';
  const headerSlice = text.slice(0, 200);
  const confidence = parseConfidence(headerSlice);
  // Primary: first-line keyword match (original behavior).
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
      confidence: null,
    };
  }
  // Fallback: keyword anywhere in first 200 chars.
  // LLMs often write "After reviewing the proposals, my WINNER is..."
  // or "I choose MERGE because..." — these should still parse.
  const winnerMatch = /\bWINNER\b/i.exec(headerSlice);
  const mergeMatch = /\bMERGE\b/i.exec(headerSlice);
  const reviseMatch = /\bREVISE\b/i.exec(headerSlice);
  // Use earliest match to resolve ambiguity.
  const matches: Array<{ idx: number; verdict: 'winner' | 'merge' | 'revise' }> = [];
  if (winnerMatch) matches.push({ idx: winnerMatch.index, verdict: 'winner' });
  if (mergeMatch) matches.push({ idx: mergeMatch.index, verdict: 'merge' });
  if (reviseMatch) matches.push({ idx: reviseMatch.index, verdict: 'revise' });
  if (matches.length > 0) {
    matches.sort((a, b) => a.idx - b.idx);
    const best = matches[0];
    if (best.verdict === 'winner') {
      return {
        verdict: 'winner',
        body: text.trim(),
        bulletsByGenerator: new Map(),
        confidence,
      };
    }
    if (best.verdict === 'merge') {
      return {
        verdict: 'merge',
        body: text.trim(),
        bulletsByGenerator: new Map(),
        confidence,
      };
    }
    const stripped = text.replace(/^\s*revise[:\s]*/i, '').trim();
    return {
      verdict: 'revise',
      body: stripped,
      bulletsByGenerator: parseGeneratorBullets(text),
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

export function tokenizeForAddress(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 4) continue;
    out.add(raw);
  }
  return out;
}

export function bulletAddressedFraction(
  proposalText: string,
  bullets: string[],
): number {
  if (bullets.length === 0) return 1;
  const proposalTok = tokenizeForAddress(proposalText);
  let addressed = 0;
  for (const b of bullets) {
    const bulletTok = tokenizeForAddress(b);
    if (bulletTok.size === 0) continue;
    let intersect = 0;
    for (const t of bulletTok) if (proposalTok.has(t)) intersect += 1;
    const union = proposalTok.size + bulletTok.size - intersect;
    const jaccard = union === 0 ? 0 : intersect / union;
    if (jaccard >= 0.1) addressed += 1;
  }
  return addressed / bullets.length;
}