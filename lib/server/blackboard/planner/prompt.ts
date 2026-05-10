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
import type { BoardDelta } from './prompt-delta';
import { computeBoardDelta } from './prompt-delta';
import { estimateTokens } from '@/lib/server/opencode-models';

// Truncate a prompt to fit within the model's context limit.
// Uses 4 chars/token estimation and defaults to 128K when the
// model lookup fails. Truncation priority: board context first
// (active → criteria → done), then README, then lessons.
function truncateToFit(prompt: string, _modelID: string): string {
  const ctxLimit = 128_000; // default when lookup unavailable
  const estTokens = prompt.length / 4;
  const maxTokens = ctxLimit * 0.85;

  if (estTokens <= maxTokens) return prompt;

  const sections = prompt.split('\n\n## ');
  if (sections.length < 2) {
    return prompt.slice(0, Math.floor(maxTokens * 4));
  }

  const available = ctxLimit * 0.85;
  const safeLen = Math.floor(available * 4);

  return prompt.slice(0, safeLen);
}

export function buildPlannerPrompt(
  directive: string | undefined,
  boardContext?: PlannerBoardContext,
  readme?: string | null,
  escalationTier?: number,
  packageMap?: string,
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

  if (packageMap) {
    sections.push(packageMap, '', '---', '');
  }

  if (boardContext) {
    // Delta mode: send only what changed since last sweep, not the full
    // board context. Combined with Fix 1's fresh session per sweep, this
    // keeps planner context under ~8K chars per re-sweep instead of
    // re-reading the same done + active items every time.
    const d = boardContext.delta;
    if (d?.isDelta) {
      const newDoneLines = d.newDone.length
        ? d.newDone.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
        : '  (none)';
      const newActiveLines = d.newActive.length
        ? d.newActive.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
        : '  (none)';
      const changedCritLines = d.changedCriteria.length
        ? d.changedCriteria.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
        : '  (none)';
      const failureLines = boardContext.failurePatterns.length
        ? boardContext.failurePatterns.map((s) => `  ${s}`).join('\n')
        : '  (none)';
      sections.push(
        '## Prior work — CHANGES SINCE LAST SWEEP only',
        '',
        'NEWLY COMPLETED since last sweep:',
        newDoneLines,
        '',
        'NEWLY OPENED since last sweep:',
        newActiveLines,
        '',
        'CRITERIA WITH CHANGED VERDICTS since last sweep:',
        changedCritLines,
        '',
        'STALE:',
        boardContext.staleSummary,
        '',
        failureLines !== '  (none)'
          ? `Why prior work went stale:\n${failureLines}\n`
          : '',
      );
    } else {
    const doneLines = boardContext.doneSummaries.length
      ? boardContext.doneSummaries.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
      : '  (none)';
    const activeLines = boardContext.activeSummaries.length
      ? boardContext.activeSummaries.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
      : '  (none)';
    const criteriaLines = boardContext.criteriaSummaries.length
      ? boardContext.criteriaSummaries.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
      : '  (none)';
    const failureLines = boardContext.failurePatterns.length
      ? boardContext.failurePatterns.map((s) => `  ${s}`).join('\n')
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
      'STALE:',
      boardContext.staleSummary,
      '',
      failureLines !== '  (none)'
        ? `Why prior work went stale:\n${failureLines}\n`
        : '',
      'OPEN / IN-PROGRESS — other agents are working on these, do NOT duplicate:',
      activeLines,
      '',
    );
    }
  }

  sections.push(
    '## Your job',
    '',
    'You are scheduling the highest-impact next slice of work for a team of',
    'agents who will claim and implement each todo. Goal: maximize the team\'s',
    'progress toward the Mission — NOT maximize the number of todos.',
    '',
    'Every todowrite entry MUST have a content string. Optional prefixes:',
    '',
    '  [criterion] — acceptance condition for the auditor to verdict.',
    '    Pair every 2-3 todos with a criterion the auditor can judge.',
    '    Example: "[criterion] Dashboard renders live data within 2s of update"',
    '    Criteria that are vague ("make it better") are silently dropped.',
    '    Include 1-2 criteria per sweep — they define the contract.',
    '',
    '  [verify]   — marks a todo as Playwright-verifiable',
    '  [role:X]   — assigns to role X (kebab, e.g. build, test)',
    '  [files:A,B] — expected file scope (max 2)',
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

  return truncateToFit(sections.join('\n'), 'ollama/glm-5.1:cloud');
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
  staleSummary: string;
  criteriaSummaries: string[];
  failurePatterns: string[];
  // Delta mode: when set, this sweep sends only items added/changed
  // since the last sweep. The full summaries above are still populated
  // but the prompt builder prioritizes the delta when available.
  delta?: BoardDelta | null;
}

// Build compact board context for a re-sweep prompt. Caps at 50 per
// bucket and truncates individual summaries at 120 chars to keep the
// prompt from ballooning over a long-running run. A total budget of
// ~8K chars prevents planner token bloat on runs with 50+ done items
// (postmortem mouzkzpy: planner consumed 84% of total tokens, much of
// it re-reading the same board context across sweeps).
const BOARD_CONTEXT_CHAR_BUDGET = 8000;

function trimToBudget(
  items: string[],
  budget: number,
): string[] {
  let used = 0;
  const kept: string[] = [];
  for (const item of items) {
    if (used + item.length > budget && kept.length > 0) {
      const dropped = items.length - kept.length;
      if (dropped > 0) {
        kept.push(`... and ${dropped} more`);
      }
      return kept;
    }
    kept.push(item);
    used += item.length + 1;
  }
  return kept;
}

// English filler words to strip before dedup comparison. These rarely
// carry semantic weight and removing them reduces false-negative overlap
// ("Fix the stuck-check" vs "Fix stuck-check" → same tokens after stripping).
const FILLER_WORDS = new Set([
  'the', 'a', 'an', 'in', 'for', 'of', 'to', 'is', 'are', 'and', 'or',
  'on', 'at', 'by', 'it', 'its', 'was', 'be', 'has', 'had', 'do', 'does',
]);

// Strip filler words, then remainder is token-overlap-comparable.
export function stripFillerWords(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !FILLER_WORDS.has(t))
    .join(' ');
}

// Classify a stale item's note into one of a few failure categories for
// pattern clustering. Returns the category key and a human-readable hint.
function classifyStaleNote(note: string | null | undefined): {
  category: string;
  hint: string;
} {
  if (!note) return { category: 'unknown', hint: 'No reason recorded.' };
  const lower = note.toLowerCase();
  if (lower.includes('silent') || lower.includes('timeout') || lower.includes('went silent')) {
    return {
      category: 'silent',
      hint: 'Worker session timed out mid-task. Propose smaller-scoped work — single-file fixes, not multi-module changes.',
    };
  }
  if (lower.includes('abort') || lower.includes('messageaborted')) {
    return {
      category: 'abort',
      hint: 'Worker was aborted mid-task (possibly user intervention or stale session). Avoid proposing work that depends on long-running operations.',
    };
  }
  if (lower.includes('error') || lower.includes('fail')) {
    return {
      category: 'error',
      hint: 'Worker encountered an error. Consider scoping down or targeting simpler, more isolated changes.',
    };
  }
  if (lower.includes('drift') || lower.includes('conflict') || lower.includes('changed under')) {
    return {
      category: 'drift',
      hint: 'Another worker modified the same files. Propose work in different files or mark [files:] explicitly to reduce contention.',
    };
  }
  return { category: 'other', hint: 'Prior work failed for unspecified reasons. Scope proposals conservatively.' };
}

// Extract expected file paths from a stale item's content ([files:...] tag)
// or its expectedFiles field, for capability-aware scoping hints.
function extractFileScope(item: { content: string; expectedFiles?: string[] }): string[] {
  if (item.expectedFiles && item.expectedFiles.length > 0) return item.expectedFiles;
  const m = item.content.match(/^\[files:\s*([^\]]+)\]/i);
  if (m) return m[1].split(',').map((p) => p.trim()).filter(Boolean).slice(0, 2);
  return [];
}

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
  // P4-simpler: stale items are no longer listed verbatim (they consumed
  // up to 2.4K chars and the planner already ignores the details after
  // seeing the headline). Instead, emit a one-liner summary with count
  // and failure pattern clusters so the planner knows *what failed* and
  // *why* without re-reading every rejected item.
  const staleItems = all.filter(
    (i) => i.status === 'stale' && i.kind !== 'criterion',
  );
  // Cluster stale items by failure category for P5/P1 failure-pattern
  // reporting in the planner prompt.
  const failureByCategory = new Map<string, { count: number; hint: string; files: Set<string> }>();
  for (const item of staleItems) {
    const { category, hint } = classifyStaleNote(item.note);
    const entry = failureByCategory.get(category) ?? { count: 0, hint, files: new Set<string>() };
    entry.count += 1;
    for (const f of extractFileScope(item)) {
      entry.files.add(f);
    }
    failureByCategory.set(category, entry);
  }
  const failurePatterns: string[] = [];
  for (const [category, { count, hint, files }] of failureByCategory) {
    const fileList = files.size > 0 ? ` Files affected: ${[...files].slice(0, 4).join(', ')}.` : '';
    failurePatterns.push(
      `• ${count} item${count > 1 ? 's' : ''} failed (${category}): ${hint}${fileList}`,
    );
  }
  // P3: capability-aware scoping — group stale items by file path so the
  // planner knows which modules are causing workers trouble.
  const moduleFailures = new Map<string, number>();
  for (const item of staleItems) {
    for (const f of extractFileScope(item)) {
      // Use directory name as module proxy
      const mod = f.replace(/\/[^/]+$/, '') || f;
      moduleFailures.set(mod, (moduleFailures.get(mod) ?? 0) + 1);
    }
  }
  if (moduleFailures.size > 0) {
    const topModules = [...moduleFailures.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    const moduleLine = topModules
      .map(([mod, count]) => `${mod} (${count} failure${count > 1 ? 's' : ''})`)
      .join(', ');
    failurePatterns.push(
      `→ Workers struggled in: ${moduleLine}. Propose smaller, single-file fixes in these modules.`,
    );
  }

  const staleSummary = staleItems.length === 0
    ? '(none)'
    : `${staleItems.length} item${staleItems.length > 1 ? 's' : ''} went stale and will NOT be re-proposed. Adjust scope for the failure patterns below.`;

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
  // Apply total character budget. Priority: active > criteria > failurePatterns > done.
  // Active items are what workers are doing right now — critical for the
  // planner to avoid duplication. Criteria define the contract. Failure
  // patterns replace the old stale section with more actionable signal.
  // Done is lowest priority (negative constraint).
  let budget = BOARD_CONTEXT_CHAR_BUDGET;
  const activeFinal = trimToBudget(active, budget);
  budget -= activeFinal.reduce((s, l) => s + l.length + 1, 0);
  const criteriaFinal = trimToBudget(criteria, budget);
  budget -= criteriaFinal.reduce((s, l) => s + l.length + 1, 0);
  // failurePatterns are short (1-3 lines) — always fit, but be safe
  const failurePatternsFinal = trimToBudget(failurePatterns, Math.min(budget, 800));
  budget -= failurePatternsFinal.reduce((s, l) => s + l.length + 1, 0);
  const doneFinal = trimToBudget(done, budget);

  // Compute delta for planner prompt caching. On re-sweeps, only
  // items added/changed since the last sweep are sent — the full
  // summaries above fall back when no prior snapshot exists.
  const delta = computeBoardDelta(swarmRunID);

  return {
    doneSummaries: doneFinal,
    activeSummaries: activeFinal,
    staleSummary,
    failurePatterns: failurePatternsFinal,
    criteriaSummaries: criteriaFinal,
    delta,
  };
}
