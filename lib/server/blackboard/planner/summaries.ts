//
// Operator-visible summary builders for planner-sweep failures. Three
// failure shapes the run can land in, each with a distinct fix path:
//
//   1. Sweep aborted (timeout / silent / errored) — board may have
//      partial state from prior sweeps. buildPlannerPartialSummary
//      captures that state so the resulting `finding` row carries
//      enough context to resume.
//
//   2. Sweep completed but planner declined to call todowrite —
//      buildZeroTodoSummary explains the no-output case. Common when
//      directive is too abstract or workspace lacks the artifacts the
//      directive references.
//
//   3. Sweep emitted todos but every entry was filtered (vague criteria,
//      empty content, etc.) — buildAllFilteredSummary distinguishes
//      this from #2 because the fix path is different (rephrase the
//      criteria, not the directive).
//
// Pure functions (no I/O) so callers can unit-test them and call them
// from inside failure paths without re-throwing.

import 'server-only';

import { listBoardItems } from '../store';
import type { OpencodeMessage } from '../../../opencode/types';
import type { BoardSnapshot } from '../plan-revisions';

// #88 — partial-outcome summary for planner-sweep failures. Captures
// the board state at the moment the sweep aborted so the resulting
// `finding` row carries enough context for a human (or future-Claude)
// to understand WHAT survived. Reads in-memory cached state — never
// hits opencode — so it's safe to call from inside a failure path.
export function buildPlannerPartialSummary(
  swarmRunID: string,
  sessionID: string,
  reason: string,
): string {
  const items = listBoardItems(swarmRunID);
  const counts = {
    todo: items.filter((i) => i.kind === 'todo').length,
    todoDone: items.filter((i) => i.kind === 'todo' && i.status === 'done').length,
    todoOpen: items.filter((i) => i.kind === 'todo' && i.status === 'open').length,
    criterion: items.filter((i) => i.kind === 'criterion').length,
    finding: items.filter((i) => i.kind === 'finding').length,
    other: items.filter(
      (i) => i.kind !== 'todo' && i.kind !== 'criterion' && i.kind !== 'finding',
    ).length,
  };
  const parts: string[] = [];
  parts.push(
    `Planner sweep aborted on session ${sessionID.slice(-8)} (reason: ${reason}).`,
  );
  parts.push('');
  parts.push('Board state at sweep abort:');
  parts.push(`  todos: ${counts.todo} (${counts.todoDone} done, ${counts.todoOpen} open)`);
  parts.push(`  criteria: ${counts.criterion}`);
  parts.push(`  findings: ${counts.finding}`);
  if (counts.other > 0) parts.push(`  other: ${counts.other}`);
  if (counts.todo === 0 && counts.criterion === 0) {
    parts.push('');
    parts.push(
      'Board was empty before this sweep — nothing useful to recover. ' +
        'The run never seeded work and will exit with no claimable items.',
    );
  } else {
    parts.push('');
    parts.push(
      'Pre-sweep board state survives. The run can be resumed manually via ' +
        '`POST /api/_debug/swarm-run/<id>/sweep` once the underlying issue ' +
        '(silent worker / ollama down / etc.) is resolved.',
    );
  }
  return parts.join('\n');
}

// Compute the board snapshot for plan_revisions.board_snapshot_json.
// Counts every status bucket — strategy tab uses these to render the
// sweep-time chip without a join against board_items.
export function snapshotBoard(swarmRunID: string): BoardSnapshot {
  const all = listBoardItems(swarmRunID);
  const snap: BoardSnapshot = {
    total: all.length,
    open: 0,
    claimed: 0,
    inProgress: 0,
    done: 0,
    stale: 0,
    blocked: 0,
  };
  for (const it of all) {
    switch (it.status) {
      case 'open':
        snap.open += 1;
        break;
      case 'claimed':
        snap.claimed += 1;
        break;
      case 'in-progress':
        snap.inProgress += 1;
        break;
      case 'done':
        snap.done += 1;
        break;
      case 'stale':
        snap.stale += 1;
        break;
      case 'blocked':
        snap.blocked += 1;
        break;
      default:
        break;
    }
  }
  return snap;
}

// Pull a 200-char excerpt from the assistant's plan turn — text +
// reasoning combined (matches the planner-tab UX expectation that the
// row "speaks" the orchestrator's reasoning at a glance). Empty when
// the turn produced only tool calls without text. Used by both the
// happy-path and the no-op path so the log is uniformly populated.
export function extractAssistantExcerpt(
  messages: OpencodeMessage[],
  scopeIDs: Set<string>,
): string | null {
  let combined = '';
  for (const m of messages) {
    if (!scopeIDs.has(m.info.id)) continue;
    if (m.info.role !== 'assistant') continue;
    for (const part of m.parts) {
      if (part.type === 'text' || part.type === 'reasoning') {
        const t = (part as { text?: string }).text;
        if (typeof t === 'string') combined += t;
      }
    }
  }
  if (!combined) return null;
  const trimmed = combined.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > 200 ? trimmed.slice(0, 197) + '…' : trimmed;
}

// #99 — operator-visible finding builder for "planner returned no todos".
// The strategy tab carries the sweep-revision row, but operators looking
// at the board see "no items" with no obvious reason. The MAXTEAM-2026-
// 04-26 blackboard-at-teamSize=8 run burned 1.2M tokens cycling like
// this without surfacing why. Recording a partial-outcome finding lands
// a row on the board so the operator can see the assistant's reply
// excerpt and either rephrase the directive or pick a different pattern.
// Pure (no I/O) so callers can unit-test it.
export function buildZeroTodoSummary(excerpt: string | null): string {
  return [
    'Planner sweep completed but did not call todowrite — board has no work to dispatch.',
    '',
    excerpt
      ? `Assistant reply excerpt: "${excerpt}"`
      : 'Assistant produced no extractable text.',
    '',
    'Common causes:',
    '- Directive was abstract enough that the planner couldn\'t commit to concrete todos.',
    '- Planner emitted reasoning but no structured todowrite call (model regression).',
    '- workspace state lacks the artifacts the directive references (e.g., missing files).',
    '',
    'Operator action: rephrase the directive with concrete deliverables, OR switch to a different pattern (council if the work needs deliberation, none if a single session is sufficient).',
  ].join('\n');
}

// #99 — companion finding for "todowrite called but every item dropped
// during validation". Distinct from the no-todowrite case above: here
// the planner DID call todowrite, but every entry was filtered (vague
// criteria, empty content, etc.). The operator-visible board still ends
// up empty, which looks the same as the no-todowrite case — but with a
// different fix path.
export function buildAllFilteredSummary(
  totalTodos: number,
  droppedCriteria: number,
): string {
  return [
    `Planner called todowrite with ${totalTodos} item(s), but every one was filtered out before reaching the board.`,
    '',
    `Dropped criteria: ${droppedCriteria} (failed isViableCriterion check — vague success criteria like "make the app better")`,
    '',
    'Operator action: review the planner reply in the strategy tab and rephrase the directive with more concrete success criteria. Or override with `enableCriticGate: false` if the auditor is being too strict for this run shape.',
  ].join('\n');
}
