// Coordinator tick — steps 3b (idle detection) + 3c (claim + work + commit)
// of SWARM_PATTERNS.md §1.
//
// One tick:
//   1. Pick an open todo and an idle session that has nothing in-flight on
//      the board. If either is missing, return a reason and exit.
//   2. Open → claimed → in-progress directly via the store (bypass HTTP
//      action route; the coordinator runs server-side with a trusted caller).
//   3. Send a work prompt to the session.
//   4. Poll /message until the assistant turn completes or the timeout fires.
//   5. Extract edited file paths from the new turn's `patch` parts, hash
//      them, and transition in-progress → done with those hashes attached.
//      On error/timeout, transition to stale with a note.
//
// Single-coordinator-per-run assumption: ticks are serialized by the caller.
// CAS at the SQL layer still protects against accidental concurrent claims,
// but the prompt-send side has no re-entry guard — don't call tick twice
// concurrently for the same run.
//
// No drift detection yet. Fine for single-agent-at-a-time serialization;
// when multi-agent parallelism lands, switch to pre-snapshot SHAs at claim
// time and let the existing /commit action route handle the drift check.
//
// Server-only. Never imported from client code.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getRun } from '../swarm-registry';
import {
  getSessionMessagesServer,
  postSessionMessageServer,
} from '../opencode-server';
import { listBoardItems, transitionStatus } from './store';
import type { BoardItem } from '@/lib/blackboard/types';
import type { OpencodeMessage } from '@/lib/opencode/types';

const POLL_INTERVAL_MS = 1000;
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;

// Owner-id convention for the coordinator: ag_ses_<last8>. Keeps the id
// short for UI columns while remaining unambiguous per session. Matches the
// "board ownerAgentId is whatever the writer posts" contract in
// lib/blackboard/types.ts — derivation happens in the UI.
export function ownerIdForSession(sessionID: string): string {
  return 'ag_ses_' + sessionID.slice(-8);
}

export type TickOutcome =
  | { status: 'picked'; sessionID: string; itemID: string; editedPaths: string[] }
  | { status: 'stale'; sessionID: string; itemID: string; reason: string }
  | { status: 'skipped'; reason: string };

export interface TickOpts {
  timeoutMs?: number;
}

// Same pattern as planner.ts::sha7 — 7-char git-short SHA1 of file contents.
async function sha7(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  return createHash('sha1').update(buf).digest('hex').slice(0, 7);
}

function isAssistantComplete(m: OpencodeMessage): boolean {
  return m.info.role === 'assistant' && !!m.info.time.completed;
}

function isAssistantInFlight(m: OpencodeMessage): boolean {
  return (
    m.info.role === 'assistant' &&
    !m.info.time.completed &&
    !m.info.error
  );
}

// Which files did the turn edit? `patch` parts carry `files: string[]`
// (one part per turn that committed edits — see lib/opencode/types.ts). We
// union across every patch part in the scoped messages, so a turn that
// touches the same file twice produces one entry.
function extractEditedPaths(
  messages: OpencodeMessage[],
  scopeMessageIDs: Set<string>,
): string[] {
  const paths = new Set<string>();
  for (const m of messages) {
    if (!scopeMessageIDs.has(m.info.id)) continue;
    for (const part of m.parts) {
      if (part.type !== 'patch') continue;
      for (const f of part.files) paths.add(f);
    }
  }
  return [...paths];
}

function buildWorkPrompt(item: BoardItem): string {
  return [
    'Blackboard work prompt.',
    '',
    `Todo id: ${item.id}`,
    `Todo: ${item.content}`,
    '',
    'Complete this todo by editing the relevant file(s) directly. Keep the',
    'scope narrow — one todo, one change. Do not call the task tool, do',
    'not spawn sub-agents. When done, reply with a one-sentence summary.',
    '',
    'If the todo turns out to be wrong or already done, reply "skip:" with',
    'a one-line reason and do not edit anything.',
  ].join('\n');
}

async function waitForNewAssistantTurn(
  sessionID: string,
  workspace: string,
  knownIDs: Set<string>,
  deadline: number,
): Promise<{
  ok: true;
  messages: OpencodeMessage[];
  newIDs: Set<string>;
} | { ok: false; reason: 'timeout' | 'error' }> {
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const messages = await getSessionMessagesServer(sessionID, workspace);
    const newIDs = new Set(
      messages.filter((m) => !knownIDs.has(m.info.id)).map((m) => m.info.id),
    );
    const errored = messages.some(
      (m) => newIDs.has(m.info.id) && m.info.role === 'assistant' && m.info.error,
    );
    if (errored) return { ok: false, reason: 'error' };
    const completed = messages.some(
      (m) => newIDs.has(m.info.id) && isAssistantComplete(m),
    );
    if (completed) return { ok: true, messages, newIDs };
  }
  return { ok: false, reason: 'timeout' };
}

export async function tickCoordinator(
  swarmRunID: string,
  opts: TickOpts = {},
): Promise<TickOutcome> {
  const meta = await getRun(swarmRunID);
  if (!meta) return { status: 'skipped', reason: 'run not found' };
  if (meta.sessionIDs.length === 0) {
    return { status: 'skipped', reason: 'run has no sessions' };
  }

  // Work picker: oldest open todo wins. Oldest = lowest createdAtMs, which
  // is the bottom of listBoardItems' newest-first output.
  const all = listBoardItems(swarmRunID);
  const openTodos = all.filter(
    (i) => i.status === 'open' && (i.kind === 'todo' || i.kind === 'question'),
  );
  if (openTodos.length === 0) {
    return { status: 'skipped', reason: 'no open todos' };
  }
  const todo = openTodos[openTodos.length - 1];

  // Session picker: skip any session that owns a claimed/in-progress item
  // (coordinator-visible busy state) or has an in-flight assistant turn
  // (opencode-visible busy state). First idle wins.
  let pickedSession: string | null = null;
  for (const sessionID of meta.sessionIDs) {
    const ownerId = ownerIdForSession(sessionID);
    const busyOnBoard = all.some(
      (i) =>
        i.ownerAgentId === ownerId &&
        (i.status === 'claimed' || i.status === 'in-progress'),
    );
    if (busyOnBoard) continue;
    const messages = await getSessionMessagesServer(sessionID, meta.workspace);
    if (messages.some(isAssistantInFlight)) continue;
    pickedSession = sessionID;
    break;
  }
  if (!pickedSession) {
    return { status: 'skipped', reason: 'no idle sessions' };
  }

  const sessionID = pickedSession;
  const ownerAgentId = ownerIdForSession(sessionID);

  // Claim. CAS protects against another coordinator / external caller
  // racing us to the same 'open' item. Empty fileHashes is acceptable here
  // because we'll record post-work hashes at commit time; drift detection
  // for concurrent claims lands in a later step when parallelism does.
  const claim = transitionStatus(swarmRunID, todo.id, {
    from: 'open',
    to: 'claimed',
    ownerAgentId,
    // Required by the commit action route but not by the store layer —
    // leaving empty is valid, commit will repopulate.
    fileHashes: null,
  });
  if (!claim.ok) {
    return { status: 'skipped', reason: `claim lost race: ${claim.currentStatus}` };
  }

  const start = transitionStatus(swarmRunID, todo.id, {
    from: 'claimed',
    to: 'in-progress',
  });
  if (!start.ok) {
    return { status: 'skipped', reason: `start lost race: ${start.currentStatus}` };
  }

  // Snapshot existing messages so we can diff "new since work-prompt".
  const before = await getSessionMessagesServer(sessionID, meta.workspace);
  const knownIDs = new Set(before.map((m) => m.info.id));

  const prompt = buildWorkPrompt(todo);
  try {
    await postSessionMessageServer(sessionID, meta.workspace, prompt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    transitionStatus(swarmRunID, todo.id, {
      from: 'in-progress',
      to: 'stale',
      note: `prompt-send failed: ${message.slice(0, 160)}`,
    });
    return { status: 'stale', sessionID, itemID: todo.id, reason: message };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const waited = await waitForNewAssistantTurn(
    sessionID,
    meta.workspace,
    knownIDs,
    deadline,
  );

  if (!waited.ok) {
    const reason = waited.reason === 'timeout' ? 'turn timed out' : 'turn errored';
    transitionStatus(swarmRunID, todo.id, {
      from: 'in-progress',
      to: 'stale',
      note: reason,
    });
    return { status: 'stale', sessionID, itemID: todo.id, reason };
  }

  const editedPaths = extractEditedPaths(waited.messages, waited.newIDs);

  // Hash whatever was edited. A turn that produced no edits (skip: / text
  // answer / q-reply) still commits to done — the todo was addressed, just
  // without a patch. That's a legitimate outcome for questions or no-op
  // todos and the board reflects it as `done` with empty fileHashes.
  const fileHashes: { path: string; sha: string }[] = [];
  for (const rel of editedPaths) {
    try {
      fileHashes.push({
        path: rel,
        sha: await sha7(path.resolve(meta.workspace, rel)),
      });
    } catch {
      // Edited then deleted, or path outside workspace (resolve() out-of-tree).
      // Skip — commit-time drift isn't what we're modeling here anyway.
    }
  }

  const done = transitionStatus(swarmRunID, todo.id, {
    from: 'in-progress',
    to: 'done',
    fileHashes: fileHashes.length > 0 ? fileHashes : null,
    setCompletedAt: true,
  });
  if (!done.ok) {
    // Something else moved it mid-flight. Surface the observed state so the
    // caller can re-read and decide.
    return {
      status: 'stale',
      sessionID,
      itemID: todo.id,
      reason: `done-transition lost: ${done.currentStatus}`,
    };
  }

  return { status: 'picked', sessionID, itemID: todo.id, editedPaths };
}
