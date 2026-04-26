// Pattern implementation survey (2026-04-25):
//
// - deliberate-execute: FULLY IMPLEMENTED. runDeliberateExecuteKickoff covers
//   all three phases (deliberation via runCouncilRounds, synthesis with
//   todowrite extraction + cold-file-seed fallback, execution via startAutoTicker).
//   Synthesis-verifier gate (I1) with clear-and-retry loop is wired.
//   Directive-complexity classifier (I4) emits WARN for trivial directives.
//   Partial-outcome recording on every early-return path. Wall-clock cap checked
//   between phases. No separate tick function — execution phase delegates to
//   the blackboard auto-ticker.
//
// - debate-judge: FULLY IMPLEMENTED. runDebateJudgeKickoff runs the full
//   multi-round generator→judge loop. Verdict parsing (WINNER/MERGE/REVISE),
//   per-generator structured bullet extraction (I1), confidence scoring (I4),
//   feedback-addressed detection (I2) with auto-stop on low engagement, and
//   wall-clock cap per round all wired. finalizeRun called on every exit path.
//   No separate tick — the loop itself is the orchestrator.
//
// - critic-loop: FULLY IMPLEMENTED. runCriticLoopKickoff runs the worker→critic
//   iteration loop with YAML verdict parsing (I1), nitpick-loop auto-
//   termination (I2), max-iterations budget exhaustion, and wall-clock cap.
//   finalizeRun called on every exit path. Partial-outcome recording throughout.
//   No separate tick — the loop itself is the orchestrator.
//
// - orchestrator-worker: FULLY IMPLEMENTED (thin). runOrchestratorWorkerKickoff
//   posts the orchestrator intro, fires the initial planner sweep, and starts
//   the auto-ticker with orchestratorSessionID excluded from dispatch. All
//   subsequent orchestration (re-planning, tier escalation, idle-stop) reuses
//   the blackboard auto-ticker + planner machinery. No dedicated tick function
//   needed — the auto-ticker handles it.
//
// - role-differentiated: FULLY IMPLEMENTED (thin). runRoleDifferentiatedKickoff
//   resolves team roles (user-supplied or defaulted), persists them to meta,
//   posts role-framed intros to sessions 1..N, fires the planner sweep on
//   session 0, and starts the auto-ticker. All dispatch mechanics (role-
//   affinity picker, strict-role routing, role-budget caps) live in the
//   coordinator and auto-ticker. No dedicated tick function needed.
//
// Summary: all five patterns have complete kickoff functions. None have
// separate tick functions — the three loop-based patterns (debate-judge,
// critic-loop, deliberate-execute) self-orchestrate within their kickoff,
// while the two blackboard-family patterns (orchestrator-worker, role-
// differentiated) delegate ongoing orchestration to the auto-ticker.

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

import 'server-only';

import { getSessionMessagesServer, postSessionMessageServer } from './opencode-server';
import { waitForSessionIdle } from './blackboard/coordinator';
import { runCouncilRounds, recommendedDeliberationRounds } from './council';
import { deleteBoardItems, insertBoardItem, listBoardItems } from './blackboard/store';
import { latestTodosFrom, mintItemId } from './blackboard/planner';
import { startAutoTicker } from './blackboard/auto-ticker';
import { getRun } from './swarm-registry';
import { formatWallClockState, isWallClockExpired } from './swarm-bounds';
import { recordPartialOutcome } from './degraded-completion';
import type { OpencodeMessage } from '../opencode/types';

const SYNTHESIS_WAIT_MS = 15 * 60 * 1000;

// PATTERN_DESIGN/deliberate-execute.md I4 — directive-complexity classifier.
// Deliberation-then-execute pays for its richer framing in tokens (N sessions
// × N rounds of peer-revise before any code lands). For trivial directives
// the cost outweighs the benefit — the user picked the wrong pattern.
//
// Cheap heuristic at kickoff: small char count AND few distinct action verbs
// from a canonical list. We don't auto-redirect to blackboard (operator's
// pattern choice is intentional); just WARN so they can rethink next time.
const DIRECTIVE_SMALL_CHARS = 200;
const DIRECTIVE_SMALL_VERB_COUNT = 2;
const DIRECTIVE_ACTION_VERBS = new Set<string>([
  'add', 'audit', 'build', 'change', 'check', 'clean',
  'create', 'debug', 'delete', 'deploy', 'deprecate', 'design',
  'document', 'enable', 'expose', 'extract', 'find', 'fix',
  'flag', 'generate', 'implement', 'improve', 'inspect', 'integrate',
  'investigate', 'lint', 'merge', 'migrate', 'mock', 'move',
  'optimize', 'parse', 'patch', 'port', 'refactor', 'remove',
  'rename', 'replace', 'report', 'research', 'review', 'rewrite',
  'rollback', 'run', 'scan', 'seed', 'split', 'stub',
  'sync', 'test', 'trace', 'update', 'upgrade', 'validate',
  'verify', 'wire', 'write',
]);

interface DirectiveComplexity {
  small: boolean;
  charCount: number;
  verbCount: number;
  verbs: string[];
}

export function classifyDirectiveComplexity(directive: string): DirectiveComplexity {
  const trimmed = directive.trim();
  const tokens = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const verbs = new Set<string>();
  for (const t of tokens) {
    if (DIRECTIVE_ACTION_VERBS.has(t)) verbs.add(t);
  }
  const verbCount = verbs.size;
  const charCount = trimmed.length;
  const small =
    charCount < DIRECTIVE_SMALL_CHARS && verbCount <= DIRECTIVE_SMALL_VERB_COUNT;
  return { small, charCount, verbCount, verbs: [...verbs] };
}

// PATTERN_DESIGN/deliberate-execute.md I1 — synthesis-verifier gate.
// Verification runs on a peer session (not the synthesizer) and asks
// the same model that helped deliberate to critique the seeded todos
// for concreteness / claimability / independence. Cap retries at 1
// to avoid loops on a divergent verifier.
const VERIFIER_WAIT_MS = 5 * 60 * 1000;
const MAX_SYNTHESIS_RETRIES = 1;

export interface SynthesisVerdict {
  verdict: 'approved' | 'revise' | 'unclear';
  feedback: string;
}

function buildSynthesisVerifierPrompt(todos: string[]): string {
  return [
    '## Synthesis review',
    '',
    'A peer just synthesized our deliberation into the todo list below.',
    'You are reviewing it before workers (including you) start claiming items.',
    '',
    'Reply in EXACTLY this shape:',
    '',
    '  APPROVED: <one-line reason>',
    '',
    '  -- OR --',
    '',
    '  REVISE:',
    '    - <specific issue 1>',
    '    - <specific issue 2>',
    '',
    'Use REVISE only when the todos have a real problem the synthesizer',
    "should fix: scope ambiguity, missing dependencies, items that can't",
    'be independently claimed by a worker, or items that drift from the',
    'mission. Polish-level rewording is NOT a reason to revise — APPROVE',
    'and let workers handle wording.',
    '',
    '---',
    '',
    'Todo list to review:',
    '',
    todos.map((t, i) => `${i + 1}. ${t}`).join('\n'),
  ].join('\n');
}

export function classifySynthesisReply(text: string): SynthesisVerdict {
  const first = text.split('\n', 1)[0]?.trim() ?? '';
  if (/^approved\b/i.test(first)) return { verdict: 'approved', feedback: text.trim() };
  if (/^revise\b/i.test(first)) {
    const stripped = text.replace(/^\s*revise[:\s]*/i, '').trim();
    return { verdict: 'revise', feedback: stripped };
  }
  return { verdict: 'unclear', feedback: text.trim() };
}

function buildSynthesisRetryPrompt(
  feedback: string,
): string {
  return [
    '## Synthesis verifier rejected the todo list',
    '',
    "A peer reviewed your todos and asked for a revision. Their feedback:",
    '',
    feedback.trim(),
    '',
    'Re-call todowrite with a revised list addressing the feedback above.',
    'Same constraints: 6-15 concrete actionable todos, mix of sizes,',
    'BUILDING over VERIFYING. Just todowrite — no preamble.',
  ].join('\n');
}

// Seed board items from a todowrite extraction. Returns the IDs of
// inserted items so the I1 verifier loop can clear-and-retry on
// REVISE without nuking unrelated rows. Skips empty content. Stable
// 1ms-spread timestamps preserve list ordering.
function seedTodosFromExtract(
  swarmRunID: string,
  todos: Array<{ content: string }>,
): string[] {
  const baseMs = Date.now();
  const ids: string[] = [];
  for (const raw of todos) {
    const content = raw.content.trim();
    if (!content) continue;
    const id = mintItemId();
    insertBoardItem(swarmRunID, {
      id,
      kind: 'todo',
      content,
      status: 'open',
      createdAtMs: baseMs + ids.length,
    });
    ids.push(id);
  }
  return ids;
}

// How many rounds of deliberation before synthesis. Defers to the
// council module's scale-aware default (`recommendedDeliberationRounds`)
// so the same per-teamSize policy lights up here. Caller-supplied
// `opts.deliberationRounds` still wins. (#98)

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
    '- PREFIX each todo with `[from:N]` (or `[from:N,M]` for multiple)',
    '  naming the 1-based member draft(s) that motivated it. This is the',
    '  traceability tag for the deliberate-execute pattern — it lets the',
    '  team look back at "why this todo exists" by linking to the drafts',
    '  it came from. Example: `[from:1,3] Wire the dispatch watchdog into',
    '  the planner sweep`. If a todo synthesizes the entire room, list',
    '  every member you drew from. Skip the prefix only if you genuinely',
    '  cannot attribute it (rare).',
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

  // PATTERN_DESIGN/deliberate-execute.md I4 — directive-complexity WARN.
  // Inform-only: operator's pattern choice stands; we just surface a
  // signal that this run might be paying deliberation cost for nothing.
  if (meta.directive) {
    const complexity = classifyDirectiveComplexity(meta.directive);
    if (complexity.small) {
      console.warn(
        `[deliberate-execute] run ${swarmRunID} — directive looks small (${complexity.charCount} chars, ${complexity.verbCount} action verbs: ${complexity.verbs.join(', ') || '∅'}). The deliberation phase may not pay for itself; consider 'blackboard' pattern next time. (PATTERN_DESIGN/deliberate-execute.md I4)`,
      );
    }
  }

  // ─── Phase 1: deliberation ─────────────────────────────────────────
  // The swarm-run POST handler already broadcast the directive to every
  // session (deliberate-execute goes through the standard "directive to
  // all" branch since it starts council-style). runCouncilRounds adds
  // R2/R3+ peer-revise on top of that Round-1 fan-out.
  const rounds =
    opts.deliberationRounds ??
    recommendedDeliberationRounds(meta.sessionIDs.length);
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
    recordPartialOutcome(swarmRunID, {
      pattern: 'deliberate-execute',
      phase: 'deliberation',
      reason: err instanceof Error ? err.message.slice(0, 80) : 'unknown',
      summary:
        'Deliberate-execute aborted during phase 1 (council deliberation) — exception thrown before any synthesis ran. Drafts may exist in opencode session transcripts.',
    });
    return;
  }

  // Wall-clock cap (#85) — bail before paying for synthesis if deliberation
  // already exhausted the budget. Council's own check exits the round loop
  // but returns, so without this we'd continue into phase 2 anyway.
  if (isWallClockExpired(meta, meta.createdAt)) {
    console.warn(
      `[deliberate-execute] run ${swarmRunID}: wall-clock cap reached (${formatWallClockState(meta, meta.createdAt)}) — synthesis aborted after deliberation`,
    );
    recordPartialOutcome(swarmRunID, {
      pattern: 'deliberate-execute',
      phase: 'post-deliberation (wall-clock)',
      reason: 'wall-clock-cap',
      summary:
        'Deliberation completed but wall-clock cap exceeded before synthesis. Member drafts survive in their respective opencode session transcripts.',
    });
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

  // #73 — once we've harvested drafts, build a summary helper that
  // captures them. Used by every downstream early-return so partial
  // deliberation isn't lost.
  function buildDeliberationSummary(): string {
    const parts: string[] = [];
    const present = drafts.filter((d) => d.text !== null);
    parts.push(
      `Deliberate-execute partial outcome — ${present.length}/${drafts.length} drafts harvested.`,
    );
    if (present.length > 0) {
      parts.push('');
      parts.push('Member drafts (preserved here for human reconcile):');
      for (const d of present) {
        parts.push(`--- session ${d.sessionID.slice(-8)} ---`);
        parts.push(d.text ?? '');
        parts.push('');
      }
    }
    return parts.join('\n');
  }

  const present = drafts.filter((d) => d.text !== null);
  if (present.length < 2) {
    console.warn(
      `[deliberate-execute] run ${swarmRunID}: only ${present.length} draft(s) harvested — synthesis skipped`,
    );
    recordPartialOutcome(swarmRunID, {
      pattern: 'deliberate-execute',
      phase: 'draft-harvest',
      reason: `too-few-drafts (${present.length})`,
      summary: buildDeliberationSummary(),
    });
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
      { model: meta.teamModels?.[0] },
    );
  } catch (err) {
    console.warn(
      `[deliberate-execute] run ${swarmRunID}: synthesis prompt post failed:`,
      err instanceof Error ? err.message : String(err),
    );
    recordPartialOutcome(swarmRunID, {
      pattern: 'deliberate-execute',
      phase: 'synthesis-post',
      reason: err instanceof Error ? err.message.slice(0, 80) : 'unknown',
      summary: buildDeliberationSummary(),
    });
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
    recordPartialOutcome(swarmRunID, {
      pattern: 'deliberate-execute',
      phase: 'synthesis-wait',
      reason: synthWait.reason,
      summary: buildDeliberationSummary(),
    });
    return;
  }

  const latest = latestTodosFrom(synthWait.messages, synthWait.newIDs);
  if (!latest) {
    console.warn(
      `[deliberate-execute] run ${swarmRunID}: synthesis produced no todowrite — kickoff aborted`,
    );
    recordPartialOutcome(swarmRunID, {
      pattern: 'deliberate-execute',
      phase: 'synthesis-no-todowrite',
      reason: 'no-todowrite',
      summary: buildDeliberationSummary(),
    });
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
  let seededIds = seedTodosFromExtract(swarmRunID, latest.todos);
  if (seededIds.length === 0) {
    console.warn(
      `[deliberate-execute] run ${swarmRunID}: synthesis emitted 0 non-empty todos — execution skipped`,
    );
    recordPartialOutcome(swarmRunID, {
      pattern: 'deliberate-execute',
      phase: 'synthesis-empty-todos',
      reason: 'zero-todos',
      summary: buildDeliberationSummary(),
    });
    return;
  }
  console.log(
    `[deliberate-execute] run ${swarmRunID}: synthesis seeded ${seededIds.length} todos`,
  );

  // PATTERN_DESIGN/deliberate-execute.md I1 — synthesis-verifier gate.
  // Optional. Uses a peer session (sessionIDs[1]) to review the seeded
  // todos. APPROVED → proceed. REVISE → clear seeded items, post the
  // verifier feedback to the synthesizer, re-run synthesis, re-seed.
  // Capped at MAX_SYNTHESIS_RETRIES to avoid infinite verify→revise→
  // verify→revise loops.
  if (meta.enableSynthesisVerifier && meta.sessionIDs.length >= 2) {
    let retriesLeft = MAX_SYNTHESIS_RETRIES;
    while (retriesLeft > 0) {
      const verifierSID = meta.sessionIDs[1];
      const verifierModel = meta.teamModels?.[1];
      const todosForReview = latest.todos
        .map((t) => t.content.trim())
        .filter(Boolean);
      console.log(
        `[deliberate-execute] run ${swarmRunID}: synthesis-verifier review on session ${verifierSID.slice(-8)} (PATTERN_DESIGN/deliberate-execute.md I1)`,
      );
      const verifierKnownIDs = new Set(
        (
          await getSessionMessagesServer(verifierSID, meta.workspace).catch(
            () => [],
          )
        ).map((m) => m.info.id),
      );
      try {
        await postSessionMessageServer(
          verifierSID,
          meta.workspace,
          buildSynthesisVerifierPrompt(todosForReview),
          { model: verifierModel },
        );
      } catch (err) {
        console.warn(
          `[deliberate-execute] run ${swarmRunID}: verifier prompt post failed:`,
          err instanceof Error ? err.message : String(err),
        );
        break; // proceed without verification
      }
      const verifierWait = await waitForSessionIdle(
        verifierSID,
        meta.workspace,
        verifierKnownIDs,
        Date.now() + VERIFIER_WAIT_MS,
      );
      if (!verifierWait.ok) {
        console.warn(
          `[deliberate-execute] run ${swarmRunID}: verifier wait failed (${verifierWait.reason}) — proceeding without revision`,
        );
        break;
      }
      const verifierReply = extractLatestAssistantText(verifierWait.messages);
      if (!verifierReply) {
        console.warn(
          `[deliberate-execute] run ${swarmRunID}: verifier produced no text — proceeding`,
        );
        break;
      }
      const verdict = classifySynthesisReply(verifierReply);
      if (verdict.verdict === 'approved' || verdict.verdict === 'unclear') {
        console.log(
          `[deliberate-execute] run ${swarmRunID}: synthesis-verifier ${verdict.verdict.toUpperCase()} — proceeding to execution`,
        );
        break;
      }
      // REVISE — clear seeded items, retry synthesis with the verifier's
      // feedback as additional context.
      console.warn(
        `[deliberate-execute] run ${swarmRunID}: synthesis-verifier REVISE — clearing ${seededIds.length} seeded todos and re-synthesizing (retries left ${retriesLeft - 1})`,
      );
      const cleared = deleteBoardItems(swarmRunID, seededIds);
      console.log(
        `[deliberate-execute] run ${swarmRunID}: cleared ${cleared} board items for synthesis retry`,
      );
      // Capture pre-retry known IDs so the retry's wait isolates the
      // new todowrite turn. Use the existing knownIDs object — it
      // captures everything up through the prior synthesis.
      const retryKnownIDs = new Set(
        (
          await getSessionMessagesServer(synthSID, meta.workspace).catch(
            () => [],
          )
        ).map((m) => m.info.id),
      );
      try {
        await postSessionMessageServer(
          synthSID,
          meta.workspace,
          buildSynthesisRetryPrompt(verdict.feedback),
          { model: meta.teamModels?.[0] },
        );
      } catch (err) {
        console.warn(
          `[deliberate-execute] run ${swarmRunID}: synthesis retry post failed:`,
          err instanceof Error ? err.message : String(err),
        );
        break;
      }
      const retryWait = await waitForSessionIdle(
        synthSID,
        meta.workspace,
        retryKnownIDs,
        Date.now() + SYNTHESIS_WAIT_MS,
      );
      if (!retryWait.ok) {
        console.warn(
          `[deliberate-execute] run ${swarmRunID}: synthesis retry wait failed (${retryWait.reason}) — proceeding with cleared board`,
        );
        break;
      }
      const retryLatest = latestTodosFrom(retryWait.messages, retryWait.newIDs);
      if (!retryLatest) {
        console.warn(
          `[deliberate-execute] run ${swarmRunID}: synthesis retry produced no todowrite — proceeding with cleared board`,
        );
        break;
      }
      seededIds = seedTodosFromExtract(swarmRunID, retryLatest.todos);
      latest.todos = retryLatest.todos;
      console.log(
        `[deliberate-execute] run ${swarmRunID}: synthesis retry seeded ${seededIds.length} todos`,
      );
      retriesLeft -= 1;
    }
  }

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
