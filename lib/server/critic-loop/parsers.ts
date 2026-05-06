import 'server-only';

export type VerdictScope = 'STRUCTURAL' | 'WORDING' | 'NONE';

export interface ParsedVerdict {
  verdict: 'approved' | 'revise' | 'unclear';
  confidence: number;
  scope: VerdictScope;
  issues: string[];
  body: string;
}

export function buildWorkerIntroPrompt(directive: string | undefined): string {
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

export function buildCriticIntroPrompt(directive: string | undefined): string {
  const base =
    directive?.trim() || 'The worker is implementing the project README mission.';
  return [
    'You are the **critic** in a critic loop.',
    '',
    `Context — the worker has been asked to: ${base}`,
    '',
    'Sit tight until the worker produces a draft. You will receive the',
    'draft and your job is to review it rigorously. When you review,',
    'reply in EXACTLY this structured shape:',
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

export function buildReviewPrompt(draft: string, iteration: number): string {
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

export function buildRevisionPrompt(
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

export function classifyCriticReply(text: string): ParsedVerdict {
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