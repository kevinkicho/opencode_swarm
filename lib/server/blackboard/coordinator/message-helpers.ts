// Small, focused helpers for poking at OpencodeMessage records.
//
// All pure (no I/O). Extracted from coordinator.ts in #107 phase 3 so
// each can be unit-tested in isolation; coordinator-helpers.test.ts
// already covers extractLatestErrorText, and the rest are simple
// enough that the tests-by-grep contract suffices.

import type { OpencodeMessage } from '../../../opencode/types';
import type { BoardItem } from '../../../blackboard/types';
import { extractRetryFailureReason } from './retry';

// Owner-id encoding for the board's `owner_agent_id` column. Uses the
// session ID's tail so the value is stable across a session's lifetime
// even after reload/restart, but readable in dev logs (last 8 chars).
export function ownerIdForSession(sessionID: string): string {
  return 'ag_ses_' + sessionID.slice(-8);
}

export function isAssistantComplete(m: OpencodeMessage): boolean {
  return m.info.role === 'assistant' && !!m.info.time.completed;
}

export function isAssistantInFlight(m: OpencodeMessage): boolean {
  return (
    m.info.role === 'assistant' &&
    !m.info.time.completed &&
    !m.info.error
  );
}

// How long has the oldest in-flight assistant turn been running? Returns 0
// when the session has no in-flight turns. Used by the session picker to
// distinguish legitimate long-running work from zombies.
export function oldestInFlightAgeMs(messages: OpencodeMessage[]): number {
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

// #96 — extracts the most recent assistant `info.error` message text
// among NEW messages (not in knownIDs). Used by the worker dispatch
// path to enrich the stale-note from the generic "turn errored" to
// "turn errored: <provider error excerpt>". Walks tail-to-head so
// the LATEST errored turn wins when a session has multiple. The
// `knownIDs` filter is the same set the dispatch path passes to
// waitForSessionIdle — only counts errors that appeared during the
// dispatch's wait window. Pure (no I/O) so callers can unit-test it.
export function extractLatestErrorText(
  messages: OpencodeMessage[],
  knownIDs: Set<string>,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (knownIDs.has(m.info.id)) continue;
    if (m.info.role !== 'assistant') continue;
    if (!m.info.error) continue;
    const errInfo = m.info.error as { name?: string; message?: string };
    return errInfo.message || errInfo.name || JSON.stringify(m.info.error);
  }
  return undefined;
}

export function buildWorkPrompt(item: BoardItem): string {
  // Synthesize items carry a complete, self-contained prompt (member drafts
  // already embedded by the caller). Wrapping them in the blackboard-edit
  // preamble would both mangle the synthesis directive and mislead the
  // synthesizer into editing files. Post the content verbatim and let the
  // CAS lifecycle handle progression.
  if (item.kind === 'synthesize') return item.content;
  const lines: string[] = [
    'Blackboard work prompt.',
    '',
    `Todo id: ${item.id}`,
    `Todo: ${item.content}`,
  ];
  // #76 retry-differentiation. When this todo was previously claimed
  // and stalled / errored, retryOrStale set a `[retry:N] <reason>`
  // note. Without surfacing that to the model, the re-dispatch is
  // identical to the first attempt — same prompt, same model, likely
  // same failure mode. Inject a preamble that names the prior failure
  // so the model can adapt (try a different approach, narrower scope,
  // smaller diff). The note already truncates at 200 chars; further
  // trimming here would strip the actual reason content.
  const retry = extractRetryFailureReason(item.note);
  if (retry) {
    lines.push(
      '',
      `NOTE: this is retry ${retry.attempt} of this todo. Previous attempt failed with: ${retry.reason}`,
      'Adjust your approach so you do not hit the same failure mode —',
      'narrow the scope, split the work, or try a different file ordering',
      'if appropriate. Do not just repeat the previous attempt verbatim.',
    );
  }
  // Pre-announced file scope (declared-roles alignment). When the
  // planner tagged the todo with [files:a,b], the coordinator has
  // already hashed those files at claim time for CAS drift detection;
  // the worker MUST stay within this list or risk the commit being
  // rejected as out-of-scope (future Stage 2 enforcement). Today this
  // is a soft instruction plus a hard CAS check on drift at commit.
  if (item.expectedFiles && item.expectedFiles.length > 0) {
    lines.push(
      '',
      `Expected file scope (DO NOT edit files outside this list): ${item.expectedFiles.join(', ')}`,
      'Other workers have claims on other files. Editing outside this',
      'scope risks a CAS-drift rejection at commit time.',
    );
  }
  lines.push(
    '',
    'Complete this todo by editing the file(s) above directly. Keep the',
    'scope narrow — one todo, one change. Do not call the task tool, do',
    'not spawn sub-agents. When done, reply with a one-sentence summary.',
    '',
    'If the todo turns out to be wrong or already done, reply "skip:" with',
    'a one-line reason and do not edit anything.',
  );
  return lines.join('\n');
}
