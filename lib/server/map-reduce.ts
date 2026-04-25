// Map-reduce orchestration — SWARM_PATTERNS.md §3.
//
// Map phase: every session gets the same base directive plus its own scope
// annotation ("your slice: src/api/"). Sessions work in parallel; the backend
// waits for all of them to go idle.
//
// Reduce phase (v2): once every map session has settled, we insert a single
// `synthesize` item onto the run's blackboard with the full synthesis prompt
// as its content. The coordinator's tick loop then picks the first idle
// session, claims the item CAS-safely (open → claimed → in-progress), posts
// the prompt verbatim, waits for the session to idle, and transitions the
// item to done. Any idle session can win the claim — the synthesizer is a
// phase, not a pinned role.
//
// Why this shape over "post to sessionIDs[0]": (a) the claim is observable
// from the board (who ran synthesis, when, over which files) where before it
// was invisible dispatcher state; (b) the item is idempotent under a
// deterministic id, so a double-firing of this function produces one row
// and one claim, not two; (c) the same CAS-lifecycle forensics that govern
// blackboard todos now govern the reduce phase for free.
//
// Server-only. Never imported from client code.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getRun } from './swarm-registry';
import { finalizeRun } from './finalize-run';
import { getSessionMessagesServer } from './opencode-server';
import { tickCoordinator, waitForSessionIdle } from './blackboard/coordinator';
import { getBoardItem, insertBoardItem } from './blackboard/store';
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

// PATTERN_DESIGN/map-reduce.md I2 — scope imbalance detector.
// deriveSlices buckets dirs by count, not size. A repo where one top-level
// dir holds 90% of the code produces a wildly imbalanced map: one member
// drowns in work while siblings finish in seconds. We can't auto-rebalance
// (would require re-bucketing per-file, breaking the dir-as-scope contract),
// but we CAN warn the operator at kickoff so they know to expect skew.
//
// Approach: walk each slice's dirs, sum the bytes of code-extension files,
// and compute max:min. If the ratio exceeds 5x, log a single WARN naming
// each slice with its size. Cheap (~ms on small repos, capped on large
// repos by the recursion cost) and fire-and-forget — never blocks kickoff.
const SCOPE_IMBALANCE_THRESHOLD = 5;
const SCOPE_CODE_EXTS = new Set<string>([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rb', '.java', '.kt', '.swift',
  '.rs', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.cs', '.php', '.scala', '.sh', '.sql',
  '.css', '.scss', '.html', '.md', '.yaml', '.yml', '.json',
]);

async function walkScopeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as import('node:fs').Dirent[];
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SLICE_EXCLUDE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += await walkScopeBytes(full);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!SCOPE_CODE_EXTS.has(ext)) continue;
      try {
        const stat = await fs.stat(full);
        total += stat.size;
      } catch {
        // skip unreadable file
      }
    }
  }
  return total;
}

async function approxScopeBytes(workspace: string, slice: string): Promise<number> {
  // Whole-workspace and root-wildcard slices are unmeasurable as a scope —
  // they're a fallback for "no real partition", so they can't be compared.
  if (slice === '(whole workspace)' || slice === '*') return 0;
  const dirs = slice.split(',').map((s) => s.trim()).filter(Boolean);
  let total = 0;
  for (const d of dirs) {
    total += await walkScopeBytes(path.join(workspace, d));
  }
  return total;
}

export async function detectScopeImbalance(
  workspace: string,
  slices: string[],
): Promise<void> {
  const sizes = await Promise.all(
    slices.map((s) => approxScopeBytes(workspace, s)),
  );
  const measurable = sizes.filter((n) => n > 0);
  if (measurable.length < 2) return;
  const max = Math.max(...measurable);
  const min = Math.min(...measurable);
  if (min === 0) return;
  const ratio = max / min;
  if (ratio <= SCOPE_IMBALANCE_THRESHOLD) return;
  const summary = slices
    .map((s, i) => `${s}=${(sizes[i] / 1024).toFixed(0)}KB`)
    .join('  ');
  console.warn(
    `[map-reduce] PATTERN_DESIGN/map-reduce.md I2 — scope imbalance: max:min = ${ratio.toFixed(1)}x (threshold ${SCOPE_IMBALANCE_THRESHOLD}x); ${summary}`,
  );
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
  try {
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
  const itemID = `synth_${swarmRunID}`;

  // Idempotency guard. If this function fires twice (e.g. a retry after a
  // transient failure upstream), the deterministic id lets us skip the
  // duplicate insert and join whatever state the existing item is in.
  const existing = getBoardItem(swarmRunID, itemID);
  if (existing) {
    console.log(
      `[map-reduce] run ${swarmRunID} — synthesis item ${itemID} already exists (${existing.status}); skipping insert`,
    );
  } else {
    try {
      insertBoardItem(swarmRunID, {
        id: itemID,
        kind: 'synthesize',
        status: 'open',
        content: synthesisPrompt,
      });
      console.log(
        `[map-reduce] run ${swarmRunID} — synthesis item ${itemID} inserted with ${present.length}/${drafts.length} drafts`,
      );
    } catch (err) {
      console.warn(
        `[map-reduce] run ${swarmRunID} — synthesis item insert failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
  }

  // Direct tick loop rather than startAutoTicker: a synthesize item is a
  // one-shot dispatch, not an ongoing work stream, so we don't need the
  // auto-ticker's 6-idle auto-stop heuristic or its global timer state.
  // Predictable failure mode: 5-minute overall deadline → log and exit,
  // leaving the item observable on the board for forensics. Per-tick
  // timeout (`tickCoordinator`'s inner waitForSessionIdle) still governs
  // how long we wait for the synthesizer's own turn to complete.
  const DISPATCH_DEADLINE_MS = 5 * 60 * 1000;
  const TICK_INTERVAL_MS = 3000;
  const dispatchDeadline = Date.now() + DISPATCH_DEADLINE_MS;

  while (Date.now() < dispatchDeadline) {
    const outcome = await tickCoordinator(swarmRunID);
    if (outcome.status === 'picked' && outcome.itemID === itemID) {
      console.log(
        `[map-reduce] run ${swarmRunID} — synthesis claimed by ${outcome.sessionID} and completed`,
      );
      return;
    }
    if (outcome.status === 'stale' && outcome.itemID === itemID) {
      console.warn(
        `[map-reduce] run ${swarmRunID} — synthesis stale: ${outcome.reason}`,
      );
      return;
    }
    // 'picked'/'stale' for a DIFFERENT item id is possible if the run is
    // dual-mode (blackboard + map-reduce on the same swarmRunID, not a
    // current combination but the store doesn't prevent it) — treat as
    // progress and keep looping. 'skipped' just means try again soon.
    await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
  }

  console.warn(
    `[map-reduce] run ${swarmRunID} — synthesis dispatch deadline exceeded; item ${itemID} left for forensics`,
  );
  } finally {
    await finalizeRun(swarmRunID, 'map-reduce');
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
