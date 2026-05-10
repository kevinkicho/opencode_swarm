//
// The planner-sweep orchestrator. Steps:
// 1. Resolve run + session, guard against double-sweep on a populated
// board (unless overwrite=true).
// 2. Build the planner prompt (./prompt.ts) — directive + README +
// board context + tier preamble.
// 3. Dispatch via postSessionMessageServer with `agent: 'plan'` so the
// user can pin a smarter model in opencode.json.
// 4. Wait for the assistant turn to complete, abort on timeout/silence
// to stop runaway-token leaks (incident 2026-04-22: 5M tokens
// across 70+ orphaned todowrite calls).
// 5. Parse latest todowrite from new messages (./parsers.ts).
// 6. Insert each non-vague todo as a board item (kind='todo' or
// kind='criterion'); dispatch role-notes to matching role sessions.
// 7. Record plan-revision delta (logs added / removed / rephrased so
// the strategy tab can render sweep history).
//
// HMR-resilient: the result is published via publishExports so the
// auto-ticker's attemptReSweep + runPeriodicSweep get the freshest
// implementation without restarting the ticker.

import 'server-only';

import { roleNamesBySessionID } from '@/lib/blackboard/roles';
import { getRun } from '../../swarm-registry';
import {
 abortSessionServer,
 getSessionMessagesServer,
 postSessionMessageServer,
} from '../../opencode-server';
import { publishExports } from '../../hmr-exports';
import { TIER_PLANNER_MODELS } from '@/lib/swarm-patterns';
import { waitForSessionIdle } from '../coordinator';
import { recordPartialOutcome } from '../../degraded-completion';
import { insertBoardItem, listBoardItems } from '../store';
import {
 computeDelta,
 getLatestRevisionContents,
 nextRoundForRun,
 recordPlanRevision,
} from '../plan-revisions';
import type { BoardItem } from '@/lib/blackboard/types';

import { mintItemId } from '../item-ids';
import { resetSessionForClaim } from '../coordinator/dispatch/claim-context';
import { saveBoardSnapshot } from './prompt-delta';
import { invalidateBoardView } from '../board-view';
import { getCachedReadme, setCachedLessons, invalidatePlannerCache } from './cache';
import {
  buildPlannerBoardContext,
  buildPlannerPrompt,
  stripFillerWords,
} from './prompt';
import { latestTodosFrom } from './parsers';
import { validatePlannerOutput } from './validate-output';
import { buildLessonsBlock } from '@/lib/server/lesson-inject';
import { discoverPackages, buildPackageMap } from '../../workspace-packages';
import {
 buildAllFilteredSummary,
 buildPlannerPartialSummary,
 buildZeroTodoSummary,
 extractAssistantExcerpt,
 snapshotBoard,
} from './summaries';

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
// - 90s (original). 2026-04-22 incident: kBioIntelBrowser04052026 took
// 31 exploratory turns before todowrite. 90s threw the wait-loop but
// left the session running; burned 5M tokens in 70+ duplicate
// todowrite calls before a human noticed.
// - 5min (2026-04-22). Sized against opencode-zen/go latencies. Worked
// fine until we moved to ollama-cloud models.
// - 15min (2026-04-24). Ollama cloud models (glm-5.1:cloud, gemma4:31b-
// cloud, nemotron-3-super:cloud) have materially higher cold-start
// and per-turn latency than zen/go — an observation from the first
// multi-pattern ollama test run where BOTH glm-5.1 and nemotron-3-
// super hit the 5-min cap mid-exploration. The planner emits 6-15
// todos after up to 10 exploratory tool calls; at ~30-60s per turn
// on ollama cloud, 15min is the new realistic ceiling. The abort-on-
// timeout path below still catches genuine hangs.
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export interface PlannerSweepResult {
  items: BoardItem[];
  sessionID: string;
  planMessageID: string | null;
  // True when the planner called todowrite but every proposed item was
  // dropped by the validation loop (vague criteria filter + dedup guard).
  // Callers (auto-ticker sweep, orchestrator-worker kickoff) use this to
  // distinguish "planner produced nothing" from "planner produced work
  // that was all filtered" — the latter signals a stuck loop.
  filteredAll?: boolean;
}

// Returns true when the criterion text is concrete enough for the
// auditor to verdict against. False on:
// - too short (< MIN_CRITERION_CHARS)
// - matches a "vague directive" shape (`make X better`, `improve X`,
// `polish X`, `clean up X`, `fix things`, `update Y`)
// Conservative — letting marginal criteria through is fine; the goal
// is to catch the obvious failures the planner sometimes emits when
// it's tired (long sweep, run nearing budget).
const MIN_CRITERION_CHARS = 20;
const VAGUE_CRITERION_RE =
  /^\s*(make|improve|polish|clean\s*up|fix|update|tighten|tidy|refine)\s+\w+\s+(better|good|nice|clean|right|proper|solid|tidy)\s*\.?$/i;

// Strip planner-internal prefixes like [files:a.ts] or [role:build]
// so dedup compares the substantive content, not the metadata envelope.
function stripContentPrefix(s: string): string {
  return s.replace(/^\[[^\]]*\]\s*/, '').trim();
}

// Jaccard-ish token overlap between two strings. Returns 0-1 where 1
// means "identical token set". Used to suppress duplicate proposals
// where the planner re-words an existing item slightly differently.
function tokenOverlap(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().split(/\s+/).filter(Boolean));
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const t of sa) {
    if (sb.has(t)) shared += 1;
  }
  // Symmetric: overlap = shared / min(|a|,|b|). Two short strings
  // that share all tokens still score high; a long string matching
  // a short one gets penalized by the min denominator.
  return shared / Math.min(sa.size, sb.size);
}
// Sub-patterns also caught: a criterion that's just a bare imperative
// without a verifiable condition. We don't try to detect every shape;
// the regex above + length floor catches the common bad ones.
export function isViableCriterion(content: string): boolean {
 if (content.length < MIN_CRITERION_CHARS) return false;
 if (VAGUE_CRITERION_RE.test(content.trim())) return false;
 return true;
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
  // Ambition ratchet: when the planner re-sweeps at a higher tier,
  // this passes the tier number so the prompt scales its ambition
  // accordingly. Tier 1 = bugs/polish (default), 2 = refactor/extract,
  // 3 = cross-cutting, 4+ = architectural/new features.
  escalationTier?: number;
  // Internal: set true on retry attempts to prevent infinite recursion.
  _retry?: boolean;
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
  const refreshedSessionID = await resetSessionForClaim(
    swarmRunID,
    sessionID,
    meta.workspace,
  ).catch((err) => {
    console.warn(
      `[planner] session reset failed for ${sessionID.slice(-8)} — ` +
      `falling back to existing session; error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return sessionID;
  });

 // Snapshot existing messages so we can diff "new since sweep". opencode's
 // /message endpoint returns full history with no tail param, so we track
 // IDs client-side.
  const before = await getSessionMessagesServer(refreshedSessionID, meta.workspace);
 const knownIDs = new Set(before.map((m) => m.info.id));

 const boardContext = opts.includeBoardContext
 ? buildPlannerBoardContext(swarmRunID)
 : undefined;
 // includeReadme defaults to true — project vision should anchor every
 // sweep. The READ itself is cheap (~one filesystem call, single-digit
 // ms) and the prompt-token cost is offset by saving the planner a
 // mandatory tool call to read it.
  const readme =
  opts.includeReadme === false ? null : await getCachedReadme(meta.workspace);
  const packages = await discoverPackages(meta.workspace);
  const packageMap = buildPackageMap(packages);
    const lessons = await buildLessonsBlock(meta.workspace);
    if (lessons) setCachedLessons(meta.workspace, lessons);
   const rawPrompt = buildPlannerPrompt(
   meta.directive,
   boardContext,
   readme,
   opts.escalationTier,
   packageMap,
   );
 const prompt = lessons ? lessons + '\n\n' + rawPrompt : rawPrompt;
 // Planner dispatch. Always route through opencode's `plan` agent —
 // the agent carries tool definitions (todowrite, read, grep, etc.)
 // into the model dispatch. Without an agent, opencode dispatches
 // without tool definitions, so even tool-capable models like
 // opencode-go/deepseek-v4-pro produce prose-only assistant turns.
 //
 // Empirically verified 2026-04-27: same model with `agent:'build'`
 // tool-calls correctly; with no agent (just `model`), only text. The
 // pre-2026-04-27 shape `agent: pinnedModel ? undefined : 'plan'`
 // dropped the agent in the pinned-model path, producing the Q34-shape
 // failure: model generates fluent prose, never invokes todowrite,
 // board stays empty, workers idle. Run run_mohrfodp_xw8ht1 caught
 // it: 16 completed assistant turns, 0 tool calls, 631K tokens burned.
 //
 // Team-model pinning (meta.teamModels[0]) layers on TOP: when set,
 // opencode's `model` field overrides the agent's configured default
 // model. So user picking `opencode-go/deepseek-v4-pro` routes through
 // `plan` for tool definitions but uses deepseek for inference.
 const pinnedModel = meta.teamModels?.[0] ?? (
   opts.escalationTier
     ? TIER_PLANNER_MODELS[Math.min((opts.escalationTier || 1) - 1, TIER_PLANNER_MODELS.length - 1)]
     : undefined
 );
 if (!meta.teamModels?.[0] && opts.escalationTier && opts.escalationTier > 2) {
   console.log(`[planner] tier ${opts.escalationTier}: using GLM (strong model) for cross-cutting work`);
 }
  await postSessionMessageServer(refreshedSessionID, meta.workspace, prompt, {
 agent: 'plan',
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
  refreshedSessionID,
 meta.workspace,
 knownIDs,
 deadline,
 { silentErrorMs: 360_000 },  // SAAM 6.1: planner sweeps take 90-240s
 );
 if (!waited.ok) {
 // Critical: abort the opencode session before re-throwing. Without this,
 // a timed-out session keeps streaming turns into the void — the planner's
 // poll loop has exited so nothing consumes todowrite calls, but the model
 // has no stop condition. Incident 2026-04-22 burned 5M tokens across 70+
 // orphaned todowrite calls before a human noticed.
 try {
  await abortSessionServer(refreshedSessionID, meta.workspace);
  } catch (abortErr) {
  const detail =
  abortErr instanceof Error ? abortErr.message : String(abortErr);
  console.warn(
  `[planner] abort-on-timeout failed for ${refreshedSessionID}: ${detail} — ` +
 `session may keep burning tokens`,
 );
 }
 // #88 — record a partial-outcome finding before re-throwing so the
 // run carries a durable record of what survived the sweep. Today's
 // #73 plumbing only wraps iterative orchestrator LOOPS; this path
 // is the planner sweep, used by every blackboard-family pattern
 //. Without
 // this, a planner-side silent abort makes the run go to status=error
 // with NO finding row — the run "just died" with nothing to read on
 // the board.
  recordPartialOutcome(swarmRunID, {
  pattern: meta.pattern,
  phase: 'planner-sweep',
  reason: waited.reason,
  summary: buildPlannerPartialSummary(swarmRunID, refreshedSessionID, waited.reason),
  });
  // MC Insight 4: retry once with minimal prompt (no README) on
  // retryable errors. Reduces the 7-10% zero-output rate to ~1-2%.
  if (!opts._retry && (waited.reason === 'timeout' || waited.reason === 'silent' || waited.reason === 'tool-loop' || waited.reason === 'error')) {
    console.warn(`[planner] sweep failed with ${waited.reason} — retrying once with minimal prompt`);
    try {
      return await runPlannerSweep(swarmRunID, { ...opts, includeReadme: false, _retry: true });
    } catch (retryErr) {
      const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      console.warn(`[planner] retry also failed: ${msg}`);
      throw new Error(`planner sweep failed after retry: ${msg.slice(0, 120)}`);
    }
  }
  if (waited.reason === 'timeout') {
 throw new Error(`planner sweep timed out after ${timeoutMs}ms`);
 }
 if (waited.reason === 'silent') {
 // F1 watchdog tripped — provider almost certainly unreachable.
 // Surface a different message so the surrounding telemetry can
 // distinguish "model burned 15 min then quit" from "no response
 // ever started." Helps stop wasting a 15-min retry on a network
 // failure.
 throw new Error('planner sweep aborted: session went silent (provider unreachable?)');
 }
 if (waited.reason === 'provider-unavailable') {
 // F4 probe tripped — ollama daemon is down. Distinct error message
 // because the operator's response is different (restart ollama vs.
 // diagnose model hang).
 throw new Error('planner sweep aborted: ollama daemon unreachable');
 }
 if (waited.reason === 'tool-loop') {
 // 6.12 tool-loop detector tripped — model burned the turn
 // retrying a structurally-broken tool call. Surface distinctly.
 throw new Error('planner sweep aborted: tool-loop (model stuck on a tool error)');
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
 const excerpt = extractAssistantExcerpt(waited.messages, waited.newIDs);
 try {
 const round = nextRoundForRun(swarmRunID);
 recordPlanRevision({
 swarmRunID,
 round,
 added: [],
 removed: [],
 rephrased: [],
 boardSnapshot: snapshotBoard(swarmRunID),
 excerpt,
 planMessageId: null,
 });
 } catch (err) {
 console.warn(
 `[planner] plan-revision log failed (no-op sweep): ${
 err instanceof Error ? err.message : String(err)
 }`,
 );
 }
 // #99 — operator-visible finding for "planner returned no todos".
 // See buildZeroTodoSummary for the full context + remediation hint.
 recordPartialOutcome(swarmRunID, {
 pattern: meta.pattern,
 phase: 'planner-sweep (zero-todo)',
 reason: 'no-todowrite-call',
 summary: buildZeroTodoSummary(excerpt),
 });
  return { items: [], sessionID: refreshedSessionID, planMessageID: null };
  }

  // Planner v2: validate output quality before board insertion.
  // Reject and re-prompt if the planner produced mostly duplicates or vague criteria.
  const existingContent = listBoardItems(swarmRunID)
    .filter((i) => i.kind !== 'criterion')
    .map((i) => i.content);
  const proposedItems = latest.todos.map((t) => ({
    content: t.content.trim(),
    isCriterion: t.isCriterion || false,
  }));
  const validation = validatePlannerOutput(proposedItems, existingContent);

  if (!validation.ok) {
    console.warn(`[planner] output validation failed: ${validation.message}`);

    const feedbackPrompt = [
      '## ⚠ FEEDBACK: Your last todowrite was rejected',
      '',
      `Quality issues:`,
      validation.duplicates > 0
        ? `- ${validation.duplicates} item(s) were DUPLICATES of existing board items`
        : '',
      validation.vagueCriteria > 0
        ? `- ${validation.vagueCriteria} criterion/a were too VAGUE (must be concrete and verifiable)`
        : '',
      '',
      'Re-submit your todowrite with:',
      '- Unique items that do NOT duplicate what is already on the board',
      '- Criteria that are concrete, measurable, and at least 20 characters',
      '(Keep any valid items from your previous attempt.)',
    ]
      .filter(Boolean)
      .join('\n');

    await postSessionMessageServer(
      refreshedSessionID,
      meta.workspace,
      feedbackPrompt,
      {
        agent: 'plan',
        model: pinnedModel,
      },
    );

    const retryKnownIDs = new Set(knownIDs);
    for (const id of waited.newIDs) retryKnownIDs.add(id);
    const retryDeadline = Date.now() + 120_000;
    const retryWait = await waitForSessionIdle(
      refreshedSessionID,
      meta.workspace,
      retryKnownIDs,
      retryDeadline,
      { silentErrorMs: 180_000 },
    );

    if (!retryWait.ok) {
      console.warn(
        `[planner] re-prompt failed after validation — falling through to original output`,
      );
    } else {
      const retryTodos = latestTodosFrom(retryWait.messages, retryWait.newIDs);
      if (retryTodos) {
        latest.todos = retryTodos.todos;
        latest.messageId = retryTodos.messageId;
      }
    }
  }

  // Spread createdAtMs by 1ms per item so the board's ORDER BY on
  // created_ms produces a stable order within a sweep. Without this,
  // every item in a batch shares Date.now() and ties fall through to
  // listBoardItems' id ASC secondary sort — which works, but this way
  // the timestamps themselves carry authoring order, which keeps the
  // preview UI (ordered by createdAtMs in JS land) consistent without
  // needing to also know about the SQL tiebreaker.
  const baseMs = Date.now();
  const startT = Date.now();
  const items: BoardItem[] = [];
  let offset = 0;
  let droppedCriteria = 0;
  let droppedDuplicates = 0;
  // Pre-compute existing board content for dedup. Strip prefixes so
  // comparisons work on substantive content, not [files:...] tags.
  // Also store expectedFiles per existing item for file-aware threshold.
  const existingItems = listBoardItems(swarmRunID).filter((i) => i.kind !== 'criterion');
  const existingEntries = existingItems.map((i) => ({
    content: stripContentPrefix(i.content),
    files: i.expectedFiles ?? [],
  }));
  // dispatch after the board-insert loop so they don't get tangled up
  // with createdAtMs offsets or revision logging.
  const roleNotes: Array<{ role: string; text: string }> = [];
  for (const raw of latest.todos) {
  if (raw.roleNote && raw.content.trim()) {
    roleNotes.push({ role: raw.roleNote, text: raw.content.trim() });
    continue;
  }
  const content = raw.content.trim();
  if (!content) continue;
  // Dedup guard: skip proposals that substantially overlap with
  // existing board items (done, open, claimed, in-progress).
  // The planner prompt already says "do NOT re-propose" but LLMs
  // don't reliably follow negative instructions — the 2026-05-07
  // run mouzkzpy showed sweeps 2-4 re-proposing already-done work.
  // P2: strip filler words before dedup so semantic near-duplicates
  // like "Fix the stuck-check" vs "Fix stuck-check in auto-ticker"
  // are caught. Also lower threshold from 0.6 to 0.5 when both
  // items share target files — same-file proposals are more likely
  // to be the same work rephrased.
  const cleanContent = stripFillerWords(stripContentPrefix(content));
  const proposedFiles = raw.expectedFiles ?? [];
  const isDuplicate = existingEntries.some((entry) => {
    const cleaned = stripFillerWords(entry.content);
    const overlap = tokenOverlap(cleanContent, cleaned);
    if (overlap >= 0.6) return true;
    // P2-medium: lower threshold to 0.5 when items share expected files.
    if (overlap >= 0.5 && proposedFiles.length > 0 && entry.files.length > 0) {
      const shareFile = proposedFiles.some((f) => entry.files.includes(f));
      if (shareFile) return true;
    }
    return false;
  });
  if (isDuplicate && !raw.isCriterion) {
    console.warn(
      `[planner] dropping duplicate proposal: "${content.slice(0, 80)}${content.length > 80 ? '…' : ''}"`,
    );
    droppedDuplicates += 1;
    continue;
  }
  // Vague criteria ("make the app better") get UNCLEAR-forever from
 // the auditor and clutter the contract. Drop them silently with a
 // WARN; the planner can re-emit on the next sweep.
 if (raw.isCriterion && !isViableCriterion(content)) {
 console.warn(
 `[planner] dropping vague criterion: "${content}"`,
 );
 droppedCriteria += 1;
 continue;
 }
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
  sourceDrafts: raw.sourceDrafts,
  createdAtMs: baseMs + offset,
  });
  existingEntries.push({ content: stripContentPrefix(content), files: raw.expectedFiles ?? [] });
 offset += 1;
 items.push(item);
 }
  const elapsedMs = Date.now() - startT;
  const criteriaCount = items.filter((i) => i.kind === 'criterion').length;
  console.log(
    JSON.stringify({
      event: 'planner-sweep-complete',
      swarmRunID,
      itemCount: items.length,
      criteriaCount,
      droppedCriteriaCount: droppedCriteria,
      droppedDuplicates,
      elapsedMs,
    }),
  );

  // #99 — operator-visible finding for "todowrite called but every
  // item dropped during validation". See buildAllFilteredSummary for
  // context + the distinct fix path vs the zero-todo case.
  if (items.length === 0 && latest.todos.length > 0) {
  recordPartialOutcome(swarmRunID, {
    pattern: meta.pattern,
    phase: 'planner-sweep (filtered-all-todos)',
    reason: `dropped=${droppedCriteria}/${latest.todos.length}`,
    summary: buildAllFilteredSummary(latest.todos.length, droppedCriteria),
  });
  }

  const filteredAll = items.length === 0 && latest.todos.length > 0;

 // after the board insert. Each note is posted to the matching
 // role's session as a clarification message. Failures log and
 // continue — a missed note doesn't justify aborting the sweep.
 if (roleNotes.length > 0) {
 const sidByRole = new Map<string, string>();
 for (const [sid, role] of roleNamesBySessionID(meta).entries()) {
 if (!sidByRole.has(role)) sidByRole.set(role, sid);
 }
 await Promise.allSettled(
 roleNotes.map(async (note) => {
 const sid = sidByRole.get(note.role);
 if (!sid) {
 console.warn(
 `[planner] role-note for unknown role '${note.role}' dropped`,
 );
 return;
 }
 const prompt = [
 `## Role-clarification from the planner`,
 ``,
 `The planner has refined your role's focus for this run. Apply`,
 `this guidance to the next todo you claim:`,
 ``,
 note.text,
 ``,
 `(This is a clarification message, not a todo — keep working`,
 `from the board as usual.)`,
 ].join('\n');
 try {
 // 2026-04-25 fix: dropped `agent: note.role`. Same silent-drop
 // root cause as POSTMORTEMS/2026-04-25-agent-name-silent-drop.md.
 // Role-note dispatches were unreachable for any role outside
 // opencode's built-in agent list — basically everything except
 // 'plan'. Now they land reliably.
 await postSessionMessageServer(sid, meta.workspace, prompt, {});
 console.log(
 `[planner] dispatched role-note to ${note.role} (${sid.slice(-8)}): "${note.text.slice(0, 80)}${note.text.length > 80 ? '…' : ''}"`,
 );
 } catch (err) {
 console.warn(
 `[planner] role-note post to ${note.role} (${sid.slice(-8)}) failed:`,
 err instanceof Error ? err.message : String(err),
 );
 }
 }),
 );
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

  // Save board snapshot for delta-based prompt caching on the next sweep.
  // After this sweep's items land on the board, the next re-sweep gets
  // only the items added/changed since this point.
  saveBoardSnapshot(swarmRunID);
  invalidateBoardView(swarmRunID);

   return { items, sessionID: refreshedSessionID, planMessageID: latest.messageId, filteredAll };
}

// HMR-resilient publish — see lib/server/hmr-exports.ts. auto-ticker's
// attemptReSweep + runPeriodicSweep both read runPlannerSweep via this
// slot so edits to the planner prompt / timeout / etc. take effect
// without needing to restart the ticker.
publishExports<PlannerExports>(PLANNER_EXPORTS_KEY, { runPlannerSweep });
