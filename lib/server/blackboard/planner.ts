// Initial planner sweep — step 3a of SWARM_PATTERNS.md §1.
//
// Given a live swarm run with an empty board, prompts one of the run's
// sessions to emit a todowrite list and translates each todo into an open
// board item. This is the seed that gives other agents something to claim.
//
// Boundary decisions:
//   - We send the prompt via opencode's async /prompt endpoint and poll
//     /message for the new assistant turn to land. SSE would be lower
//     latency but we don't have a server-to-server SSE client yet and the
//     sweep is a one-shot blocking operation; 1s polling is honest here.
//   - We reuse sessionIDs[0] for the sweep rather than create a dedicated
//     session. For step 3a this means sweeping a council run's first slot
//     injects a planner-style turn into its transcript. That's acceptable
//     for testing against existing runs; when pattern='blackboard' lifts
//     from 501 (step 3d) the run creation can provision a sweep session
//     without touching the workers.
//   - One todowrite call fully replaces the prior list (see
//     lib/opencode/transform.ts::toRunPlan). We take the last todowrite in
//     the new assistant message as the canonical list.
//
// Server-only. Not imported from client code.

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { getRun } from '../swarm-registry';
import {
  abortSessionServer,
  getSessionMessagesServer,
  postSessionMessageServer,
} from '../opencode-server';
import { publishExports } from '../hmr-exports';
import { waitForSessionIdle } from './coordinator';
import { insertBoardItem, listBoardItems } from './store';
import {
  computeDelta,
  getLatestRevisionContents,
  nextRoundForRun,
  recordPlanRevision,
  type BoardSnapshot,
} from './plan-revisions';
import type { BoardItem } from '@/lib/blackboard/types';
import type { OpencodeMessage } from '@/lib/opencode/types';

export const PLANNER_EXPORTS_KEY = Symbol.for(
  'opencode_swarm.planner.exports',
);
export interface PlannerExports {
  runPlannerSweep: (
    swarmRunID: string,
    opts?: {
      timeoutMs?: number;
      overwrite?: boolean;
      includeBoardContext?: boolean;
      escalationTier?: number;
    },
  ) => Promise<PlannerSweepResult>;
}

// Default timeout for a planner sweep. History:
//   - 90s (original). 2026-04-22 incident: kBioIntelBrowser04052026 took
//     31 exploratory turns before todowrite. 90s threw the wait-loop but
//     left the session running; burned 5M tokens in 70+ duplicate
//     todowrite calls before a human noticed.
//   - 5min (2026-04-22). Sized against opencode-zen/go latencies. Worked
//     fine until we moved to ollama-cloud models.
//   - 15min (2026-04-24). Ollama cloud models (glm-5.1:cloud, gemma4:31b-
//     cloud, nemotron-3-super:cloud) have materially higher cold-start
//     and per-turn latency than zen/go — an observation from the first
//     multi-pattern ollama test run where BOTH glm-5.1 and nemotron-3-
//     super hit the 5-min cap mid-exploration. The planner emits 6-15
//     todos after up to 10 exploratory tool calls; at ~30-60s per turn
//     on ollama cloud, 15min is the new realistic ceiling. The abort-on-
//     timeout path below still catches genuine hangs.
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export interface PlannerSweepResult {
  items: BoardItem[];
  sessionID: string;
  planMessageID: string | null;
}

// Mint matches the format used by POST /board (t_ + 8 hex chars). Collision
// probability is ~10^-10 per run — adequate for prototype scale, matched
// against a (run_id, id) UNIQUE constraint in SQL so conflicts surface.
// Exported so other pattern orchestrators (deliberate-execute) can mint
// consistent IDs when seeding the board from their own synthesis paths.
export function mintItemId(): string {
  return 't_' + randomBytes(4).toString('hex');
}

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
// Tier ladder for the ambition ratchet (see SWARM_PATTERNS.md "Tiered
// execution"). Used by buildPlannerPrompt when `escalationTier` is set —
// the auto-ticker bumps tier on each idle-stop attempt and calls the
// planner with the new tier, asking for work strictly above the prior
// tier's class. The order is load-bearing — planners that jump tiers
// without earning them tend to hallucinate ambition. MAX_TIER is the
// safety valve; runs do eventually stop past tier 5.
export const MAX_TIER = 5;
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

function buildPlannerPrompt(
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

async function readWorkspaceReadme(workspace: string): Promise<string | null> {
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

interface RawTodo {
  content: string;
  status?: string;
  priority?: string;
  // Computed by latestTodosFrom — not on the wire. True when the
  // planner tagged this todo's content with a leading `[verify]`
  // prefix, indicating the todo claims a user-observable outcome
  // that merits Playwright verification after commit. See
  // buildPlannerPrompt + the insert path in runPlannerSweep.
  requiresVerification?: boolean;
  // Computed by latestTodosFrom from a leading `[role:<name>]`
  // prefix. Normalized role name (kebab, lowercase, ≤ 24 chars).
  // Undefined when no prefix or on self-organizing runs.
  preferredRole?: string;
  // Computed by latestTodosFrom from a leading `[files:a,b]`
  // prefix. Capped at 2 paths. Undefined when no prefix.
  expectedFiles?: string[];
  // Computed by latestTodosFrom from a leading `[criterion]`
  // prefix. Routes the entry to insertBoardItem with kind='criterion'
  // instead of kind='todo'. Other flags (verify/role/files) are
  // dropped when this is true — criteria are auditor-verdict targets,
  // not worker-dispatch targets.
  isCriterion?: boolean;
}

// Strips the `[verify]` opt-in prefix from a todo's content and
// reports whether it was present. The prefix is the wire protocol
// the planner uses to flag UX-claiming todos (opencode's todowrite
// tool only supports content/status/priority, so we overload
// content rather than invent a new tool). Case-insensitive; allows
// variants like `[verify]`, `[VERIFY]`, `[Verify]`.
const VERIFY_TAG_RE = /^\s*\[verify\]\s*/i;
// Exported for `scripts/_parser_smoke.mjs` — pure function, safe to
// import from a smoke script that doesn't want to pull in the rest of
// the planner's server-only dependency graph.
export function stripVerifyTag(content: string): {
  content: string;
  requiresVerification: boolean;
} {
  const m = VERIFY_TAG_RE.exec(content);
  if (!m) return { content, requiresVerification: false };
  return {
    content: content.slice(m[0].length).trim(),
    requiresVerification: true,
  };
}

// Strips the `[role:<name>]` opt-in prefix from a todo's content and
// returns the resolved preferredRole. Same wire-protocol rationale as
// stripVerifyTag — overload the content field since todowrite has no
// side channel. Role names are normalized to the same shape as
// role-differentiated.ts::normalizeRoleName (lowercase kebab, alnum +
// hyphen only, ≤ 24 chars) so a typo like `[role: Tester ]` still
// matches `tester` downstream. Applies idempotently after
// stripVerifyTag so `[verify] [role:tester] ...` composes.
const ROLE_TAG_RE = /^\s*\[role:\s*([a-z0-9][a-z0-9\s\-_]{0,31})\s*\]\s*/i;
// Exported for `scripts/_parser_smoke.mjs` — same rationale as
// stripVerifyTag.
export function stripRoleTag(content: string): {
  content: string;
  preferredRole: string | undefined;
} {
  const m = ROLE_TAG_RE.exec(content);
  if (!m) return { content, preferredRole: undefined };
  const raw = m[1].toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  if (!normalized) return { content: content.slice(m[0].length).trim(), preferredRole: undefined };
  return {
    content: content.slice(m[0].length).trim(),
    preferredRole: normalized,
  };
}

// Strips the `[files:<path>,<path>]` prefix and returns the expected
// file scope for the todo (2026-04-24, declared-roles alignment). Same
// wire-protocol rationale as stripVerifyTag / stripRoleTag — overload
// the content field because todowrite only accepts content/status/
// priority. Cap at 2 paths per the blackboard spec (smaller = smaller
// contention surface at claim time). Extra paths are silently dropped
// rather than rejecting the whole todo. Empty list → undefined so
// consumers don't distinguish "tag absent" from "tag present but empty."
const FILES_TAG_RE = /^\s*\[files:\s*([^\]]*)\s*\]\s*/i;
const EXPECTED_FILES_MAX = 2;
export function stripFilesTag(content: string): {
  content: string;
  expectedFiles: string[] | undefined;
} {
  const m = FILES_TAG_RE.exec(content);
  if (!m) return { content, expectedFiles: undefined };
  const paths = m[1]
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, EXPECTED_FILES_MAX);
  const stripped = content.slice(m[0].length).trim();
  if (paths.length === 0) {
    return { content: stripped, expectedFiles: undefined };
  }
  return { content: stripped, expectedFiles: paths };
}

// Strips the `[criterion]` prefix — marks the todowrite entry as a
// contract acceptance criterion rather than a work todo (2026-04-24
// Stage 2 declared-roles alignment). Criteria land on the board with
// kind='criterion' and the auditor verdicts against them; workers
// never claim or dispatch to them. Free-text content (same shape as
// todos) lets the auditor use natural-language judgment instead of
// machine-verifiable assertions — keeps the planner's hand free to
// author ambitious criteria the ambition ratchet can work toward.
const CRITERION_TAG_RE = /^\s*\[criterion\]\s*/i;
export function stripCriterionTag(content: string): {
  content: string;
  isCriterion: boolean;
} {
  const m = CRITERION_TAG_RE.exec(content);
  if (!m) return { content, isCriterion: false };
  return {
    content: content.slice(m[0].length).trim(),
    isCriterion: true,
  };
}

// Last todowrite among the given message IDs wins. Mirrors
// transform.ts::toRunPlan's "latest call replaces the list" contract, but
// scoped to just the sweep's new messages so a pre-existing todowrite from
// an earlier turn doesn't leak into the board. Exported for reuse by
// other pattern orchestrators that need to extract todowrite-seeded
// work from an arbitrary session turn (e.g. deliberate-execute synthesis).
export function latestTodosFrom(
  messages: OpencodeMessage[],
  scopeMessageIDs: Set<string>,
): { todos: RawTodo[]; messageId: string } | null {
  let latest: { todos: RawTodo[]; messageId: string } | null = null;
  for (const m of messages) {
    if (!scopeMessageIDs.has(m.info.id)) continue;
    for (const part of m.parts) {
      if (part.type !== 'tool' || part.tool !== 'todowrite') continue;
      const state = part.state as { input?: { todos?: unknown } } | undefined;
      const raw = state?.input?.todos;
      if (!Array.isArray(raw)) continue;
      const todos = raw
        .filter(
          (t): t is RawTodo =>
            !!t &&
            typeof t === 'object' &&
            typeof (t as RawTodo).content === 'string' &&
            (t as RawTodo).content.trim().length > 0,
        )
        .map((t) => {
          // Strip in composition order: criterion → verify → role →
          // files. Criterion goes first because when present the other
          // flags become irrelevant (criteria don't dispatch to workers).
          // Each stripper re-trims leading whitespace so mixed-order
          // tags are tolerated.
          const afterCriterion = stripCriterionTag(t.content);
          if (afterCriterion.isCriterion) {
            return {
              ...t,
              content: afterCriterion.content,
              isCriterion: true,
            };
          }
          const afterVerify = stripVerifyTag(afterCriterion.content);
          const afterRole = stripRoleTag(afterVerify.content);
          const afterFiles = stripFilesTag(afterRole.content);
          return {
            ...t,
            content: afterFiles.content,
            requiresVerification: afterVerify.requiresVerification,
            preferredRole: afterRole.preferredRole,
            expectedFiles: afterFiles.expectedFiles,
          };
        });
      if (todos.length > 0) latest = { todos, messageId: m.info.id };
    }
  }
  return latest;
}

export async function runPlannerSweep(
  swarmRunID: string,
  opts: {
    timeoutMs?: number;
    overwrite?: boolean;
    // When true, prepend the current board's done/open summaries to the
    // planner prompt and raise todo novelty. Used by re-sweeps so the
    // model stops proposing duplicates of already-done work.
    includeBoardContext?: boolean;
    // When true (default), read the workspace's README.md and embed it in
    // the prompt so the planner has the project's claimed scope at hand
    // without burning tool calls on a read. Set false for runs where the
    // README is irrelevant or the workspace has no README.
    includeReadme?: boolean;
    // When set, the prompt includes a tier-escalation preamble instructing
    // the planner to emit work at this tier or higher. See MAX_TIER and
    // TIER_LADDER above, and SWARM_PATTERNS.md "Tiered execution". The
    // auto-ticker's idle-stop path sets this; normal first-sweeps leave it
    // undefined so the planner isn't pressured to invent ambition.
    escalationTier?: number;
  } = {},
): Promise<PlannerSweepResult> {
  const meta = await getRun(swarmRunID);
  if (!meta) throw new Error(`run not found: ${swarmRunID}`);
  if (meta.sessionIDs.length === 0) throw new Error('run has no sessions');

  // Guard against accidental double-sweep. The board is authoritative state;
  // re-sweeping would quietly double the open-todo count.
  if (!opts.overwrite && listBoardItems(swarmRunID).length > 0) {
    throw new Error('board already populated — pass overwrite=true to re-sweep');
  }

  const sessionID = meta.sessionIDs[0];

  // Snapshot existing messages so we can diff "new since sweep". opencode's
  // /message endpoint returns full history with no tail param, so we track
  // IDs client-side.
  const before = await getSessionMessagesServer(sessionID, meta.workspace);
  const knownIDs = new Set(before.map((m) => m.info.id));

  const boardContext = opts.includeBoardContext
    ? buildPlannerBoardContext(swarmRunID)
    : undefined;
  // includeReadme defaults to true — project vision should anchor every
  // sweep. The READ itself is cheap (~one filesystem call, single-digit
  // ms) and the prompt-token cost is offset by saving the planner a
  // mandatory tool call to read it.
  const readme =
    opts.includeReadme === false ? null : await readWorkspaceReadme(meta.workspace);
  // Role-differentiated runs get `[role:<name>]` prefix instructions
  // so the planner can route todos to specialized workers. Other
  // patterns (self-organizing or role-implicit) get the plain prompt.
  // meta.teamRoles is persisted by role-differentiated.ts kickoff so
  // it's populated even if the user didn't supply an explicit list.
  const teamRolesForPrompt =
    meta.pattern === 'role-differentiated' && meta.teamRoles && meta.teamRoles.length > 0
      ? meta.teamRoles
      : undefined;

  // Tier resolution: explicit opt wins (auto-ticker's tier-escalation
  // path passes the bumped value); fall back to meta.currentTier so a
  // run started via `continuationOf` targets the inherited tier on its
  // first sweep without requiring every caller to thread the value.
  // Undefined → plain first-sweep prompt.
  const effectiveEscalationTier =
    opts.escalationTier ?? (meta.currentTier && meta.currentTier > 1 ? meta.currentTier : undefined);

  const prompt = buildPlannerPrompt(
    meta.directive,
    boardContext,
    readme,
    effectiveEscalationTier,
    teamRolesForPrompt,
  );
  // Planner dispatch. Two channels, one wins:
  //   1. Team-model pinning (meta.teamModels[0]): when the new-run-
  //      modal picker supplied a specific model for session 0, honor
  //      it. This is explicit user intent for "this run runs on
  //      <model>" — overrides the default plan-agent override so a
  //      user can force the planner onto ollama even when their
  //      opencode.json has a 'plan' agent pointing at a zen model.
  //   2. Default: route through opencode's `plan` agent-config so
  //      users can pin a smarter/more-expensive model for the planner
  //      via opencode.json's `agent.plan.model`, while leaving worker
  //      turns on whatever default model is cheap. Before this, the
  //      planner defaulted to the `build` agent (same model as
  //      workers), which wasted reasoning quality on simple worker
  //      tasks or overpaid on planning. See
  //      feedback_zen_model_preference.md.
  const pinnedModel = meta.teamModels?.[0];
  await postSessionMessageServer(sessionID, meta.workspace, prompt, {
    agent: pinnedModel ? undefined : 'plan',
    model: pinnedModel,
  });

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  // waitForSessionIdle waits for every new assistant message to complete AND
  // a brief quiet window — so we get the FULL response, not the first step.
  // Without this, a model that reads a file first (tool:read step) before
  // calling todowrite would race us: we'd catch the read step completing,
  // find no todowrite in scope, and exit with 0 items.
  const waited = await waitForSessionIdle(
    sessionID,
    meta.workspace,
    knownIDs,
    deadline,
  );
  if (!waited.ok) {
    // Critical: abort the opencode session before re-throwing. Without this,
    // a timed-out session keeps streaming turns into the void — the planner's
    // poll loop has exited so nothing consumes todowrite calls, but the model
    // has no stop condition. Incident 2026-04-22 burned 5M tokens across 70+
    // orphaned todowrite calls before a human noticed.
    try {
      await abortSessionServer(sessionID, meta.workspace);
    } catch (abortErr) {
      const detail =
        abortErr instanceof Error ? abortErr.message : String(abortErr);
      console.warn(
        `[planner] abort-on-timeout failed for ${sessionID}: ${detail} — ` +
          `session may keep burning tokens`,
      );
    }
    if (waited.reason === 'timeout') {
      throw new Error(`planner sweep timed out after ${timeoutMs}ms`);
    }
    throw new Error('planner sweep failed: assistant turn errored');
  }

  const latest = latestTodosFrom(waited.messages, waited.newIDs);
  if (!latest) {
    // Assistant finished but didn't call todowrite. Return empty items —
    // caller can decide whether to retry with a stricter prompt.
    // Still log a no-op revision so the strategy tab can render
    // "sweep #N — orchestrator declined to revise" rather than missing
    // a round entirely.
    try {
      const round = nextRoundForRun(swarmRunID);
      recordPlanRevision({
        swarmRunID,
        round,
        added: [],
        removed: [],
        rephrased: [],
        boardSnapshot: snapshotBoard(swarmRunID),
        excerpt: extractAssistantExcerpt(waited.messages, waited.newIDs),
        planMessageId: null,
      });
    } catch (err) {
      console.warn(
        `[planner] plan-revision log failed (no-op sweep): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { items: [], sessionID, planMessageID: null };
  }

  // Spread createdAtMs by 1ms per item so the board's ORDER BY on
  // created_ms produces a stable order within a sweep. Without this,
  // every item in a batch shares Date.now() and ties fall through to
  // listBoardItems' id ASC secondary sort — which works, but this way
  // the timestamps themselves carry authoring order, which keeps the
  // preview UI (ordered by createdAtMs in JS land) consistent without
  // needing to also know about the SQL tiebreaker.
  const baseMs = Date.now();
  const items: BoardItem[] = [];
  let offset = 0;
  for (const raw of latest.todos) {
    const content = raw.content.trim();
    if (!content) continue;
    // Criteria land as kind='criterion' and drop the worker-dispatch
    // flags (verify/role/files) since they're never claimed or
    // dispatched to. Other todos land as kind='todo' with all flags.
    const item = raw.isCriterion
      ? insertBoardItem(swarmRunID, {
          id: mintItemId(),
          kind: 'criterion',
          content,
          status: 'open',
          createdAtMs: baseMs + offset,
        })
      : insertBoardItem(swarmRunID, {
          id: mintItemId(),
          kind: 'todo',
          content,
          status: 'open',
          requiresVerification: raw.requiresVerification === true,
          preferredRole: raw.preferredRole,
          expectedFiles: raw.expectedFiles,
          createdAtMs: baseMs + offset,
        });
    offset += 1;
    items.push(item);
  }

  // Log the plan-revision delta. Compares the new sweep's content list
  // against the prior sweep's logical list (recovered by replaying the
  // plan_revisions chain forward — see plan-revisions.ts). The first
  // sweep on a run treats all items as added. Errors are swallowed
  // (warn-and-continue) so a logging hiccup never breaks the sweep.
  try {
    const round = nextRoundForRun(swarmRunID);
    const currentContents = items
      .filter((it) => it.kind === 'todo' || it.kind === 'criterion')
      .map((it) => it.content);
    const prior = getLatestRevisionContents(swarmRunID);
    const priorContents = prior?.contents ?? [];
    const delta = computeDelta(priorContents, currentContents);
    recordPlanRevision({
      swarmRunID,
      round,
      added: delta.added,
      removed: delta.removed,
      rephrased: delta.rephrased,
      boardSnapshot: snapshotBoard(swarmRunID),
      excerpt: extractAssistantExcerpt(waited.messages, waited.newIDs),
      planMessageId: latest.messageId,
    });
  } catch (err) {
    console.warn(
      `[planner] plan-revision log failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return { items, sessionID, planMessageID: latest.messageId };
}

// Compute the board snapshot for plan_revisions.board_snapshot_json.
// Counts every status bucket — strategy tab uses these to render the
// sweep-time chip without a join against board_items.
function snapshotBoard(swarmRunID: string): BoardSnapshot {
  const all = listBoardItems(swarmRunID);
  const snap: BoardSnapshot = {
    total: all.length,
    open: 0,
    claimed: 0,
    inProgress: 0,
    done: 0,
    stale: 0,
    blocked: 0,
  };
  for (const it of all) {
    switch (it.status) {
      case 'open':
        snap.open += 1;
        break;
      case 'claimed':
        snap.claimed += 1;
        break;
      case 'in-progress':
        snap.inProgress += 1;
        break;
      case 'done':
        snap.done += 1;
        break;
      case 'stale':
        snap.stale += 1;
        break;
      case 'blocked':
        snap.blocked += 1;
        break;
      default:
        break;
    }
  }
  return snap;
}

// Pull a 200-char excerpt from the assistant's plan turn — text +
// reasoning combined (matches the planner-tab UX expectation that the
// row "speaks" the orchestrator's reasoning at a glance). Empty when
// the turn produced only tool calls without text. Used by both the
// happy-path and the no-op path so the log is uniformly populated.
function extractAssistantExcerpt(
  messages: OpencodeMessage[],
  scopeIDs: Set<string>,
): string | null {
  let combined = '';
  for (const m of messages) {
    if (!scopeIDs.has(m.info.id)) continue;
    if (m.info.role !== 'assistant') continue;
    for (const part of m.parts) {
      if (part.type === 'text' || part.type === 'reasoning') {
        const t = (part as { text?: string }).text;
        if (typeof t === 'string') combined += t;
      }
    }
  }
  if (!combined) return null;
  const trimmed = combined.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > 200 ? trimmed.slice(0, 197) + '…' : trimmed;
}

// HMR-resilient publish — see lib/server/hmr-exports.ts. auto-ticker's
// attemptReSweep + runPeriodicSweep both read runPlannerSweep via this
// slot so edits to the planner prompt / timeout / etc. take effect
// without needing to restart the ticker.
publishExports<PlannerExports>(PLANNER_EXPORTS_KEY, { runPlannerSweep });
