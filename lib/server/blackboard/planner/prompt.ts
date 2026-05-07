//
// Prompt construction for the planner sweep — directive + README +
// board context + tier escalation preamble + standing instruction
// rules. Tier ladder + tierName helper live here too because the
// prompt is the only consumer.
//
// Prompt history:
// 2026-04-22 (first):  "Use the todowrite tool" — left model free to explore.
//   Went 30+ turns before calling todowrite on "audit for typos" and blew
//   the sweep timeout.
// 2026-04-22 (second): "todowrite MUST be your FIRST tool call, no reads."
//   Fixed the blow-up but left the planner blind to workspace state.
// 2026-04-22 (third): bounded exploration (5 reads) + board-state context.
//   Still biased "atomic / small / verifiable" which produced timid audit-
//   flavored todos — verify X still works, add a test for Y — instead of
//   engaging with the project's actual ambition.
// 2026-04-23 (current): rewritten around "serve the mission." The README
//   is the source of truth for what the project claims to be; unshipped
//   claims are the highest-impact work. Mix of todo sizes is expected.
//   Anti-patterns explicitly banned (passive verifications, timid wording).
//   Exploration budget raised to 10 calls to let the planner understand
//   coverage before scheduling.

import 'server-only';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { listBoardItems } from '../store';
import { TIER_LADDER } from '../auto-ticker/types';

export function buildPlannerPrompt(
  directive: string | undefined,
  boardContext?: PlannerBoardContext,
  readme?: string | null,
  escalationTier?: number,
): string {
  const base =
    directive?.trim() ||
    'Survey the codebase and propose the highest-impact next slice of work.';

  const sections: string[] = [
    'Blackboard planner sweep — mission-anchored work.',
    '',
    '## ⚠ CRITICAL CONSTRAINT — read before anything else',
    '',
    'You have a HARD BUDGET of 12 tool calls in this turn.',
    'Your final tool call MUST be `todowrite`.',
    'If you make 12 tool calls without invoking `todowrite`, the sweep',
    'aborts and your entire turn is discarded — workers get no work,',
    'the run goes stale, the user sees nothing.',
    '',
    'Do not exhaustively explore the codebase. The README is already',
    'embedded below — you do NOT need to read it again. Skim, then',
    'commit. A weak plan that lands beats a perfect plan that times out.',
    '',
    '2026-04-27 incident: a planner spent 31 tool calls (17 reads, 11',
    'greps, 3 globs) reading every file in the workspace and never',
    'invoked `todowrite`. The sweep aborted, no todos landed, the run',
    'failed. Do not be that planner.',
    '',
    '---',
    '',
    '## Mission',
    base,
    '',
  ];

  if (readme) {
    sections.push(
      '## Project README — the source of truth for what this project claims to be',
      '',
      readme,
      '',
      '---',
      '',
    );
  }

  if (boardContext) {
    const doneLines = boardContext.doneSummaries.length
      ? boardContext.doneSummaries.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
      : '  (none)';
    const activeLines = boardContext.activeSummaries.length
      ? boardContext.activeSummaries.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
      : '  (none)';
    const criteriaLines = boardContext.criteriaSummaries.length
      ? boardContext.criteriaSummaries.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
      : '  (none)';
    sections.push(
      '## Prior work on this run',
      '',
      'CONTRACT CRITERIA (authored earlier, auditor verdicts shown) — do NOT',
      'rewrite these; you may ADD new criteria but the text of an existing',
      'one is frozen. Target your new todos at UNMET criteria:',
      criteriaLines,
      '',
      'COMPLETED — do NOT re-propose:',
      doneLines,
      '',
      'OPEN / IN-PROGRESS — other agents are working on these, do NOT duplicate:',
      activeLines,
      '',
    );
  }

  sections.push(
    '## Your job',
    '',
    'You are scheduling the highest-impact next slice of work for a team of',
    'agents who will claim and implement each todo. Goal: maximize the team\'s',
    'progress toward the Mission — NOT maximize the number of todos.',
    '',
  );

  // Ambition ratchet: tier preamble scales scope with each escalation.
  // Tier 1 is the default (bugs, polish, small fixes). Each subsequent
  // tier widens the planner's aperture toward the ceiling.
  if (escalationTier && escalationTier > 1) {
    const tierDesc = TIER_LADDER[escalationTier - 1] ?? `Tier ${escalationTier}: ambitious improvements`;
    sections.push(
      `## ⚠ Escalation tier ${escalationTier} of ${TIER_LADDER.length}`,
      '',
      `The prior sweep(s) completed all work at tier ${escalationTier - 1}.`,
      `You are now operating at TIER ${escalationTier}.`,
      '',
      `This tier's ambition band:`,
      `  ${tierDesc}`,
      '',
      'Do NOT re-propose work from lower tiers (those are COMPLETED above).',
      'Do NOT propose verification-only items unless there is concrete',
      'evidence a feature is broken. Focus on work that ONLY becomes',
      `visible at tier ${escalationTier} scope — cross-cutting, architectural,`,
      'features the codebase lacks, or spec claims still unfulfilled.',
      '',
    );
  }

  return sections.join('\n');
}

// Convert a Windows-style absolute path (C:/foo/bar or C:\foo\bar) to the
// matching WSL mount (/mnt/c/foo/bar) when the Next.js server runs under
// WSL. opencode-side workspace strings are Windows-native because opencode
// itself runs on Windows; this is the one place Node-side reads need to
// go through the mount. No-op for non-Windows paths.
function toNodeReadablePath(p: string): string {
  const m = p.match(/^([A-Za-z]):[/\\](.*)$/);
  if (!m) return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

// Cap README at 32 KB. Most README.md files are 5-25 KB; the long tail is
// rare. Truncation is explicit so the planner doesn't silently miss the
// bottom half.
const README_MAX_BYTES = 32 * 1024;

export async function readWorkspaceReadme(workspace: string): Promise<string | null> {
  const root = toNodeReadablePath(workspace);
  // Case-insensitive filesystems (Windows, macOS default) don't care, but
  // WSL + ext4 does. Try the common casings.
  const candidates = ['README.md', 'readme.md', 'README.MD', 'Readme.md'];
  for (const name of candidates) {
    try {
      const content = await readFile(path.join(root, name), 'utf8');
      if (content.length > README_MAX_BYTES) {
        return (
          content.slice(0, README_MAX_BYTES) +
          '\n\n[… README truncated at 32 KB — rest omitted]'
        );
      }
      return content;
    } catch {
      // Next candidate.
    }
  }
  return null;
}

export interface PlannerBoardContext {
  doneSummaries: string[];
  activeSummaries: string[];
  // 2026-04-24 Stage 2: surface the existing contract so re-sweeps
  // don't duplicate criteria or re-propose already-verdicted work.
  // Labels include the criterion's verdict status when available.
  criteriaSummaries: string[];
}

// Build compact board context for a re-sweep prompt. Caps at 50 per
// bucket and truncates individual summaries at 120 chars to keep the
// prompt from ballooning over a long-running run.
export function buildPlannerBoardContext(swarmRunID: string): PlannerBoardContext {
  const all = listBoardItems(swarmRunID);
  const truncate = (s: string) =>
    s.length > 120 ? s.slice(0, 117).trimEnd() + '…' : s;
  // Exclude criteria from done/active so the planner doesn't see them
  // in the work buckets — they surface separately below.
  const done = all
    .filter((i) => i.status === 'done' && i.kind !== 'criterion')
    .slice(-50)
    .map((i) => truncate(i.content));
  const active = all
    .filter(
      (i) =>
        (i.status === 'open' || i.status === 'claimed' || i.status === 'in-progress') &&
        i.kind !== 'criterion',
    )
    .slice(-50)
    .map((i) => truncate(i.content));
  // Criteria with status labels — auditor verdict visibility helps the
  // planner scope future work to unmet criteria.
  const verdictLabel: Record<string, string> = {
    open: 'pending',
    done: 'MET',
    blocked: 'UNMET',
    stale: 'wont-do',
  };
  const criteria = all
    .filter((i) => i.kind === 'criterion')
    .slice(-30)
    .map((i) => `[${verdictLabel[i.status] ?? i.status}] ${truncate(i.content)}`);
  return {
    doneSummaries: done,
    activeSummaries: active,
    criteriaSummaries: criteria,
  };
}
