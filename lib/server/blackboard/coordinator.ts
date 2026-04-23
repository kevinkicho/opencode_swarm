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
// Concurrency model: concurrent calls are safe IFF each call targets a
// distinct session via opts.restrictToSessionID. The auto-ticker uses this
// to fan out per-session tickers for parallelism (SWARM_PATTERNS.md §1
// Open questions → Blackboard parallelism). CAS at the SQL layer protects
// against two sessions racing on the same todo (the loser gets `skipped:
// claim lost race`). Calls without restrictToSessionID still use the
// "first idle session wins" picker and should NOT overlap — the map-reduce
// synthesis loop relies on that.
//
// No drift detection yet. When multi-agent parallelism grows teeth, switch
// to pre-snapshot SHAs at claim time and let the existing /commit action
// route handle the drift check.
//
// Server-only. Never imported from client code.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getRun } from '../swarm-registry';
import {
  abortSessionServer,
  getSessionMessagesServer,
  postSessionMessageServer,
} from '../opencode-server';
import { publishExports } from '../hmr-exports';
import { roleNamesBySessionID } from '@/lib/blackboard/roles';
import { listBoardItems, transitionStatus } from './store';
import { toFileHeat, type FileHeat } from '@/lib/opencode/transform';
import type { BoardItem } from '@/lib/blackboard/types';
import type { OpencodeMessage } from '@/lib/opencode/types';

// Shared key for HMR-resilient consumer lookups (see lib/server/hmr-exports.ts).
// Export so consumers can import it alongside the types.
export const COORDINATOR_EXPORTS_KEY = Symbol.for(
  'opencode_swarm.coordinator.exports',
);
export interface CoordinatorExports {
  // Forward-declare typeof — actual definitions below; TS hoists function
  // types so the declaration order works out.
  tickCoordinator: (
    swarmRunID: string,
    opts?: {
      restrictToSessionID?: string;
      excludeSessionIDs?: readonly string[];
    },
  ) => Promise<TickOutcome>;
  waitForSessionIdle: (
    sessionID: string,
    workspace: string,
    knownIDs: Set<string>,
    deadline: number,
  ) =>
    Promise<
      | { ok: true; messages: OpencodeMessage[]; newIDs: Set<string> }
      | { ok: false; reason: 'timeout' | 'error' }
    >;
}

const POLL_INTERVAL_MS = 1000;
// Raised from 5 min to 10 min after the 2026-04-23 overnight run showed
// substantive README-verification todos ("Verify CreditMarket EM bonds
// spread data rendering") legitimately running past 5 min — not zombies,
// just slow work involving multiple reads + a test file edit + a test
// run. The zombie auto-abort in the picker already handles truly-stuck
// sessions at 10 min, so the worker timeout matches that boundary.
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

// Zombie threshold for the session picker. opencode assistant turns can
// hang with no completed AND no error (see
// memory/reference_opencode_zombie_messages.md) — in-flight indefinitely,
// silently blocking dispatch because the picker skips any session with an
// active in-flight turn. After this many ms, the picker treats the turn
// as stale: auto-aborts it and dispatches to the session anyway. Chosen
// at 10 min because real turns on hefty directives can legitimately run
// 5+ min; shorter than that would trip on slow legitimate work.
const ZOMBIE_TURN_THRESHOLD_MS = 10 * 60_000;

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
  // Restrict the session picker to a single sessionID. When set, the tick
  // uses that session if idle, or returns skipped otherwise — it does not
  // fall back to other sessions. The auto-ticker passes this to fan out
  // one tick per session in parallel; map-reduce synthesis omits it so
  // any idle session can claim the synthesize item.
  restrictToSessionID?: string;
  // Exclude these sessions from the dispatch picker. Used by the
  // orchestrator-worker pattern to keep the orchestrator (session 0)
  // focused on planning while only workers (sessions 1..N) claim todos.
  // Applied before restrictToSessionID — a session in both is excluded.
  excludeSessionIDs?: readonly string[];
}

// Same pattern as planner.ts::sha7 — 7-char git-short SHA1 of file contents.
async function sha7(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  return createHash('sha1').update(buf).digest('hex').slice(0, 7);
}

// Stale-retry budget. When a worker times out or errors on a todo,
// instead of terminating the todo as `stale` forever, requeue it as
// `open` so another tick can pick it up. The retry count is stored in
// the todo's note — after MAX_STALE_RETRIES, the item stays stale.
//
// Why: a single transient failure (slow tool call, temporarily-offline
// upstream, hit a 5-min deadline mid-work) shouldn't drop the todo from
// the swarm's work queue. The user was explicit about wanting stale
// items to not "die silently."
const MAX_STALE_RETRIES = 2;
const RETRY_TAG_RE = /^\[retry:(\d+)\]\s*/;

function currentRetryCount(note: string | null | undefined): number {
  if (!note) return 0;
  const m = RETRY_TAG_RE.exec(note);
  return m ? Number(m[1]) : 0;
}

// Transition an in-progress item into either `open` (retry) or `stale`
// (final) based on accumulated retry count in the note field. Preserves
// the failure reason in the note so inspector / rail views still show
// why the previous attempt failed.
function retryOrStale(
  swarmRunID: string,
  item: BoardItem,
  reason: string,
): 'retry' | 'stale' {
  const retries = currentRetryCount(item.note);
  if (retries < MAX_STALE_RETRIES) {
    const nextNote = `[retry:${retries + 1}] ${reason}`.slice(0, 200);
    transitionStatus(swarmRunID, item.id, {
      from: 'in-progress',
      to: 'open',
      ownerAgentId: null,
      fileHashes: null,
      note: nextNote,
    });
    return 'retry';
  }
  transitionStatus(swarmRunID, item.id, {
    from: 'in-progress',
    to: 'stale',
    note: `[final after ${retries} retries] ${reason}`.slice(0, 200),
  });
  return 'stale';
}

// File-path-ish tokens inside a todo's content. Used to detect overlap
// with an in-progress item's content so two sessions don't trample each
// other's files. Matches: dir-ish (src/foo/bar), file-ish with common
// extensions, and bare basenames ≥4 chars with an extension. Tokens
// under 4 chars are skipped — "ts" / "js" would be noise.
const PATH_TOKEN_RE = /[a-zA-Z_][\w.-]*(?:\/[\w.-]+)+\/?|\b\w{4,}\.(?:ts|tsx|js|jsx|py|go|rs|md|css|html|json|yaml|yml|toml)\b/g;

function extractPathTokens(content: string): Set<string> {
  const out = new Set<string>();
  const matches = content.match(PATH_TOKEN_RE) ?? [];
  for (const m of matches) out.add(m.replace(/\\/g, '/').replace(/\/$/, ''));
  return out;
}

function pathOverlaps(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y) return true;
      if (x.startsWith(y + '/')) return true; // y is ancestor of x
      if (y.startsWith(x + '/')) return true; // x is ancestor of y
    }
  }
  return false;
}

// Stigmergy v1 — pheromone-weighted pick. Score a todo by summing the
// edit counts of heat entries whose path or containing dir or basename
// appears in the todo's content. Three match tiers:
//
//   * Full-path match (content includes `src/foo/bar.ts`): +2x count
//     — strong signal, the todo explicitly names the file
//   * Directory match (content includes `src/foo/` when h.path is
//     `src/foo/bar.ts`): +1x count — todo targets the dir that owns
//     this file. Covers the "fix everything in src/components/" case.
//   * Basename match (content includes `bar.ts`, len ≥ 4): +1x count
//     — weakest, covers the "edit bar.ts" case where h.path has a
//     different leading dir
//
// Basenames under 4 chars are skipped — matching "ts" or "js" would
// be noise. The picker sorts OPEN todos by this score ASC
// (exploratory bias — steer workers toward unexplored files) with
// createdAtMs ASC as the tiebreak. A todo with no file attribution
// scores 0 and falls back to oldest-first, which is the correct
// degenerate case.
function scoreTodoByHeat(content: string, heat: FileHeat[]): number {
  let score = 0;
  for (const h of heat) {
    const norm = h.path.replace(/\\/g, '/');
    const lastSlash = norm.lastIndexOf('/');
    const base = lastSlash >= 0 ? norm.slice(lastSlash + 1) : norm;
    const dirWithSlash = lastSlash >= 0 ? norm.slice(0, lastSlash + 1) : '';
    if (content.includes(h.path) || content.includes(norm)) {
      score += h.editCount * 2;
    } else if (dirWithSlash && content.includes(dirWithSlash)) {
      score += h.editCount;
    } else if (base.length >= 4 && content.includes(base)) {
      score += h.editCount;
    }
  }
  return score;
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

// How long has the oldest in-flight assistant turn been running? Returns 0
// when the session has no in-flight turns. Used by the session picker to
// distinguish legitimate long-running work from zombies.
function oldestInFlightAgeMs(messages: OpencodeMessage[]): number {
  let oldest: number | null = null;
  for (const m of messages) {
    if (!isAssistantInFlight(m)) continue;
    const created = m.info.time.created;
    if (typeof created !== 'number') continue;
    if (oldest === null || created < oldest) oldest = created;
  }
  if (oldest === null) return 0;
  return Date.now() - oldest;
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

  const all = listBoardItems(swarmRunID);
  const openTodos = all.filter(
    (i) =>
      i.status === 'open' &&
      (i.kind === 'todo' || i.kind === 'question' || i.kind === 'synthesize'),
  );
  if (openTodos.length === 0) {
    return { status: 'skipped', reason: 'no open todos' };
  }

  // Session picker: skip any session that owns a claimed/in-progress item
  // (coordinator-visible busy state) or has an in-flight assistant turn
  // (opencode-visible busy state). First idle wins. When restrictToSessionID
  // is set, only that session is considered — enables per-session fan-out
  // from the auto-ticker without requiring a second picker code path.
  //
  // We fetch every candidate session's messages here both for the busy
  // check and to feed toFileHeat for the stigmergy-weighted todo picker
  // below. Fetching once per tick keeps the fan-out cost linear in
  // sessionIDs.
  const excluded = new Set(opts.excludeSessionIDs ?? []);
  const sessionCandidates = opts.restrictToSessionID
    ? meta.sessionIDs.includes(opts.restrictToSessionID) &&
      !excluded.has(opts.restrictToSessionID)
      ? [opts.restrictToSessionID]
      : []
    : meta.sessionIDs.filter((sid) => !excluded.has(sid));
  const messagesByCandidate = new Map<string, OpencodeMessage[]>();
  let pickedSession: string | null = null;
  for (const sessionID of sessionCandidates) {
    const ownerId = ownerIdForSession(sessionID);
    const busyOnBoard = all.some(
      (i) =>
        i.ownerAgentId === ownerId &&
        (i.status === 'claimed' || i.status === 'in-progress'),
    );
    if (busyOnBoard) continue;
    const messages = await getSessionMessagesServer(sessionID, meta.workspace);
    messagesByCandidate.set(sessionID, messages);
    const inFlightAge = oldestInFlightAgeMs(messages);
    if (inFlightAge > 0) {
      if (inFlightAge < ZOMBIE_TURN_THRESHOLD_MS) {
        // Real in-flight work — skip this session for now.
        continue;
      }
      // Zombie: in-flight > threshold. Auto-abort and proceed to dispatch.
      // See memory/reference_opencode_zombie_messages.md — opencode turns
      // can hang without completed/error flags, silently blocking dispatch.
      // Fire-and-forget abort so the picker doesn't stall on a slow abort;
      // the next turn's post (postSessionMessageServer below) will wait for
      // the server to accept it regardless.
      console.log(
        `[coordinator] session ${sessionID.slice(-8)}: zombie turn (${Math.round(inFlightAge / 60_000)}m in-flight) — auto-aborting and dispatching`,
      );
      abortSessionServer(sessionID, meta.workspace).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[coordinator] session ${sessionID.slice(-8)}: auto-abort failed:`,
          message,
        );
      });
    }
    if (!pickedSession) pickedSession = sessionID;
  }

  // Work picker: stigmergy v1 exploratory bias. Score open todos by
  // heat-summed file matches in their content (see scoreTodoByHeat).
  // Ascending sort means low-heat (unexplored) todos get picked first;
  // ties break on oldest createdAtMs (preserves the pre-stigmergy
  // "oldest first" behavior when heat can't differentiate).
  //
  // Heat is derived from every session's patch parts in the run. At
  // v0 (observation-only) it was computed client-side; at v1 we also
  // need it server-side here. We already fetched the busy-check
  // messages above, so the only incremental cost is the merge.
  const allMessages = [...messagesByCandidate.values()].flat();
  const heat = toFileHeat(allMessages);
  const heatWeightedPick = heat.length > 0;
  const scored = openTodos.map((t) => ({
    todo: t,
    score: heatWeightedPick ? scoreTodoByHeat(t.content, heat) : 0,
  }));
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.todo.createdAtMs - b.todo.createdAtMs;
  });

  // Overlap avoidance: prefer todos whose parsed file/dir tokens
  // don't collide with any currently in-progress item's tokens. If
  // every candidate overlaps, fall back to the heat-weighted top
  // (can't deadlock — something has to move). Only kicks in when
  // at least one candidate is non-overlapping, so runs with
  // abstract todos (no paths in content) still pick normally.
  const inProgressTokens = all
    .filter((i) => i.status === 'in-progress' || i.status === 'claimed')
    .map((i) => extractPathTokens(i.content));
  const nonOverlap = scored.filter((s) => {
    if (inProgressTokens.length === 0) return true;
    const tokens = extractPathTokens(s.todo.content);
    if (tokens.size === 0) return true; // abstract todo — no overlap to measure
    return !inProgressTokens.some((other) => pathOverlaps(tokens, other));
  });
  const finalQueue = nonOverlap.length > 0 ? nonOverlap : scored;
  if (nonOverlap.length === 0 && inProgressTokens.length > 0 && scored.length > 0) {
    console.log(
      `[coordinator] all open todos overlap in-progress work — picking heat-top anyway`,
    );
  } else if (nonOverlap.length < scored.length) {
    console.log(
      `[coordinator] skipped ${scored.length - nonOverlap.length} todo(s) to avoid in-progress overlap`,
    );
  }
  const todo = finalQueue[0].todo;
  if (heatWeightedPick && scored[0].score !== scored[scored.length - 1].score) {
    // Log only when heat actually changed the order — diagnostic signal
    // that stigmergy fired. Quiet otherwise to avoid log spam on runs
    // where every todo maps to the same bucket of files.
    console.log(
      `[coordinator] heat-weighted pick: "${todo.content.slice(0, 50)}..." (score=${scored[0].score}, max=${scored[scored.length - 1].score})`,
    );
  }

  if (!pickedSession) {
    return {
      status: 'skipped',
      reason: opts.restrictToSessionID
        ? `session ${opts.restrictToSessionID.slice(-8)} busy or unknown`
        : 'no idle sessions',
    };
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
  // Pattern-aware role tagging on the worker's prompt. When the run has
  // pinned roles (orchestrator-worker, role-differentiated, debate-judge,
  // critic-loop), the worker's assistant turn carries info.agent={role}
  // so the roster + board chips show the role label rather than the
  // default "build" opencode seeds on session create. Self-organizing
  // patterns get an empty map → default agent name.
  const roleBySID = roleNamesBySessionID(meta);
  const role = roleBySID.get(sessionID);
  try {
    await postSessionMessageServer(sessionID, meta.workspace, prompt, {
      agent: role,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outcome = retryOrStale(swarmRunID, todo, `prompt-send failed: ${message.slice(0, 160)}`);
    return { status: 'stale', sessionID, itemID: todo.id, reason: `${outcome}: ${message}` };
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
    const outcome = retryOrStale(swarmRunID, todo, reason);
    return { status: 'stale', sessionID, itemID: todo.id, reason: `${outcome}: ${reason}` };
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

// Publish to globalThis so HMR-replaced modules propagate to existing
// consumers (auto-ticker's setInterval callbacks, map-reduce's
// runMapReduceSynthesis, council's runCouncilRounds) without requiring
// those consumers to restart. See lib/server/hmr-exports.ts for the
// rationale and pattern.
publishExports<CoordinatorExports>(COORDINATOR_EXPORTS_KEY, {
  tickCoordinator,
  waitForSessionIdle,
});
