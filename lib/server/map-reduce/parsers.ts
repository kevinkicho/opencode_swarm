import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { THRESHOLDS } from '../pattern-tunables';

export const SLICE_EXCLUDE = new Set<string>([
  '.git',
  '.next',
  '.svelte-kit',
  '.turbo',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  'tmp',
]);

export const SCOPE_CODE_EXTS = new Set<string>([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rb', '.java', '.kt', '.swift',
  '.rs', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.cs', '.php', '.scala', '.sh', '.sql',
  '.css', '.scss', '.html', '.md', '.yaml', '.yml', '.json',
]);

export const SCOPE_IMBALANCE_THRESHOLD = THRESHOLDS.mapReduce.scopeImbalance;

export const MAX_DRAFT_CHARS_FOR_SYNTHESIS = THRESHOLDS.mapReduce.maxDraftCharsForSynthesis;

export const MAX_SYNTHESIS_CRITIC_REVISIONS = THRESHOLDS.mapReduce.maxSynthesisCriticRevisions;

export async function deriveSlices(
  workspace: string,
  count: number,
): Promise<string[]> {
  let entries: string[] = [];
  try {
    const dirents = await fs.readdir(workspace, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => !n.startsWith('.') && !SLICE_EXCLUDE.has(n))
      .sort();
  } catch {
    return Array.from({ length: count }, () => '(whole workspace)');
  }

  if (entries.length === 0) {
    return Array.from({ length: count }, () => '(whole workspace)');
  }

  if (entries.length <= count) {
    const slices: string[] = entries.slice(0, count);
    while (slices.length < count) slices.push('(whole workspace)');
    return slices;
  }

  const buckets: string[][] = Array.from({ length: count }, () => []);
  entries.forEach((name, i) => {
    buckets[i % count].push(name);
  });
  return buckets.map((b) => b.join(', '));
}

export async function walkScopeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as import('node:fs').Dirent[];
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SLICE_EXCLUDE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += await walkScopeBytes(full);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!SCOPE_CODE_EXTS.has(ext)) continue;
      try {
        const stat = await fs.stat(full);
        total += stat.size;
      } catch {
      }
    }
  }
  return total;
}

export async function approxScopeBytes(workspace: string, slice: string): Promise<number> {
  if (slice === '(whole workspace)' || slice === '*') return 0;
  const dirs = slice.split(',').map((s) => s.trim()).filter(Boolean);
  let total = 0;
  for (const d of dirs) {
    total += await walkScopeBytes(path.join(workspace, d));
  }
  return total;
}

export async function detectScopeImbalance(
  workspace: string,
  slices: string[],
): Promise<void> {
  const sizes = await Promise.all(
    slices.map((s) => approxScopeBytes(workspace, s)),
  );
  const measurable = sizes.filter((n) => n > 0);
  if (measurable.length < 2) return;
  const max = Math.max(...measurable);
  const min = Math.min(...measurable);
  if (min === 0) return;
  const ratio = max / min;
  if (ratio <= SCOPE_IMBALANCE_THRESHOLD) return;
  const summary = slices
    .map((s, i) => `${s}=${(sizes[i] / 1024).toFixed(0)}KB`)
    .join(' ');
  console.warn(
    `[map-reduce] — scope imbalance: max:min = ${ratio.toFixed(1)}x (threshold ${SCOPE_IMBALANCE_THRESHOLD}x); ${summary}`,
  );
}

export function buildScopedDirective(
  baseDirective: string,
  slice: string,
  memberIndex: number,
  teamSize: number,
): string {
  return [
    baseDirective.trim(),
    '',
    `---`,
    `Map-reduce scope (member ${memberIndex + 1} of ${teamSize}): ${slice}`,
    `Focus your exploration inside this scope. Other members of the council`,
    `are covering the rest of the workspace in parallel. A synthesizer will`,
    `merge every member's output once everyone has finished — produce a`,
    `self-contained markdown report as your final assistant turn.`,
  ].join('\n');
}

export function buildMapPhaseSummary(
  present: Array<{ sessionID: string; text: string | null }>,
  totalSessionCount: number,
  failedCount: number,
): string {
  const parts: string[] = [];
  parts.push(
    `Map-reduce synthesis aborted. ${present.length}/${totalSessionCount} drafts harvested; ${failedCount} member(s) failed.`,
  );
  if (present.length > 0) {
    parts.push('');
    parts.push('Map drafts that DID complete (preserved here so the human can reconcile manually):');
    for (const d of present) {
      parts.push(`--- session ${d.sessionID.slice(-8)} ---`);
      parts.push(d.text ?? '');
      parts.push('');
    }
  }
  return parts.join('\n');
}

export function truncateDraftForSynthesis(text: string): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= MAX_DRAFT_CHARS_FOR_SYNTHESIS) {
    return { text, truncated: false };
  }
  const head = text.slice(0, MAX_DRAFT_CHARS_FOR_SYNTHESIS).trimEnd();
  const omitted = text.length - MAX_DRAFT_CHARS_FOR_SYNTHESIS;
  return {
    text:
      head +
      `\n\n*[…truncated for synthesis: ${omitted.toLocaleString()} additional chars omitted to fit synthesizer context. Reduce teamSize or have mappers produce more focused drafts to avoid truncation.]*`,
    truncated: true,
  };
}

export function buildSynthesisPrompt(
  drafts: Array<{ sessionID: string; text: string | null }>,
  baseDirective: string | undefined,
  failedCount?: number,
): string {
  const preface = baseDirective?.trim()
    ? `Original directive: ${baseDirective.trim()}`
    : 'The council was given a split-scope directive and each member covered its own slice.';

  let truncatedCount = 0;
  const blocks = drafts.map((d, i) => {
    const label = `Member ${i + 1} (${d.sessionID.slice(-8)})`;
    if (d.text === null) {
      return `### ${label}\n\n*(no final draft — session did not produce a text output in time)*`;
    }
    const { text, truncated } = truncateDraftForSynthesis(d.text.trim());
    if (truncated) truncatedCount += 1;
    return `### ${label}\n\n${text}`;
  });
  if (truncatedCount > 0) {
    console.warn(
      `[map-reduce] synthesis prompt — ${truncatedCount}/${drafts.length} draft(s) truncated to ${MAX_DRAFT_CHARS_FOR_SYNTHESIS.toLocaleString()} chars to fit synthesizer context (#97). Consider reducing teamSize (recommendedMax for map-reduce is 5).`,
    );
  }

  const presentCount = drafts.filter((d) => d.text !== null).length;
  const failureNote =
    failedCount && failedCount > 0
      ? [
          '',
          `**Note:** ${failedCount} member(s) did not produce a draft in time;`,
          `this synthesis is based on ${presentCount} draft(s). Surface the`,
          `coverage gap explicitly in your output so a downstream reader can`,
          `tell the story is incomplete.`,
          '',
        ]
      : [];

  return [
    'Map-reduce synthesis phase.',
    '',
    preface,
    '',
    `Below are ${drafts.length} sibling drafts from the map phase. Read each`,
    `carefully, then produce ONE unified synthesis as your reply. The synthesis`,
    `should:`,
    '',
    '- Preserve concrete evidence (file paths, line numbers, symbols) — do not strip anchors.',
    '- Merge overlapping findings; call out genuine disagreements instead of averaging them away.',
    '- Preserve unique picks from individual members when they add value, attributing by member number.',
    '- Finish with a clean markdown document as your final assistant text turn. Do not edit any files.',
    ...failureNote,
    '',
    '---',
    '',
    blocks.join('\n\n---\n\n'),
  ].join('\n');
}

export function pickCriticSession(
  sessionIDs: readonly string[],
  synthesizerSessionID: string,
): string | null {
  for (const sid of sessionIDs) {
    if (sid !== synthesizerSessionID) return sid;
  }
  return null;
}

export function buildCriticPrompt(
  synthesisText: string,
  drafts: Array<{ sessionID: string; text: string | null }>,
): string {
  const draftBlocks = drafts
    .filter((d) => d.text !== null)
    .map((d, i) => `### Draft from member ${i + 1}\n\n${(d.text ?? '').trim()}`)
    .join('\n\n---\n\n');
  return [
    '## Synthesis review',
    '',
    'Another member of this map-reduce just produced the synthesis below',
    'from the per-member drafts. Your job: judge whether the synthesis',
    'faithfully merges the drafts without dropping critical findings,',
    'and whether genuine disagreements between members are surfaced',
    'instead of papered over.',
    '',
    'Reply format (strict):',
    '- First line: exactly `APPROVED` or `REVISE`.',
    '- If REVISE: the rest of your reply is concrete, actionable feedback',
    ' the synthesizer should apply (specific findings missed, claims that',
    ' need attribution, sections that strip anchors, etc.). 2–6 bullets.',
    '- If APPROVED: no further text needed.',
    '',
    'Do NOT edit any files. This is a verdict, not a rewrite.',
    '',
    '---',
    '',
    '## Synthesis under review',
    '',
    synthesisText.trim(),
    '',
    '---',
    '',
    `## Original member drafts (${drafts.length} total)`,
    '',
    draftBlocks,
  ].join('\n');
}

export function parseCriticVerdict(
  text: string,
): { verdict: 'approved' | 'revise' | 'unclear'; feedback: string } {
  const head = text.trimStart().slice(0, 64).toUpperCase();
  if (head.startsWith('APPROVED')) {
    return { verdict: 'approved', feedback: '' };
  }
  if (head.startsWith('REVISE')) {
    const idx = text.indexOf('\n');
    const feedback = idx >= 0 ? text.slice(idx + 1).trim() : '';
    return { verdict: 'revise', feedback };
  }
  return { verdict: 'unclear', feedback: '' };
}

export function buildSynthesisRevisePrompt(
  feedback: string,
  attempt: number,
  maxAttempts: number,
): string {
  return [
    `## Revision ${attempt} of ${maxAttempts} — synthesis-critic feedback`,
    '',
    'A peer reviewed your synthesis and asked for revisions. Apply the',
    'feedback below and re-emit the full synthesis as your next assistant',
    'turn. Keep what worked; only adjust what the critic flagged. Do NOT',
    'edit any files.',
    '',
    '---',
    '',
    feedback || '(no specific feedback provided — judge what to refine)',
  ].join('\n');
}