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
  getSessionMessagesServer,
  postSessionMessageServer,
} from '../opencode-server';
import { waitForSessionIdle } from './coordinator';
import { insertBoardItem, listBoardItems } from './store';
import type { BoardItem } from '@/lib/blackboard/types';
import type { OpencodeMessage } from '@/lib/opencode/types';

const DEFAULT_TIMEOUT_MS = 90_000;

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

function buildPlannerPrompt(directive: string | undefined): string {
  const base =
    directive?.trim() ||
    'Survey the codebase and propose concrete next steps.';
  return [
    'Blackboard planner sweep.',
    '',
    `Directive: ${base}`,
    '',
    'Produce a list of 5-8 narrow, atomic todos for the directive above.',
    'Each todo should be one concrete change a single agent can claim and',
    'complete without blocking others. Prefer small file-scoped edits over',
    'cross-cutting refactors. Rewrite vague asks into specific, verifiable',
    'steps.',
    '',
    'Use the todowrite tool to output your list. Do not edit files, do not',
    'call task or bash. This is planning-only — other agents will claim and',
    'execute the individual todos.',
  ].join('\n');
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
  opts: { timeoutMs?: number; overwrite?: boolean } = {},
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

  const prompt = buildPlannerPrompt(meta.directive);
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
