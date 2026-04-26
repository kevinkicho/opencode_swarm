// Degraded-completion helper — task #73.
//
// Iterative orchestrators (critic-loop, debate-judge, map-reduce REDUCE,
// deliberate-execute synthesis, council rounds) all share the same
// failure mode: a single waitForSessionIdle returning ok=false aborts
// the entire orchestrator with no record of what was accomplished
// before the failure. The user sees a run that "just stopped" with
// a console WARN they probably didn't read.
//
// recordPartialOutcome is the counterpart: a fire-and-forget call
// that lands a `finding` board item summarizing what was completed
// before the failure. The caller stays responsible for cleanup
// (return after, finalizeRun in finally) — this just durably persists
// the partial state so the user can see WHAT failed and WHAT survived.
//
// Findings on the board are immutable + don't affect dispatch
// (the picker skips kind!='todo'), so it's safe to insert at any
// orchestrator-controlled point without race risk.

import 'server-only';

import { mintItemId } from './blackboard/planner';
import { insertBoardItem } from './blackboard/store';

interface PartialOutcomeOpts {
  pattern: string;
  // Which loop iteration / round / phase the orchestrator was in when
  // it gave up. Free-form; goes into the finding's content for the
  // user to read.
  phase: string;
  // The waitForSessionIdle reason or other failure label. Examples:
  // 'silent', 'timeout', 'error', 'tool-loop', 'no-text',
  // 'review-post-failed', 'wall-clock-cap'.
  reason: string;
  // Human-readable summary of what survived: which drafts completed,
  // which rounds finished, which mapper outputs landed. The caller
  // composes this from its accumulated state. Truncated at 4000
  // chars in the content body so a runaway transcript doesn't bloat
  // the board row.
  summary: string;
}

const SUMMARY_MAX_CHARS = 4000;

export function recordPartialOutcome(
  swarmRunID: string,
  opts: PartialOutcomeOpts,
): void {
  // Wrapped so any insert error is logged but never re-thrown — the
  // caller is already in a failure-handling path; we must not turn
  // a degraded-completion record into a second cascade.
  try {
    const summaryTrimmed =
      opts.summary.length > SUMMARY_MAX_CHARS
        ? `${opts.summary.slice(0, SUMMARY_MAX_CHARS)}\n\n[…truncated, original ${opts.summary.length} chars]`
        : opts.summary;
    const content = [
      `[${opts.pattern}] partial outcome — orchestrator stopped at: ${opts.phase} (reason: ${opts.reason})`,
      '',
      summaryTrimmed,
    ].join('\n');
    insertBoardItem(swarmRunID, {
      id: mintItemId(),
      kind: 'finding',
      content,
      status: 'done',
      note: `degraded-completion ${opts.pattern} ${opts.reason}`.slice(0, 200),
    });
  } catch (err) {
    console.warn(
      `[degraded-completion] ${swarmRunID}: recordPartialOutcome insert failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
