// Anti-busywork critic gate — companion layer to the ambition ratchet.
//
// When a blackboard-family run opts in via `enableCriticGate: true`, the
// coordinator calls `reviewWorkerDiff` before transitioning a claimed
// todo to `done`. A dedicated critic opencode session (spawned once at
// run creation, reused for every review) receives a small self-contained
// prompt naming the mission, the todo, and what the worker produced.
// The critic replies with VERDICT: SUBSTANTIVE or VERDICT: BUSYWORK +
// a one-line reason.
//
// Busywork verdicts transition the item to `stale` with a
// `[critic-rejected] {reason}` note instead of `done`; retry-stale can
// revive the item and a future attempt may land substantive work. The
// worker session itself is untouched — we don't send the rejection
// back into the worker, since the retry-stale path already lets the
// planner re-propose the work from scratch when it reopens.
//
// Design notes:
// - *Fail-open.* If the critic session 409s, times out, or returns an
//   unparseable reply, we log and treat it as substantive. Never block
//   a commit on a critic malfunction — that would be worse than no
//   critic at all.
// - *Per-run mutex.* Every session's commit path races to use the same
//   critic session; opencode doesn't queue concurrent prompts, so we
//   serialize reviews per swarmRunID here. The mutex is in-memory —
//   HMR/restart clears it, which is fine (worst case: one review races
//   across a reload and falls through to fail-open).
// - *Small prompt footprint.* The critic session's context grows with
//   every review. We keep each review prompt small (~200 lines max) so
//   a run with hundreds of reviews still fits comfortably. When context
//   eventually matters, the follow-up is a fresh critic session per run
//   tier, not per review.
//
// See SWARM_PATTERNS.md "Tiered execution" companion layer #1 and
// memory/project_ambition_ratchet.md for the decision context.

import {
  abortSessionServer,
  getSessionMessagesServer,
  postSessionMessageServer,
} from '../opencode-server';
import { waitForSessionIdle } from './coordinator';
import type { BoardItem } from '../../blackboard/types';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_WORKER_TEXT_BYTES = 4_000;
const MAX_EDITED_PATHS = 20;

export type CriticVerdict = 'substantive' | 'busywork' | 'unclear';

export interface CriticReviewInput {
  swarmRunID: string;
  criticSessionID: string;
  workspace: string;
  directive: string | undefined;
  todo: BoardItem;
  editedPaths: string[];
  workerAssistantText: string;
  timeoutMs?: number;
}

export interface CriticReviewResult {
  verdict: CriticVerdict;
  reason: string;
  rawReply?: string;
}

// Per-run mutex for critic session access. opencode rejects concurrent
// prompts on the same session; without serialization, two worker ticks
// committing at once would both try to post to the critic and one would
// 409. The second would fail-open (accept) and we'd miss its review.
const criticLocks = new Map<string, Promise<unknown>>();

async function withCriticLock<T>(
  swarmRunID: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = criticLocks.get(swarmRunID) ?? Promise.resolve();
  // Chain via catch+then so a prior rejection doesn't poison the chain —
  // each review runs after the prior one settles regardless of outcome.
  const next = prior.then(fn, fn) as Promise<T>;
  criticLocks.set(swarmRunID, next);
  try {
    return await next;
  } finally {
    if (criticLocks.get(swarmRunID) === next) {
      criticLocks.delete(swarmRunID);
    }
  }
}

function buildCriticPrompt(input: CriticReviewInput): string {
  const { directive, todo, editedPaths, workerAssistantText } = input;

  const capped = workerAssistantText.length > MAX_WORKER_TEXT_BYTES
    ? workerAssistantText.slice(0, MAX_WORKER_TEXT_BYTES) + '\n[… truncated]'
    : workerAssistantText;
  const pathList = editedPaths.length === 0
    ? '  (none — worker turn produced no file edits)'
    : editedPaths.slice(0, MAX_EDITED_PATHS).map((p) => `  - ${p}`).join('\n') +
      (editedPaths.length > MAX_EDITED_PATHS
        ? `\n  [… ${editedPaths.length - MAX_EDITED_PATHS} more paths omitted]`
        : '');

  return [
    'You are a code-review critic for an autonomous swarm run. Each message I',
    'send you is a self-contained review request — do not carry context across',
    'messages. Your job: judge whether the worker did SUBSTANTIVE work toward',
    "the mission, or BUSYWORK (fake progress that wastes tokens).",
    '',
    '## Mission',
    directive?.trim() || '(no directive recorded)',
    '',
    '## The todo the worker claimed',
    todo.content,
    '',
    '## What the worker produced',
    '',
    'Files edited:',
    pathList,
    '',
    "Worker's summary of the turn:",
    '',
    capped || '(worker produced no text output)',
    '',
    '## Anti-busywork heuristics',
    'The following patterns are BUSYWORK unless the worker can demonstrate',
    'genuine information gain:',
    '- Adding tests for trivial helpers / getters / already-tested code.',
    '- Renaming / reformatting / comment-polish with no behavioral change.',
    '- "Verifying X still works" — if nothing was changed, nothing was verified.',
    '- Splitting one file into three without reducing complexity.',
    '- Expanding a README section from 3 lines to 30 with no new information.',
    '',
    'SUBSTANTIVE work: implements a feature the mission calls for, fixes a',
    'real bug, reduces load-bearing complexity, adds ground-truth tests',
    "(not trivial ones), wires an external data source, or produces output",
    "the project's users (not just the test runner) would care about.",
    '',
    '## Your reply format',
    'Reply with EXACTLY ONE LINE matching one of these templates:',
    '  VERDICT: SUBSTANTIVE — <one-line reason>',
    '  VERDICT: BUSYWORK — <one-line reason, what would have been better>',
    '',
    'No preamble, no exploration, no tool calls. Reply now.',
  ].join('\n');
}

const VERDICT_RE = /^\s*VERDICT:\s*(SUBSTANTIVE|BUSYWORK)\b\s*(?:[—:-]\s*(.+))?\s*$/im;

function parseVerdict(text: string): { verdict: CriticVerdict; reason: string } {
  const m = VERDICT_RE.exec(text);
  if (!m) {
    return {
      verdict: 'unclear',
      reason: `critic reply did not match VERDICT format: ${text.slice(0, 120)}`,
    };
  }
  const tag = m[1].toUpperCase();
  const reason = (m[2] ?? '').trim() || '(no reason given)';
  return {
    verdict: tag === 'BUSYWORK' ? 'busywork' : 'substantive',
    reason,
  };
}

// Post a review request to the shared critic session and wait for the
// verdict. On any failure path — timeout, parse failure, HTTP error —
// returns `verdict: 'unclear'` so the caller can fail-open. Consumers
// treat 'substantive' and 'unclear' identically (accept the commit);
// only an explicit 'busywork' gates the commit.
export async function reviewWorkerDiff(
  input: CriticReviewInput,
): Promise<CriticReviewResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withCriticLock(input.swarmRunID, async () => {
    try {
      const before = await getSessionMessagesServer(
        input.criticSessionID,
        input.workspace,
      );
      const knownIDs = new Set(before.map((m) => m.info.id));
      const prompt = buildCriticPrompt(input);
      await postSessionMessageServer(
        input.criticSessionID,
        input.workspace,
        prompt,
      );

      const deadline = Date.now() + timeoutMs;
      const waited = await waitForSessionIdle(
        input.criticSessionID,
        input.workspace,
        knownIDs,
        deadline,
      );
      if (!waited.ok) {
        // Abort the critic turn so it doesn't keep streaming tokens with no
        // consumer. Mirrors the planner's abort-on-timeout guard.
        try {
          await abortSessionServer(input.criticSessionID, input.workspace);
        } catch {
          // best-effort
        }
        return {
          verdict: 'unclear',
          reason: `critic wait failed: ${waited.reason}`,
        };
      }
      // Extract the critic's text reply from the new assistant messages.
      // Take the last assistant message's concatenated text parts — that's
      // what the "reply on one line" prompt targets.
      let replyText = '';
      for (const msg of waited.messages) {
        if (!waited.newIDs.has(msg.info.id)) continue;
        if (msg.info.role !== 'assistant') continue;
        const text = (msg.parts ?? [])
          .flatMap((p) => (p.type === 'text' ? [p.text] : []))
          .join('')
          .trim();
        if (text) replyText = text;
      }
      const parsed = parseVerdict(replyText);
      return { ...parsed, rawReply: replyText };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { verdict: 'unclear', reason: `critic threw: ${message}` };
    }
  });
}
