// Stuck-deliberation detector (#104).
//
// Catches the failure shape that bit council / map-reduce / deliberate-
// execute in the MAXTEAM-2026-04-26 stress test: a run that's been alive
// long enough to produce output, accumulated significant tokens, but
// has zero board items to show for it. Patterns that legitimately
// produce zero board items (council, debate-judge, critic-loop's
// transcript-only modes) are still operator-visible problems when they
// fail to converge — the operator has no signal that work is or isn't
// happening, just the cost meter climbing.
//
// Detection only — does not abort the run. The signal surfaces on the
// list-row response so the picker can mark stuck runs visually; the
// operator decides whether to hard-stop (#105) or wait. Pure helper so
// it's unit-testable without orchestration scaffolding.

export interface StuckDetectorInput {
  tokensTotal: number;
  // Wall-clock age of the run, in milliseconds. Usually
  // Date.now() - meta.createdAt.
  ageMs: number;
  // Count of items on the board across all kinds (todo, finding,
  // criterion, synthesize, ...). Zero means the planner / synthesizer
  // never produced anything. We don't filter by kind because a run
  // that produced only `finding` rows is also stuck — the workers
  // never got concrete work to claim.
  boardItemCount: number;
}

export interface StuckResult {
  stuck: boolean;
  // Human-readable explanation when stuck. Used as the tooltip /
  // hover-text in the picker, and as the reason field on a
  // recordPartialOutcome finding when wired into the orchestrator.
  reason?: string;
}

// Token floor — below this, "no items yet" is normal (early kickoff
// phase, planner sweep just began). Picked conservatively: at the
// rough rate of 50–100K tokens per session-turn, 500K covers a
// council × 4 members × 1-2 rounds OR a single planner sweep that's
// been running for several minutes. We're not trying to catch fast
// failures — the silent-watchdog and tool-loop detectors own that
// space; this is for the slow-burn case where a run keeps producing
// tokens forever without converging on output.
export const STUCK_TOKEN_FLOOR = 500_000;

// Age floor — runs younger than this are still in startup. Picked to
// generously cover model warm-up + first sweep latency: ollama cloud
// cold starts can take 30-60s, planner sweep prompt-to-todowrite is
// typically 60-180s. 10 minutes leaves comfortable headroom for the
// initial batch to land before we'd flag a run.
export const STUCK_AGE_FLOOR_MS = 10 * 60 * 1000;

export function detectStuckDeliberation(
  input: StuckDetectorInput,
): StuckResult {
  const { tokensTotal, ageMs, boardItemCount } = input;
  if (boardItemCount > 0) return { stuck: false };
  if (tokensTotal < STUCK_TOKEN_FLOOR) return { stuck: false };
  if (ageMs < STUCK_AGE_FLOOR_MS) return { stuck: false };
  const tokensM = (tokensTotal / 1_000_000).toFixed(1);
  const ageMin = Math.round(ageMs / 60_000);
  return {
    stuck: true,
    reason: `${tokensM}M tokens spent over ${ageMin} min, board still empty — likely stuck deliberation`,
  };
}
