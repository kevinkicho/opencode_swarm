// Playwright grounding — companion layer #2 to the ambition ratchet.
//
// When a blackboard-family run opts in via `enableVerifierGate: true`
// AND supplies `workspaceDevUrl`, the coordinator consults the verifier
// AFTER the critic gate approves a commit — but only for board items
// the planner flagged `requiresVerification: true`. The verifier uses
// Playwright (via opencode's bash + `npx playwright` tool) to navigate
// the running target app and assert on DOM / screenshots / flow.
// NOT_VERIFIED verdicts transition the item to stale with a
// `[verifier-rejected] {reason}` note; retry-stale can revive it.
//
// Design notes (same posture as critic.ts):
// - *Fail-open.* If the verifier session 409s, times out, or returns an
//   unparseable reply, we log and treat as verified. Never block a
//   commit on a verifier malfunction — keeps the failure mode no worse
//   than no verifier at all.
// - *Per-run mutex.* The dedicated verifier session can't process
//   concurrent prompts; serialize reviews per swarmRunID.
// - *Small prompt footprint.* Pass the mission, the todo content,
//   the worker's summary, the target URL. The verifier generates its
//   own Playwright script via bash + npx playwright inside its turn;
//   we don't ship test code from our side.
//
// See SWARM_PATTERNS.md "Tiered execution" companion layer #2 and
// memory/project_ambition_ratchet.md for the design decision context.

import {
  abortSessionServer,
  getSessionMessagesServer,
  postSessionMessageServer,
} from '../opencode-server';
import { waitForSessionIdle } from './coordinator';
import type { BoardItem } from '../../blackboard/types';

const DEFAULT_TIMEOUT_MS = 180_000; // 3 min — Playwright can take a while
const MAX_WORKER_TEXT_BYTES = 2_000;

export type VerifierVerdict = 'verified' | 'not-verified' | 'unclear';

export interface VerifierReviewInput {
  swarmRunID: string;
  verifierSessionID: string;
  workspace: string;
  workspaceDevUrl: string;
  directive: string | undefined;
  todo: BoardItem;
  workerAssistantText: string;
  timeoutMs?: number;
}

export interface VerifierReviewResult {
  verdict: VerifierVerdict;
  reason: string;
  rawReply?: string;
}

// Per-run mutex (same pattern as critic.ts).
const verifierLocks = new Map<string, Promise<unknown>>();

async function withVerifierLock<T>(
  swarmRunID: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = verifierLocks.get(swarmRunID) ?? Promise.resolve();
  const next = prior.then(fn, fn) as Promise<T>;
  verifierLocks.set(swarmRunID, next);
  try {
    return await next;
  } finally {
    if (verifierLocks.get(swarmRunID) === next) {
      verifierLocks.delete(swarmRunID);
    }
  }
}

function buildVerifierPrompt(input: VerifierReviewInput): string {
  const { directive, todo, workerAssistantText, workspaceDevUrl } = input;
  const capped = workerAssistantText.length > MAX_WORKER_TEXT_BYTES
    ? workerAssistantText.slice(0, MAX_WORKER_TEXT_BYTES) + '\n[… truncated]'
    : workerAssistantText;

  return [
    'You are a Playwright-based verification critic for an autonomous swarm',
    'run. Each message I send you is a self-contained review request — do',
    "not carry context across messages. Your job: verify whether the worker's",
    'claimed outcome is actually observable in the running target application.',
    '',
    '## Mission',
    directive?.trim() || '(no directive recorded)',
    '',
    '## The todo the worker claimed required verification',
    todo.content,
    '',
    "## Worker's summary of what they produced",
    capped || '(worker produced no text output)',
    '',
    '## Target app URL (already running — do NOT try to start it)',
    workspaceDevUrl,
    '',
    '## Your workflow',
    'Use your `bash` tool to run a one-shot Playwright check:',
    '',
    '1. Write a short Node script that uses playwright to navigate the',
    '   target URL, assert on the specific DOM / text / flow the todo',
    '   claims, and capture a screenshot for evidence.',
    '2. Run it via `bash` with `npx -y playwright@latest <your-script>` or',
    '   `node -e "<inline script>"`. Keep it under 60 lines.',
    '3. Read the output. Did the assertion pass or fail?',
    '',
    'The target app MAY not be running (URL unreachable) — that is not the',
    "worker's fault. Report UNCLEAR in that case, not NOT_VERIFIED.",
    '',
    '## Verdict format',
    'Reply with EXACTLY ONE LINE matching one of these templates:',
    '  VERDICT: VERIFIED — <one-line reason, what you observed>',
    '  VERDICT: NOT_VERIFIED — <one-line reason, what was missing or broken>',
    '  VERDICT: UNCLEAR — <one-line reason, why you could not determine>',
    '',
    'No preamble after the verdict. Reply when your Playwright run completes.',
  ].join('\n');
}

const VERDICT_RE =
  /^\s*VERDICT:\s*(VERIFIED|NOT_VERIFIED|UNCLEAR)\b\s*(?:[—:-]\s*(.+))?\s*$/im;

function parseVerdict(text: string): {
  verdict: VerifierVerdict;
  reason: string;
} {
  const m = VERDICT_RE.exec(text);
  if (!m) {
    return {
      verdict: 'unclear',
      reason: `verifier reply did not match VERDICT format: ${text.slice(0, 120)}`,
    };
  }
  const tag = m[1].toUpperCase();
  const reason = (m[2] ?? '').trim() || '(no reason given)';
  if (tag === 'NOT_VERIFIED') return { verdict: 'not-verified', reason };
  if (tag === 'VERIFIED') return { verdict: 'verified', reason };
  return { verdict: 'unclear', reason };
}

// Post a verification request to the shared verifier session and wait
// for the verdict. On any failure path — timeout, parse failure, HTTP
// error — returns `verdict: 'unclear'` so the caller can fail-open.
// Consumers treat 'verified' and 'unclear' identically (accept the
// commit); only an explicit 'not-verified' gates the commit.
export async function verifyWorkerOutcome(
  input: VerifierReviewInput,
): Promise<VerifierReviewResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withVerifierLock(input.swarmRunID, async () => {
    try {
      const before = await getSessionMessagesServer(
        input.verifierSessionID,
        input.workspace,
      );
      const knownIDs = new Set(before.map((m) => m.info.id));
      const prompt = buildVerifierPrompt(input);
      await postSessionMessageServer(
        input.verifierSessionID,
        input.workspace,
        prompt,
      );

      const deadline = Date.now() + timeoutMs;
      const waited = await waitForSessionIdle(
        input.verifierSessionID,
        input.workspace,
        knownIDs,
        deadline,
      );
      if (!waited.ok) {
        try {
          await abortSessionServer(input.verifierSessionID, input.workspace);
        } catch {
          // best-effort
        }
        return {
          verdict: 'unclear',
          reason: `verifier wait failed: ${waited.reason}`,
        };
      }
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
      return { verdict: 'unclear', reason: `verifier threw: ${message}` };
    }
  });
}
