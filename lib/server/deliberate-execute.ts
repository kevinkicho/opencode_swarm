// Deliberate-execute pattern — hierarchical pattern #5 (compositional).
// See SWARM_PATTERNS.md §9.
//
// Shape: council deliberation (multi-round peer-revise) → one session
// synthesizes converged drafts into concrete todos via todowrite →
// those todos land on the board → auto-ticker dispatches them back to
// the same session pool, now acting as workers.
//
// Three phases on one session pool:
//   1. Deliberation: reuse runCouncilRounds (N rounds of peer-revise).
//      All sessions produce divergent drafts, iterate toward convergence.
//   2. Synthesis: one session (session 0) receives all final drafts and
//      is asked to extract 6-15 concrete, actionable todos via todowrite.
//   3. Execution: those todos are seeded on the blackboard; auto-ticker
//      starts; every session (including session 0) flips into worker
//      mode and drains the board.
//
// Why this over plain blackboard: the deliberation phase produces a
// richer shared understanding of the mission before execution starts.
// Worth the extra token cost when the initial framing matters more than
// implementation speed — architectural decisions, multi-component
// features, anything where "get the plan right" is the critical path.

import { getSessionMessagesServer, postSessionMessageServer } from './opencode-server';
import { waitForSessionIdle } from './blackboard/coordinator';
import { runCouncilRounds } from './council';
import { insertBoardItem, listBoardItems } from './blackboard/store';
import { latestTodosFrom, mintItemId } from './blackboard/planner';
import { startAutoTicker } from './blackboard/auto-ticker';
import { getRun } from './swarm-registry';
import type { OpencodeMessage } from '../opencode/types';

const SYNTHESIS_WAIT_MS = 15 * 60 * 1000;

// How many rounds of deliberation before synthesis. Uses the same
// default as council — 3 rounds gets to shared conclusions on most
// missions without looping into diminishing returns.
const DEFAULT_DELIBERATION_ROUNDS = 3;

function extractLatestAssistantText(
  messages: OpencodeMessage[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.info.role !== 'assistant') continue;
    if (!m.info.time.completed) continue;
    const texts = m.parts.filter(
      (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text',
    );
    if (texts.length === 0) continue;
    return texts[texts.length - 1].text;
  }
  return null;
}

function buildSynthesisPrompt(
  directive: string | undefined,
  drafts: Array<{ sessionID: string; text: string | null }>,
): string {
  const base =
    directive?.trim() ||
    'Ship the mission implied by the project README.';

  const draftBlocks = drafts
    .filter((d) => d.text !== null)
    .map(
      (d, i) =>
        `### Draft from member ${i + 1} (${d.sessionID.slice(-8)})\n\n${(d.text ?? '').trim()}`,
    )
    .join('\n\n---\n\n');

  return [
    '## Synthesis phase — the deliberation has concluded',
    '',
    `Mission: ${base}`,
    '',
    'The final-round drafts from every member of this council are below.',
    'Your task: extract 6-15 concrete, actionable todos that, if completed,',
    'would execute the mission informed by the convergence these drafts',
    'reached. Workers (including you, in a moment) will claim each todo',
    'off the shared board and implement it.',
    '',
    'Guidelines:',
    '- Each todo is one unit of focused work (5-60 min).',
    '- Prefer BUILDING over VERIFYING. If the drafts propose new features',
    '  or integrations, schedule the build, not a test of the status quo.',
    '- Mix of sizes is fine — a few big moves, several small ones.',
    '- Each todo: a decisive verb and a concrete deliverable.',
    '',
    'Call todowrite with your todo list now. No preamble, no file reads,',
    'no task dispatches — just todowrite with the list.',
    '',
    '---',
    '',
    draftBlocks,
  ].join('\n');
}

export async function runDeliberateExecuteKickoff(
  swarmRunID: string,
  opts: {
    deliberationRounds?: number;
    persistentSweepMinutes?: number;
  } = {},
): Promise<void> {
  const meta = await getRun(swarmRunID);
  if (!meta) {
    console.warn(
      `[deliberate-execute] run ${swarmRunID} not found — kickoff aborted`,
    );
    return;
  }
  if (meta.pattern !== 'deliberate-execute') {
    console.warn(
      `[deliberate-execute] run ${swarmRunID} has pattern '${meta.pattern}', not deliberate-execute — kickoff aborted`,
    );
    return;
  }
  if (meta.sessionIDs.length < 2) return;

  // ─── Phase 1: deliberation ─────────────────────────────────────────
  // The swarm-run POST handler already broadcast the directive to every
  // session (deliberate-execute goes through the standard "directive to
  // all" branch since it starts council-style). runCouncilRounds adds
  // R2/R3+ peer-revise on top of that Round-1 fan-out.
  const rounds =
    opts.deliberationRounds ?? DEFAULT_DELIBERATION_ROUNDS;
  console.log(
    `[deliberate-execute] run ${swarmRunID}: deliberation phase — up to ${rounds} rounds`,
  );
  try {
    await runCouncilRounds(swarmRunID, { maxRounds: rounds });
  } catch (err) {
    console.warn(
      `[deliberate-execute] run ${swarmRunID}: deliberation threw:`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  // ─── Phase 2: synthesis ─────────────────────────────────────────────
  // Harvest each session's final draft, post synthesis prompt to session 0,
  // wait for todowrite, extract and seed board items.
  console.log(
    `[deliberate-execute] run ${swarmRunID}: synthesis phase — harvesting drafts`,
  );
  const drafts: Array<{ sessionID: string; text: string | null }> = [];
  for (const sid of meta.sessionIDs) {
    let text: string | null = null;
    try {
      const msgs = await getSessionMessagesServer(sid, meta.workspace);
      text = extractLatestAssistantText(msgs);
    } catch (err) {
      console.warn(
        `[deliberate-execute] run ${swarmRunID}: fetch failed for ${sid.slice(-8)}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    drafts.push({ sessionID: sid, text });
  }
  const present = drafts.filter((d) => d.text !== null);
  if (present.length < 2) {
    console.warn(
      `[deliberate-execute] run ${swarmRunID}: only ${present.length} draft(s) harvested — synthesis skipped`,
    );
    return;
  }

  const synthSID = meta.sessionIDs[0];
  // Snapshot the synthesizer's known message IDs so waitForSessionIdle
  // only counts the todowrite turn as "new."
  const knownIDs = new Set(
    (
      await getSessionMessagesServer(synthSID, meta.workspace).catch(() => [])
    ).map((m) => m.info.id),
  );

  try {
    await postSessionMessageServer(
      synthSID,
      meta.workspace,
      buildSynthesisPrompt(meta.directive, drafts),
    );
  } catch (err) {
    console.warn(
      `[deliberate-execute] run ${swarmRunID}: synthesis prompt post failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  const synthDeadline = Date.now() + SYNTHESIS_WAIT_MS;
  const synthWait = await waitForSessionIdle(
    synthSID,
    meta.workspace,
    knownIDs,
    synthDeadline,
  );
  if (!synthWait.ok) {
    console.warn(
      `[deliberate-execute] run ${swarmRunID}: synthesis wait failed (${synthWait.reason}) — kickoff aborted`,
    );
    return;
  }

  const latest = latestTodosFrom(synthWait.messages, synthWait.newIDs);
  if (!latest) {
    console.warn(
      `[deliberate-execute] run ${swarmRunID}: synthesis produced no todowrite — kickoff aborted`,
    );
    return;
  }

  // Seed board items. Guard against double-seed via existing-item check
  // (deliberate-execute runs should start with an empty board but defend).
  const existing = listBoardItems(swarmRunID).length;
  if (existing > 0) {
    console.warn(
      `[deliberate-execute] run ${swarmRunID}: board already has ${existing} items before synthesis — appending anyway`,
    );
  }
  const baseMs = Date.now();
  let added = 0;
  for (const raw of latest.todos) {
    const content = raw.content.trim();
    if (!content) continue;
    insertBoardItem(swarmRunID, {
      id: mintItemId(),
      kind: 'todo',
      content,
      status: 'open',
      createdAtMs: baseMs + added,
    });
    added += 1;
  }
  if (added === 0) {
    console.warn(
      `[deliberate-execute] run ${swarmRunID}: synthesis emitted 0 non-empty todos — execution skipped`,
    );
    return;
  }
  console.log(
    `[deliberate-execute] run ${swarmRunID}: synthesis seeded ${added} todos`,
  );

  // ─── Phase 3: execution ─────────────────────────────────────────────
  // Every session (including synthesizer) is now a worker. Auto-ticker
  // dispatches via standard blackboard machinery.
  const periodicSweepMs =
    opts.persistentSweepMinutes && opts.persistentSweepMinutes > 0
      ? Math.round(opts.persistentSweepMinutes * 60_000)
      : 0;
  startAutoTicker(swarmRunID, { periodicSweepMs });
  console.log(
    `[deliberate-execute] run ${swarmRunID}: execution phase started`,
  );
}
