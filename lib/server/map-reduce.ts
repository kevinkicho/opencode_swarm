// Map-reduce orchestration.
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

import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { withRunGuard } from './run-guard';
import { getSessionMessagesServer, postSessionMessageServer } from './opencode-server';
import { tickCoordinator, waitForSessionIdle } from './blackboard/coordinator';
import { extractLatestAssistantText, harvestDrafts, snapshotKnownIDs } from './harvest-drafts';
import { recordPartialOutcome } from './degraded-completion';
import { getBoardItem, insertBoardItem } from './blackboard/store';
import { formatWallClockState, isWallClockExpired } from './swarm-bounds';
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
import { THRESHOLDS, TIMINGS } from './pattern-tunables';
const SCOPE_IMBALANCE_THRESHOLD = THRESHOLDS.mapReduce.scopeImbalance;
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
 .join(' ');
 console.warn(
 `[map-reduce] — scope imbalance: max:min = ${ratio.toFixed(1)}x (threshold ${SCOPE_IMBALANCE_THRESHOLD}x); ${summary}`,
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
 await withRunGuard(
 swarmRunID,
 { expectedPattern: 'map-reduce', context: 'map-reduce' },
 async (meta) => {
 if (meta.sessionIDs.length < 2) {
 console.warn(
 `[map-reduce] run ${swarmRunID} has only ${meta.sessionIDs.length} session(s) — synthesis aborted`,
 );
 return;
 }

 // Per-session wait deadline. 25 minutes is generous for a map phase — if
 // any one session blows this we log and skip its output in the synthesis
 // (better to ship N-1 drafts than hang forever).
 // doesn't block sibling waits sequentially. Each wait runs to its own
 // deadline; the slow ones don't penalize the fast ones.
 const SESSION_WAIT_MS = TIMINGS.mapReduce.sessionWaitMs;
 const deadline = Date.now() + SESSION_WAIT_MS;
 const knownIDsBySession = await snapshotKnownIDs(meta, '[map-reduce]');
 const waitResults = await harvestDrafts(meta, {
 knownIDsBySession,
 deadline,
 contextLabel: '[map-reduce]',
 });
 const drafts: Array<{ sessionID: string; text: string | null }> =
 waitResults.map((r) => ({ sessionID: r.sessionID, text: r.text }));

 const present = drafts.filter((d) => d.text !== null);
 const failedCount = waitResults.filter((r) => !r.ok || r.text === null).length;
 const totalSessionCount = meta.sessionIDs.length;

 function buildMapPhaseSummary(): string {
 const parts: string[] = [];
 parts.push(
 `Map-reduce synthesis aborted. ${present.length}/${totalSessionCount} drafts harvested; ${failedCount} member(s) failed.`,
 );
 if (present.length > 0) {
 parts.push('');
 parts.push('Map drafts that DID complete (preserved here so the human can reconcile manually):');
 for (const d of present) {
 parts.push(`--- session ${d.sessionID.slice(-8)} ---`);
 parts.push(d.text ?? '');
 parts.push('');
 }
 }
 return parts.join('\n');
 }

 if (present.length === 0) {
 console.warn(
 `[map-reduce] run ${swarmRunID} — no draft texts harvested, synthesis skipped`,
 );
 recordPartialOutcome(swarmRunID, {
 pattern: 'map-reduce',
 phase: 'map-fan-in',
 reason: 'zero-drafts',
 summary: buildMapPhaseSummary(),
 });
 return;
 }

 // the operator opts in, refuse to proceed unless the floor of
 // successful drafts is met AND the ceiling of failures isn't
 // exceeded. Without the knob, we always proceed with whatever
 // drafts came back (the existing behavior).
 const tolerance = meta.partialMapTolerance;
 if (tolerance) {
 if (present.length < tolerance.minMembers) {
 console.warn(
 `[map-reduce] run ${swarmRunID} — only ${present.length}/${meta.sessionIDs.length} drafts harvested, below minMembers=${tolerance.minMembers} — synthesis aborted`,
 );
 recordPartialOutcome(swarmRunID, {
 pattern: 'map-reduce',
 phase: 'tolerance-gate (minMembers)',
 reason: `drafts=${present.length}<minMembers=${tolerance.minMembers}`,
 summary: buildMapPhaseSummary(),
 });
 return;
 }
 if (failedCount > tolerance.maxMemberFailures) {
 console.warn(
 `[map-reduce] run ${swarmRunID} — ${failedCount} member(s) failed, above maxMemberFailures=${tolerance.maxMemberFailures} — synthesis aborted`,
 );
 recordPartialOutcome(swarmRunID, {
 pattern: 'map-reduce',
 phase: 'tolerance-gate (maxMemberFailures)',
 reason: `failed=${failedCount}>max=${tolerance.maxMemberFailures}`,
 summary: buildMapPhaseSummary(),
 });
 return;
 }
 if (failedCount > 0) {
 console.log(
 `[map-reduce] run ${swarmRunID} — proceeding with ${present.length}/${meta.sessionIDs.length} drafts, ${failedCount} failures within tolerance`,
 );
 }
 }

 const synthesisPrompt = buildSynthesisPrompt(drafts, meta.directive, failedCount);
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
 const DISPATCH_DEADLINE_MS = TIMINGS.mapReduce.dispatchDeadlineMs;
 const TICK_INTERVAL_MS = TIMINGS.mapReduce.tickIntervalMs;
 const dispatchDeadline = Date.now() + DISPATCH_DEADLINE_MS;

 while (Date.now() < dispatchDeadline) {
 // Wall-clock cap (#85) — exit synth dispatch early if the run-
 // level minutesCap is already exceeded (mapper waits already
 // burned wall-clock time). Synth item stays on the board for
 // forensics; the human can see the partial state.
 if (isWallClockExpired(meta, meta.createdAt)) {
 console.warn(
 `[map-reduce] run ${swarmRunID}: wall-clock cap reached (${formatWallClockState(meta, meta.createdAt)}) — synth dispatch aborted before claim`,
 );
 recordPartialOutcome(swarmRunID, {
 pattern: 'map-reduce',
 phase: 'synthesis-dispatch (wall-clock)',
 reason: 'wall-clock-cap',
 summary: buildMapPhaseSummary(),
 });
 return;
 }
 const outcome = await tickCoordinator(swarmRunID);
 if (outcome.status === 'picked' && outcome.itemID === itemID) {
 console.log(
 `[map-reduce] run ${swarmRunID} — synthesis claimed by ${outcome.sessionID} and completed`,
 );
 // peer review of the synthesis against the original drafts. Loop
 // the synthesizer back on REVISE, capped at MAX_REVISIONS so a
 // disagreeable critic can't burn unbounded tokens.
 if (meta.enableSynthesisCritic) {
 await runSynthesisCriticGate(meta, drafts, outcome.sessionID);
 }
 return;
 }
 if (outcome.status === 'stale' && outcome.itemID === itemID) {
 console.warn(
 `[map-reduce] run ${swarmRunID} — synthesis stale: ${outcome.reason}`,
 );
 recordPartialOutcome(swarmRunID, {
 pattern: 'map-reduce',
 phase: 'synthesis-claim',
 reason: `stale: ${outcome.reason.slice(0, 60)}`,
 summary: buildMapPhaseSummary(),
 });
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
 recordPartialOutcome(swarmRunID, {
 pattern: 'map-reduce',
 phase: 'synthesis-dispatch-deadline',
 reason: 'deadline-exceeded',
 summary: buildMapPhaseSummary(),
 });
 },
 );
}

// harvest-drafts.ts (the helper module map-reduce already imports
// from). Pre-fix duplicated character-identical here.

// Per-draft soft cap on what we feed into the synthesis prompt
// (#97 fix). Without this, a single verbose mapper can swallow the
// entire synthesizer context window — the MAXTEAM-2026-04-26 stress
// test showed teamSize=8 mappers producing ~1.3M tokens each, so the
// concatenated synth prompt overflowed every available model's
// context. Capping at 80K chars per mapper (~20K tokens) keeps the
// total bounded: 8 mappers × 80K = 640K chars (~160K tokens) which
// fits in GLM's 202K-token context with synth-prompt scaffolding
// overhead. At the recommended teamSize ≤ 5 the cap rarely triggers
// (mappers focused on a single slice tend to land well under it).
//
// The truncation is intentionally character-based, not token-based —
// no tokenizer dependency, predictable upper bound, and reasonably
// portable across models. Trimmed text gets a clear footer so the
// synthesizer knows the input was capped.
const MAX_DRAFT_CHARS_FOR_SYNTHESIS = THRESHOLDS.mapReduce.maxDraftCharsForSynthesis;

export function truncateDraftForSynthesis(text: string): {
 text: string;
 truncated: boolean;
} {
 if (text.length <= MAX_DRAFT_CHARS_FOR_SYNTHESIS) {
 return { text, truncated: false };
 }
 const head = text.slice(0, MAX_DRAFT_CHARS_FOR_SYNTHESIS).trimEnd();
 const omitted = text.length - MAX_DRAFT_CHARS_FOR_SYNTHESIS;
 return {
 text:
 head +
 `\n\n*[…truncated for synthesis: ${omitted.toLocaleString()} additional chars omitted to fit synthesizer context. Reduce teamSize or have mappers produce more focused drafts to avoid truncation.]*`,
 truncated: true,
 };
}

function buildSynthesisPrompt(
 drafts: Array<{ sessionID: string; text: string | null }>,
 baseDirective: string | undefined,
 failedCount?: number,
): string {
 const preface = baseDirective?.trim()
 ? `Original directive: ${baseDirective.trim()}`
 : 'The council was given a split-scope directive and each member covered its own slice.';

 let truncatedCount = 0;
 const blocks = drafts.map((d, i) => {
 const label = `Member ${i + 1} (${d.sessionID.slice(-8)})`;
 if (d.text === null) {
 return `### ${label}\n\n*(no final draft — session did not produce a text output in time)*`;
 }
 const { text, truncated } = truncateDraftForSynthesis(d.text.trim());
 if (truncated) truncatedCount += 1;
 return `### ${label}\n\n${text}`;
 });
 if (truncatedCount > 0) {
 console.warn(
 `[map-reduce] synthesis prompt — ${truncatedCount}/${drafts.length} draft(s) truncated to ${MAX_DRAFT_CHARS_FOR_SYNTHESIS.toLocaleString()} chars to fit synthesizer context (#97). Consider reducing teamSize (recommendedMax for map-reduce is 5).`,
 );
 }

 const presentCount = drafts.filter((d) => d.text !== null).length;
 // synthesizer so it knows the input is incomplete and can call out
 // the gap rather than papering over it.
 const failureNote =
 failedCount && failedCount > 0
 ? [
 '',
 `**Note:** ${failedCount} member(s) did not produce a draft in time;`,
 `this synthesis is based on ${presentCount} draft(s). Surface the`,
 `coverage gap explicitly in your output so a downstream reader can`,
 `tell the story is incomplete.`,
 '',
 ]
 : [];

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
 ...failureNote,
 '',
 '---',
 '',
 blocks.join('\n\n---\n\n'),
 ].join('\n');
}

//
// Reuses an idle peer session (any non-synthesizer in meta.sessionIDs)
// as the critic — keeps the infra simple, matches I1.
// On REVISE the synthesizer is re-prompted with the feedback; cap at
// MAX_REVISIONS revisions so a disagreeable critic can't burn unbounded
// tokens. Critic verdict format: first line APPROVED or REVISE; rest of
// the body is feedback (passed to the synthesizer when REVISE).
const SYNTHESIS_CRITIC_WAIT_MS = TIMINGS.mapReduce.synthesisCriticWaitMs;
const MAX_SYNTHESIS_CRITIC_REVISIONS = THRESHOLDS.mapReduce.maxSynthesisCriticRevisions;

function pickCriticSession(
 sessionIDs: readonly string[],
 synthesizerSessionID: string,
): string | null {
 for (const sid of sessionIDs) {
 if (sid !== synthesizerSessionID) return sid;
 }
 return null;
}

function buildCriticPrompt(
 synthesisText: string,
 drafts: Array<{ sessionID: string; text: string | null }>,
): string {
 const draftBlocks = drafts
 .filter((d) => d.text !== null)
 .map((d, i) => `### Draft from member ${i + 1}\n\n${(d.text ?? '').trim()}`)
 .join('\n\n---\n\n');
 return [
 '## Synthesis review',
 '',
 'Another member of this map-reduce just produced the synthesis below',
 'from the per-member drafts. Your job: judge whether the synthesis',
 'faithfully merges the drafts without dropping critical findings,',
 'and whether genuine disagreements between members are surfaced',
 'instead of papered over.',
 '',
 'Reply format (strict):',
 '- First line: exactly `APPROVED` or `REVISE`.',
 '- If REVISE: the rest of your reply is concrete, actionable feedback',
 ' the synthesizer should apply (specific findings missed, claims that',
 ' need attribution, sections that strip anchors, etc.). 2–6 bullets.',
 '- If APPROVED: no further text needed.',
 '',
 'Do NOT edit any files. This is a verdict, not a rewrite.',
 '',
 '---',
 '',
 '## Synthesis under review',
 '',
 synthesisText.trim(),
 '',
 '---',
 '',
 `## Original member drafts (${drafts.length} total)`,
 '',
 draftBlocks,
 ].join('\n');
}

function parseCriticVerdict(
 text: string,
): { verdict: 'approved' | 'revise' | 'unclear'; feedback: string } {
 const head = text.trimStart().slice(0, 64).toUpperCase();
 if (head.startsWith('APPROVED')) {
 return { verdict: 'approved', feedback: '' };
 }
 if (head.startsWith('REVISE')) {
 // Body of the reply (after the REVISE keyword line) is the feedback.
 const idx = text.indexOf('\n');
 const feedback = idx >= 0 ? text.slice(idx + 1).trim() : '';
 return { verdict: 'revise', feedback };
 }
 return { verdict: 'unclear', feedback: '' };
}

function buildSynthesisRevisePrompt(
 feedback: string,
 attempt: number,
 maxAttempts: number,
): string {
 return [
 `## Revision ${attempt} of ${maxAttempts} — synthesis-critic feedback`,
 '',
 'A peer reviewed your synthesis and asked for revisions. Apply the',
 'feedback below and re-emit the full synthesis as your next assistant',
 'turn. Keep what worked; only adjust what the critic flagged. Do NOT',
 'edit any files.',
 '',
 '---',
 '',
 feedback || '(no specific feedback provided — judge what to refine)',
 ].join('\n');
}

async function runSynthesisCriticGate(
 meta: import('@/lib/swarm-run-types').SwarmRunMeta,
 drafts: Array<{ sessionID: string; text: string | null }>,
 synthesizerSessionID: string,
): Promise<void> {
 const swarmRunID = meta.swarmRunID;
 const criticSID = pickCriticSession(meta.sessionIDs, synthesizerSessionID);
 if (!criticSID) {
 console.warn(
 `[map-reduce] run ${swarmRunID} — no peer session available for synthesis-critic gate (only synthesizer in pool); skipping`,
 );
 return;
 }

 for (let attempt = 1; attempt <= MAX_SYNTHESIS_CRITIC_REVISIONS; attempt += 1) {
 // Pull the synthesizer's latest assistant text — that's the
 // synthesis under review (re-fetch each iteration so revisions
 // are picked up).
 let synthesisText: string | null = null;
 try {
 const msgs = await getSessionMessagesServer(
 synthesizerSessionID,
 meta.workspace,
 );
 synthesisText = extractLatestAssistantText(msgs);
 } catch (err) {
 console.warn(
 `[map-reduce] run ${swarmRunID} — synthesis fetch for critic failed:`,
 err instanceof Error ? err.message : String(err),
 );
 return;
 }
 if (!synthesisText) {
 console.warn(
 `[map-reduce] run ${swarmRunID} — synthesizer produced no text; critic gate aborted`,
 );
 return;
 }

 // Snapshot critic's known IDs before posting.
 let criticKnownIDs = new Set<string>();
 try {
 const before = await getSessionMessagesServer(criticSID, meta.workspace);
 criticKnownIDs = new Set(before.map((m) => m.info.id));
 } catch {
 // Empty set means we'll consider every message new — safe default.
 }

 const criticPrompt = buildCriticPrompt(synthesisText, drafts);
 try {
 await postSessionMessageServer(
 criticSID,
 meta.workspace,
 criticPrompt,
 { model: meta.teamModels?.[meta.sessionIDs.indexOf(criticSID)] },
 );
 } catch (err) {
 console.warn(
 `[map-reduce] run ${swarmRunID} — critic prompt post failed:`,
 err instanceof Error ? err.message : String(err),
 );
 return;
 }

 const criticDeadline = Date.now() + SYNTHESIS_CRITIC_WAIT_MS;
 const criticWait = await waitForSessionIdle(
 criticSID,
 meta.workspace,
 criticKnownIDs,
 criticDeadline,
 );
 if (!criticWait.ok) {
 console.warn(
 `[map-reduce] run ${swarmRunID} — critic wait failed (${criticWait.reason}); shipping current synthesis as final`,
 );
 return;
 }

 // Read the critic's verdict from the freshly-completed turn.
 let criticText: string | null = null;
 try {
 const after = await getSessionMessagesServer(criticSID, meta.workspace);
 criticText = extractLatestAssistantText(after);
 } catch (err) {
 console.warn(
 `[map-reduce] run ${swarmRunID} — critic fetch failed:`,
 err instanceof Error ? err.message : String(err),
 );
 return;
 }
 if (!criticText) {
 console.warn(
 `[map-reduce] run ${swarmRunID} — critic produced no text; shipping synthesis as final`,
 );
 return;
 }

 const { verdict, feedback } = parseCriticVerdict(criticText);
 if (verdict === 'approved') {
 console.log(
 `[map-reduce] run ${swarmRunID} — synthesis APPROVED by critic on attempt ${attempt}`,
 );
 return;
 }
 if (verdict === 'unclear') {
 console.warn(
 `[map-reduce] run ${swarmRunID} — critic verdict unparseable (no APPROVED/REVISE keyword); shipping synthesis as final`,
 );
 return;
 }

 // REVISE — re-prompt the synthesizer with the feedback.
 console.log(
 `[map-reduce] run ${swarmRunID} — synthesis REVISE on attempt ${attempt}`,
 );
 if (attempt >= MAX_SYNTHESIS_CRITIC_REVISIONS) {
 console.warn(
 `[map-reduce] run ${swarmRunID} — max ${MAX_SYNTHESIS_CRITIC_REVISIONS} revisions reached; shipping current synthesis as final`,
 );
 return;
 }

 let synthKnownIDs = new Set<string>();
 try {
 const before = await getSessionMessagesServer(
 synthesizerSessionID,
 meta.workspace,
 );
 synthKnownIDs = new Set(before.map((m) => m.info.id));
 } catch {
 // Empty set is a safe default for the wait below.
 }

 const revisePrompt = buildSynthesisRevisePrompt(
 feedback,
 attempt,
 MAX_SYNTHESIS_CRITIC_REVISIONS,
 );
 try {
 await postSessionMessageServer(
 synthesizerSessionID,
 meta.workspace,
 revisePrompt,
 meta.synthesisModel ? { model: meta.synthesisModel } : {},
 );
 } catch (err) {
 console.warn(
 `[map-reduce] run ${swarmRunID} — synthesizer revise-post failed:`,
 err instanceof Error ? err.message : String(err),
 );
 return;
 }

 const synthDeadline = Date.now() + SYNTHESIS_CRITIC_WAIT_MS;
 const synthWait = await waitForSessionIdle(
 synthesizerSessionID,
 meta.workspace,
 synthKnownIDs,
 synthDeadline,
 );
 if (!synthWait.ok) {
 console.warn(
 `[map-reduce] run ${swarmRunID} — synthesizer revise wait failed (${synthWait.reason}); shipping prior synthesis as final`,
 );
 return;
 }
 // Loop back to top — critic re-reviews the new synthesis.
 }
}
