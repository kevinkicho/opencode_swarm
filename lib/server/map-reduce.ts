// Map-reduce orchestration — SWARM_PATTERNS.md §3.
//
// Map phase: every session gets the same base directive plus its own scope
// annotation ("your slice: src/api/"). Sessions work in parallel; the backend
// waits for all of them to go idle.
//
// Reduce phase: once every map session has settled, we post a synthesis
// prompt to sessionIDs[0] with each sibling session's final text draft
// embedded. sessionIDs[0] is a dispatcher choice, not a pinned "synthesizer
// role" — see SWARM_PATTERNS.md §3 for the v2 target of routing synthesis
// through a blackboard-claim so any idle session can pick it up.
//
// Server-only. Never imported from client code.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getRun } from './swarm-registry';
import {
  getSessionMessagesServer,
  postSessionMessageServer,
} from './opencode-server';
import { waitForSessionIdle } from './blackboard/coordinator';
import type { OpencodeMessage } from '@/lib/opencode/types';

// Directories we never include in an auto-slice. .git / node_modules / build
// outputs aren't meaningful scopes for a code audit, and walking them would
// waste the agent's exploration budget. If a repo legitimately uses one of
// these names for source (rare) the user can provide slices manually in v2.
const SLICE_EXCLUDE = new Set<string>([
  '.git',
  '.next',
  '.svelte-kit',
  '.turbo',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  'tmp',
]);

// Partition the workspace's top-level directories into `count` slices. The
// returned array is always exactly `count` long — if there are fewer dirs
// than sessions we pad with a 'whole workspace' scope so no session is
// starved; if there are more dirs than sessions we group them comma-joined.
// Files at the root are lumped into a '*' slice when we have headroom.
export async function deriveSlices(
  workspace: string,
  count: number,
): Promise<string[]> {
  let entries: string[] = [];
  try {
    const dirents = await fs.readdir(workspace, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => !n.startsWith('.') && !SLICE_EXCLUDE.has(n))
      .sort();
  } catch {
    // Read failure: fall back to 'whole workspace' for every session. The
    // run still works — agents just won't have pre-partitioned scopes.
    return Array.from({ length: count }, () => '(whole workspace)');
  }

  if (entries.length === 0) {
    return Array.from({ length: count }, () => '(whole workspace)');
  }

  if (entries.length <= count) {
    // Fewer dirs than sessions: one dir per slice, pad with whole-workspace.
    const slices: string[] = entries.slice(0, count);
    while (slices.length < count) slices.push('(whole workspace)');
    return slices;
  }

  // More dirs than sessions: round-robin bucket the dirs so slices are
  // roughly balanced by count (not size — we don't measure bytes in v1).
  const buckets: string[][] = Array.from({ length: count }, () => []);
  entries.forEach((name, i) => {
    buckets[i % count].push(name);
  });
  return buckets.map((b) => b.join(', '));
}

// Per-session directive = base directive + a scope annotation. Appended as a
// clearly-marked block so the agent doesn't mistake it for part of the user's
// prompt body.
export function buildScopedDirective(
  baseDirective: string,
  slice: string,
  memberIndex: number,
  teamSize: number,
): string {
  return [
    baseDirective.trim(),
    '',
    `---`,
    `Map-reduce scope (member ${memberIndex + 1} of ${teamSize}): ${slice}`,
    `Focus your exploration inside this scope. Other members of the council`,
    `are covering the rest of the workspace in parallel. A synthesizer will`,
    `merge every member's output once everyone has finished — produce a`,
    `self-contained markdown report as your final assistant turn.`,
  ].join('\n');
}

// Kick off the synthesis phase in the background. Waits for every map
// session to idle, harvests the last text part from each, composes the
// synthesis prompt, and posts it to sessionIDs[0]. Failures log and exit
// quietly — the map outputs still sit in each session's transcript even if
// synthesis never lands, so the human can still reconcile manually.
export async function runMapReduceSynthesis(swarmRunID: string): Promise<void> {
  const meta = await getRun(swarmRunID);
  if (!meta) {
    console.warn(`[map-reduce] run ${swarmRunID} not found — synthesis aborted`);
    return;
  }
  if (meta.pattern !== 'map-reduce') {
    console.warn(
      `[map-reduce] run ${swarmRunID} has pattern '${meta.pattern}', not map-reduce — synthesis aborted`,
    );
    return;
  }
  if (meta.sessionIDs.length < 2) {
    console.warn(
      `[map-reduce] run ${swarmRunID} has only ${meta.sessionIDs.length} session(s) — synthesis aborted`,
    );
    return;
  }

  // Snapshot known IDs per session at the moment we start waiting. The
  // directive post happened just before this call (in the route), so each
  // session already has at least one user message; we consider everything
  // currently visible as "known" and wait for the next assistant turn to
  // land and complete.
  const knownIDsBySession = new Map<string, Set<string>>();
  for (const sid of meta.sessionIDs) {
    try {
      const msgs = await getSessionMessagesServer(sid, meta.workspace);
      knownIDsBySession.set(sid, new Set(msgs.map((m) => m.info.id)));
    } catch {
      knownIDsBySession.set(sid, new Set());
    }
  }

  // Per-session wait deadline. 25 minutes is generous for a map phase — if
  // any one session blows this we log and skip its output in the synthesis
  // (better to ship N-1 drafts than hang forever).
  const SESSION_WAIT_MS = 25 * 60 * 1000;
  const deadline = Date.now() + SESSION_WAIT_MS;

  const drafts: Array<{ sessionID: string; text: string | null }> = [];
  for (const sid of meta.sessionIDs) {
    const known = knownIDsBySession.get(sid) ?? new Set<string>();
    const result = await waitForSessionIdle(sid, meta.workspace, known, deadline);
    if (!result.ok) {
      console.warn(
        `[map-reduce] session ${sid} wait failed (${result.reason}) — proceeding with its last completed text`,
      );
    }
    // Whether waitForSessionIdle succeeded or not, fetch the latest state and
    // take the newest completed assistant text part. For map-reduce this is
    // the member's final draft regardless of how we exited the wait.
    let lastText: string | null = null;
    try {
      const msgs = await getSessionMessagesServer(sid, meta.workspace);
      lastText = extractLatestAssistantText(msgs);
    } catch (err) {
      console.warn(
        `[map-reduce] session ${sid} message fetch failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    drafts.push({ sessionID: sid, text: lastText });
  }

  const present = drafts.filter((d) => d.text !== null);
  if (present.length === 0) {
    console.warn(
      `[map-reduce] run ${swarmRunID} — no draft texts harvested, synthesis skipped`,
    );
    return;
  }

  const synthesisPrompt = buildSynthesisPrompt(drafts, meta.directive);
  const synthesizerSession = meta.sessionIDs[0];
  try {
    await postSessionMessageServer(
      synthesizerSession,
      meta.workspace,
      synthesisPrompt,
    );
    console.log(
      `[map-reduce] run ${swarmRunID} — synthesis posted to ${synthesizerSession} with ${present.length}/${drafts.length} drafts`,
    );
  } catch (err) {
    console.warn(
      `[map-reduce] run ${swarmRunID} — synthesis post failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Pull the latest completed assistant text part. Mirrors the "last assistant
// text" convention ReconcileStrip uses on the client — keeps map-reduce's
// draft selection aligned with what the UI shows to the human.
function extractLatestAssistantText(messages: OpencodeMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.info.role !== 'assistant') continue;
    if (!m.info.time.completed) continue;
    const texts = m.parts.filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text');
    if (texts.length === 0) continue;
    return texts[texts.length - 1].text;
  }
  return null;
}

function buildSynthesisPrompt(
  drafts: Array<{ sessionID: string; text: string | null }>,
  baseDirective: string | undefined,
): string {
  const preface = baseDirective?.trim()
    ? `Original directive: ${baseDirective.trim()}`
    : 'The council was given a split-scope directive and each member covered its own slice.';

  const blocks = drafts.map((d, i) => {
    const label = `Member ${i + 1} (${d.sessionID.slice(-8)})`;
    if (d.text === null) {
      return `### ${label}\n\n*(no final draft — session did not produce a text output in time)*`;
    }
    return `### ${label}\n\n${d.text.trim()}`;
  });

  return [
    'Map-reduce synthesis phase.',
    '',
    preface,
    '',
    `Below are ${drafts.length} sibling drafts from the map phase. Read each`,
    `carefully, then produce ONE unified synthesis as your reply. The synthesis`,
    `should:`,
    '',
    '- Preserve concrete evidence (file paths, line numbers, symbols) — do not strip anchors.',
    '- Merge overlapping findings; call out genuine disagreements instead of averaging them away.',
    '- Preserve unique picks from individual members when they add value, attributing by member number.',
    '- Finish with a clean markdown document as your final assistant text turn. Do not edit any files.',
    '',
    '---',
    '',
    blocks.join('\n\n---\n\n'),
  ].join('\n');
}
