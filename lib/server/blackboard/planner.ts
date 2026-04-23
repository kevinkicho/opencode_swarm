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

import { getRun } from '../swarm-registry';
import {
  abortSessionServer,
  getSessionMessagesServer,
  postSessionMessageServer,
} from '../opencode-server';
import { waitForSessionIdle } from './coordinator';
import { insertBoardItem, listBoardItems } from './store';
import type { BoardItem } from '@/lib/blackboard/types';
import type { OpencodeMessage } from '@/lib/opencode/types';

// Default timeout for a planner sweep. Raised from the original 90s after
// 2026-04-22 incident: a real-repo sweep (kBioIntelBrowser04052026) spent
// 31 exploratory assistant turns before emitting todowrite. 90s threw the
// sweep's wait-loop but left the session running — it burned 5M tokens in
// 70+ duplicate todowrite calls before a human noticed.
//
// 5min matches the dispatch deadline in runMapReduceSynthesis and gives a
// model room to explore *once* before committing to a plan. The abort-on-
// timeout path below is the real safety net; this just reduces how often
// it fires for legitimate work.
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface PlannerSweepResult {
  items: BoardItem[];
  sessionID: string;
  planMessageID: string | null;
}

// Mint matches the format used by POST /board (t_ + 8 hex chars). Collision
// probability is ~10^-10 per run — adequate for prototype scale, matched
// against a (run_id, id) UNIQUE constraint in SQL so conflicts surface.
function mintItemId(): string {
  return 't_' + randomBytes(4).toString('hex');
}

// Prompt history:
// 2026-04-22 (first):  "Use the todowrite tool" — left model free to explore.
//   Went 30+ turns before calling todowrite on "audit for typos" and blew
//   the sweep timeout. Second tightening below.
// 2026-04-22 (second): "todowrite MUST be your FIRST tool call, no reads
//   allowed." Fixed the blow-up but left the planner blind — for periodic
//   re-sweeps the planner couldn't see what changed and just re-proposed
//   stale directive-flavored todos.
// 2026-04-22 (current): bounded exploration (up to 5 read-side calls) plus
//   board-state context for re-sweeps. The 5-min deadline + abort-on-timeout
//   from runPlannerSweep is the real runaway guard; the call-count cap here
//   is advisory. Count raised from 5-8 to 10-15 so larger teams (6+ agents)
//   don't idle between sweeps.
function buildPlannerPrompt(
  directive: string | undefined,
  boardContext?: PlannerBoardContext,
): string {
  const base =
    directive?.trim() ||
    'Survey the codebase and propose concrete next steps.';

  const sections: string[] = [
    'Blackboard planner sweep.',
    '',
    `Directive: ${base}`,
    '',
  ];

  if (boardContext) {
    const doneLines = boardContext.doneSummaries.length
      ? boardContext.doneSummaries.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
      : '  (none)';
    const activeLines = boardContext.activeSummaries.length
      ? boardContext.activeSummaries.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
      : '  (none)';
    sections.push(
      'This is a re-sweep. The board already has state:',
      '',
      'COMPLETED — do NOT re-propose these:',
      doneLines,
      '',
      'OPEN / IN-PROGRESS — other agents are working on these, do NOT duplicate:',
      activeLines,
      '',
    );
  }

  sections.push(
    'Your task: call the todowrite tool with 10-15 atomic todos that are',
    'NEW (not duplicates of the lists above, if any). Each todo is one',
    'concrete change a single agent can claim and complete in 5-20 min of',
    'focused work. Prefer small file-scoped edits over cross-cutting refactors.',
    'Rewrite vague asks into specific, verifiable steps.',
    '',
    'Workspace exploration:',
    '- You MAY run up to 5 grep / glob / read tool calls to scan the current',
    '  workspace state before calling todowrite. Sample strategically — do',
    '  not exhaustively read every file. This is especially useful for a',
    '  re-sweep, where the codebase has evolved and new opportunities may',
    '  have surfaced since the prior plan.',
    '- todowrite must fire within your first 6 tool calls total. Do not',
    '  explore indefinitely — the sweep aborts after 5 minutes.',
    '',
    'Rules:',
    '- Do not edit files. Do not call task, bash, or any write-side tools.',
    '- Other agents will claim each todo and do the full implementation.',
    '',
    'Call todowrite now.',
  );

  return sections.join('\n');
}

export interface PlannerBoardContext {
  doneSummaries: string[];
  activeSummaries: string[];
}

// Build compact board context for a re-sweep prompt. Caps at 50 per
// bucket and truncates individual summaries at 120 chars to keep the
// prompt from ballooning over a long-running run.
export function buildPlannerBoardContext(swarmRunID: string): PlannerBoardContext {
  const all = listBoardItems(swarmRunID);
  const truncate = (s: string) =>
    s.length > 120 ? s.slice(0, 117).trimEnd() + '…' : s;
  const done = all
    .filter((i) => i.status === 'done')
    .slice(-50)
    .map((i) => truncate(i.content));
  const active = all
    .filter((i) => i.status === 'open' || i.status === 'claimed' || i.status === 'in-progress')
    .slice(-50)
    .map((i) => truncate(i.content));
  return { doneSummaries: done, activeSummaries: active };
}

interface RawTodo {
  content: string;
  status?: string;
  priority?: string;
}

// Last todowrite among the given message IDs wins. Mirrors
// transform.ts::toRunPlan's "latest call replaces the list" contract, but
// scoped to just the sweep's new messages so a pre-existing todowrite from
// an earlier turn doesn't leak into the board.
function latestTodosFrom(
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
      const todos = raw.filter(
        (t): t is RawTodo =>
          !!t &&
          typeof t === 'object' &&
          typeof (t as RawTodo).content === 'string' &&
          (t as RawTodo).content.trim().length > 0,
      );
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
  const prompt = buildPlannerPrompt(meta.directive, boardContext);
  await postSessionMessageServer(sessionID, meta.workspace, prompt);

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
    const item = insertBoardItem(swarmRunID, {
      id: mintItemId(),
      kind: 'todo',
      content,
      status: 'open',
      createdAtMs: baseMs + offset,
    });
    offset += 1;
    items.push(item);
  }
  return { items, sessionID, planMessageID: latest.messageId };
}
