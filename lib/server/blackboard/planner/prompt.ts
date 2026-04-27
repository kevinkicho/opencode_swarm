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

// Tier ladder for the ambition ratchet (see "Tiered
// execution"). Used by buildPlannerPrompt when `escalationTier` is set —
// the auto-ticker bumps tier on each idle-stop attempt and calls the
// planner with the new tier, asking for work strictly above the prior
// tier's class. The order is load-bearing — planners that jump tiers
// without earning them tend to hallucinate ambition. MAX_TIER is the
// safety valve; runs do eventually stop past tier 5.
//
// 2026-04-26: canonical home of MAX_TIER moved to auto-ticker/types.ts
// so the ticker's lightweight read paths don't drag this giant planner
// module. TIER_LADDER stays here because only the prompt consumes it.
export const TIER_LADDER: ReadonlyArray<{ tier: number; name: string; shape: string }> = [
  { tier: 1, name: 'Polish', shape: 'small fixes, test gaps, doc corrections, tightening existing functionality' },
  { tier: 2, name: 'Structural', shape: 'refactors for maintainability, architecture improvements, complexity reduction' },
  { tier: 3, name: 'Capabilities', shape: "new features that extend the product's core value" },
  { tier: 4, name: 'Research', shape: 'experimental directions, architectural shifts, external integrations' },
  { tier: 5, name: 'Vision', shape: 'challenge assumptions, propose wholly new directions' },
];

function tierName(tier: number): string {
  return TIER_LADDER.find((t) => t.tier === tier)?.name ?? `Tier ${tier}`;
}

export function buildPlannerPrompt(
  directive: string | undefined,
  boardContext?: PlannerBoardContext,
  readme?: string | null,
  escalationTier?: number,
  teamRoles?: readonly string[],
): string {
  const base =
    directive?.trim() ||
    'Survey the codebase and propose the highest-impact next slice of work.';

  const sections: string[] = [
    'Blackboard planner sweep — mission-anchored work.',
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

  if (escalationTier && escalationTier >= 1) {
    const name = tierName(escalationTier);
    const ladderLines = TIER_LADDER.map(
      (t) => `  Tier ${t.tier} (${t.name}): ${t.shape}`,
    ).join('\n');
    sections.push(
      '## Ambition ratchet — tier escalation',
      '',
      `This sweep is an ESCALATION. Prior tiers of work have drained from the`,
      `board; the team is ready for more ambitious work. You are entering`,
      `**Tier ${escalationTier} (${name})**.`,
      '',
      'Tier ladder:',
      ladderLines,
      '',
      `Your todos MUST target Tier ${escalationTier} ambition or higher. Do NOT`,
      `propose work at tiers below ${escalationTier} even if gaps remain there —`,
      `the team has moved past those. If you genuinely believe no Tier`,
      `${escalationTier}+ work is warranted for this project, call todowrite`,
      `with an empty array and include a one-line note in your reasoning`,
      `explaining why the run should end here.`,
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
    'Ground yourself before planning:',
    '- Re-read the Mission.',
    '- Note which of the README\'s claims the code actually delivers vs. which',
    '  are aspirational and unbuilt. Unshipped claims are usually the highest-',
    '  impact work.',
    '- Use up to 10 read / grep / glob tool calls to sample the codebase',
    '  strategically — not exhaustively.',
    '',
    'Then call todowrite with 6-15 todos. Mix of sizes is expected:',
    '- Small (5-15 min): a targeted fix or polish',
    '- Medium (15-45 min): implement one endpoint, one panel, one integration',
    '- Large (45-120 min): build a feature the README promises but the code',
    '  lacks, wire up a new data source end-to-end, ship a new data pipeline',
    '',
    'Bias strongly toward BUILDING over VERIFYING. If the README promises',
    'integrations with free APIs, public datasets, central-bank or government',
    'data — and those aren\'t wired up yet — the correct todos are "wire up X"',
    'and "implement Y", NOT "verify X still works".',
    '',
    'AVOID these anti-patterns:',
    '- "Verify X still works" — skip passive verifications unless there is',
    '  concrete evidence X is broken.',
    '- "Add tests for existing X" — only if tests are genuinely missing AND',
    '  the area is load-bearing. Agents add tests naturally as they build.',
    '- "Polish X" / "clean up Y" with no specific deliverable.',
    '- Timid wording ("consider possibly", "maybe add", "look into").',
    '- Items indistinguishable from the COMPLETED list above.',
    '',
    'Each todo must be a decisive, verifiable act that advances the Mission.',
    '',
    '**Author acceptance criteria alongside todos.** For each major',
    'outcome the mission demands, emit a todowrite entry prefixed with',
    '`[criterion]` describing the condition in plain language. Example:',
    '`[criterion] Dashboard market-heatmap panel renders live data from',
    'the API when the mission\'s target repo is running`. Criteria are',
    'contract items — they describe WHAT SUCCESS LOOKS LIKE, not work to',
    'do. The auditor verdicts against them (MET / UNMET / WONT_DO) as',
    'the run progresses. Criteria are ADDITIVE: you can emit new ones on',
    "later sweeps as the mission's shape clarifies, but never rewrite",
    'existing ones — the auditor relies on stable contract text. Aim',
    'for 3-6 criteria at boot; more can come as work unfolds. Criteria',
    'do NOT get [verify], [role:X], or [files:] prefixes — they\'re',
    'verdict targets, not worker-dispatch targets.',
    '',
    '**Declare expected file scope per todo.** Prefix each todo\'s content',
    'with `[files:<path>[,<path>]]` listing the files the worker will',
    'touch. Cap at 2 paths (smaller = smaller contention surface when',
    'workers run in parallel; the coordinator rejects commits whose CAS',
    'anchors drift — another worker modified the file under this one).',
    'Example: `[files:lib/foo.ts,src/bar.tsx] Refactor X to extract Y`.',
    'Use paths relative to the workspace root. For research / survey /',
    'investigation todos that produce no file edits, omit the prefix —',
    'the coordinator skips CAS hashing when no expectedFiles are set.',
    '',
    '**Flagging user-observable todos for Playwright verification.** If a',
    "todo claims a UX-visible outcome the user would notice in a browser —",
    '"the dashboard renders X", "clicking Y opens Z", "the chart shows',
    'data from API", "the form submits to the /api/foo endpoint" — prefix',
    'its `content` with the literal token `[verify]` (including brackets).',
    'Example: `[verify] Dashboard market-heatmap panel renders from live',
    "API data`. Todos that don't claim a user-observable outcome",
    '(refactors, internal cleanup, pure test additions, docs) must NOT',
    'carry the prefix. The prefix opts the todo into a browser-automated',
    "check after the critic gate approves; overflagging just slows the",
    'swarm, so be selective.',
    ...(teamRoles && teamRoles.length > 0
      ? [
          '',
          '**Routing todos to role-differentiated workers.** This run has',
          `specialized workers with pinned roles: ${teamRoles.join(', ')}.`,
          'When a todo fits one role obviously better than the others,',
          'prefix it with `[role:<name>]` (combine with `[verify]` if both',
          'apply; `[verify] [role:tester] …` is fine). Example:',
          '`[role:tester] Add unit tests for the heatmap merge reducer`.',
          'Items without a role prefix are claimed by any available',
          'worker, which is the right default — reserve the prefix for',
          'work that would be meaningfully lower-quality outside that',
          'role. Unknown role names are treated as no-prefix.',
          '',
          '**Refining a role on the fly.** If you observe the workload',
          "drifting and a role's self-concept needs sharpening (e.g. the",
          'tester should specialize in Playwright not unit tests for this',
          'mission), emit ONE todowrite entry whose content is',
          '`[rolenote:<role>] <one or two sentences of clarification>`.',
          'These are NOT todos — they get routed to that role\'s session',
          'as a clarification message instead of landing on the board.',
          'Use sparingly (zero or one per sweep), only when the role',
          'would meaningfully misallocate effort without the nudge.',
        ]
      : []),
    '',
    'Rules:',
    '- todowrite must fire within your first 12 tool calls total.',
    '- Do not edit files yourself. Do not call task or bash.',
    '- No subagent recursion after todowrite.',
    '- The sweep aborts at 5 minutes — plan decisively, not exhaustively.',
    '',
    'Call todowrite now.',
  );

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
