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

// How long the session must be silent (no new activity, all turns completed)
// before we treat it as "done". opencode emits one assistant message per
// step (read → todowrite → wrap-up text …), each with its own `completed`
// timestamp. A poll that catches the session between steps would see every
// existing turn completed yet still have more work coming. 2s has empirically
// covered the inter-step gap observed in e2e runs (inter-message creation
// gap is typically <100ms but the buffer gives headroom for slower
// backend flushes).
const SESSION_IDLE_QUIET_MS = 2000;

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

// opencode reports absolute paths in `patch.files` (e.g. on Windows,
// `C:/Users/.../components/foo.tsx`). The board stores fileHashes for
// cross-run comparison — absolute host paths make those records useless
// if the repo ever moves. Relativize against the run's workspace and
// normalize to forward slashes; fall back to the absolute path if the
// edit landed outside the workspace (e.g. a shared config), since we'd
// rather record something truthful than pretend an out-of-tree edit is
// local.
function relativizeToWorkspace(workspace: string, p: string): string {
  const rel = path.relative(workspace, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return p.replace(/\\/g, '/');
  }
  return rel.replace(/\\/g, '/');
}

function buildWorkPrompt(item: BoardItem): string {
  // Synthesize items carry a complete, self-contained prompt (member drafts
  // already embedded by the caller). Wrapping them in the blackboard-edit
  // preamble would both mangle the synthesis directive and mislead the
  // synthesizer into editing files. Post the content verbatim and let the
  // CAS lifecycle handle progression.
  if (item.kind === 'synthesize') return item.content;
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

// Poll until the session has finished processing whatever prompt we just
// posted. A naive "first completed assistant message" check races
// multi-step responses: opencode commits msg_1 (tool:read) → msg_2
// (tool:todowrite) → msg_3 (wrap-up text) as separate assistant records,
// each with its own completed timestamp. The planner and coordinator both
// want the FULL response, not the first step. Shared here so fixes land
// in one place.
//
// Exit conditions:
//   ok=true   every new assistant message is completed, AND at least
//             SESSION_IDLE_QUIET_MS has passed since the most recent
//             completion (so we're not mid-sequence).
//   ok=false  any new assistant message has an `error`; or the deadline
//             fires before the session goes idle.
export async function waitForSessionIdle(
  sessionID: string,
  workspace: string,
  knownIDs: Set<string>,
  deadline: number,
): Promise<
  | { ok: true; messages: OpencodeMessage[]; newIDs: Set<string> }
  | { ok: false; reason: 'timeout' | 'error' }
> {
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const messages = await getSessionMessagesServer(sessionID, workspace);
    const newIDs = new Set(
      messages.filter((m) => !knownIDs.has(m.info.id)).map((m) => m.info.id),
    );
    const newAssistants = messages.filter(
      (m) => newIDs.has(m.info.id) && m.info.role === 'assistant',
    );
    if (newAssistants.length === 0) continue;

    if (newAssistants.some((m) => !!m.info.error)) {
      return { ok: false, reason: 'error' };
    }

    // Any turn still running? Keep polling.
    if (newAssistants.some((m) => !m.info.time.completed)) continue;

    // All turns completed; require a quiet window so we don't catch a
    // between-step state where the next message is about to be created.
    const lastCompletedAt = Math.max(
      ...newAssistants
        .map((m) => m.info.time.completed)
        .filter((t): t is number => t != null),
    );
    if (Date.now() - lastCompletedAt < SESSION_IDLE_QUIET_MS) continue;

    return { ok: true, messages, newIDs };
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

  // Work picker: oldest open pickable item wins. Oldest = lowest createdAtMs,
  // which is the bottom of listBoardItems' newest-first output. `synthesize`
  // is claimable exactly like a todo — the only behavioral difference is the
  // verbatim-content prompt shape (see buildWorkPrompt).
  const all = listBoardItems(swarmRunID);
  const openTodos = all.filter(
    (i) =>
      i.status === 'open' &&
      (i.kind === 'todo' || i.kind === 'question' || i.kind === 'synthesize'),
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
  const waited = await waitForSessionIdle(
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

  const rawEditedPaths = extractEditedPaths(waited.messages, waited.newIDs);
  const editedPaths = rawEditedPaths.map((p) =>
    relativizeToWorkspace(meta.workspace, p),
  );

  // Hash whatever was edited. A turn that produced no edits (skip: / text
  // answer / q-reply) still commits to done — the todo was addressed, just
  // without a patch. That's a legitimate outcome for questions or no-op
  // todos and the board reflects it as `done` with empty fileHashes.
  //
  // `rel` here may be relative (the common case — an in-workspace edit) or
  // absolute (out-of-tree edit, already normalized to forward slashes).
  // path.resolve handles both: an absolute arg wins over the base.
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
