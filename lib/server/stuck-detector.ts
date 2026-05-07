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
// Also catches the ollama zero-token case: models that don't report
// token counts are invisible to the token-floor gate. The age+messages
// fallback catches runs that have been active for too long with no
// board progress, regardless of token accounting.
//
// Detection only — does not abort the run. The signal surfaces on the
// list-row response so the picker can mark stuck runs visually; the
// operator decides whether to hard-stop (#105) or wait. Pure helper so
// it's unit-testable without orchestration scaffolding.

import 'server-only';

export interface StuckDetectorInput {
  tokensTotal: number;
  // Wall-clock age of the run, in milliseconds. Usually
  // Date.now() - meta.createdAt.
  ageMs: number;
  // Count of items on the board across all kinds (todo, finding,
  // criterion, synthesize, ...). Zero means the planner / synthesizer
  // never produced anything.
  boardItemCount: number;
  // Number of non-user messages (assistant turns) across all sessions.
  // Used as a proxy when tokensTotal is 0 (ollama models that don't
  // report token counts). When 0, the run hasn't produced any output
  // at all, so it's not stuck — it's just slow or broken.
  messageCount?: number;
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
// been running for several minutes.
export const STUCK_TOKEN_FLOOR = 500_000;

// Age floor — runs younger than this are still in startup. Picked to
// generously cover model warm-up + first sweep latency: ollama cloud
// cold starts can take 30-60s, planner sweep prompt-to-todowrite is
// typically 60-180s. 10 minutes leaves comfortable headroom for the
// initial batch to land before we'd flag a run.
export const STUCK_AGE_FLOOR_MS = 10 * 60 * 1000;

// Message-count threshold for the ollama zero-token fallback. A run
// with this many assistant messages but no board items has almost
// certainly produced enough text to warrant a board item.
export const STUCK_MESSAGE_FLOOR = 6;

export function detectStuckDeliberation(
  input: StuckDetectorInput,
): StuckResult {
  const { tokensTotal, ageMs, boardItemCount, messageCount } = input;
  if (boardItemCount > 0) return { stuck: false };

  // Primary gate: token-based detection (works for providers that
  // report accurate token counts).
  if (tokensTotal >= STUCK_TOKEN_FLOOR && ageMs >= STUCK_AGE_FLOOR_MS) {
    const tokensM = (tokensTotal / 1_000_000).toFixed(1);
    const ageMin = Math.round(ageMs / 60_000);
    return {
      stuck: true,
      reason: `${tokensM}M tokens spent over ${ageMin} min, board still empty — likely stuck deliberation`,
    };
  }

  // Fallback gate: ollama and other providers that report tokens=0.
  // If the run is old enough and has produced multiple assistant
  // messages but no board items, it's likely stuck regardless of
  // token accounting.
  if (
    tokensTotal === 0 &&
    messageCount !== undefined &&
    messageCount >= STUCK_MESSAGE_FLOOR &&
    ageMs >= STUCK_AGE_FLOOR_MS
  ) {
    const ageMin = Math.round(ageMs / 60_000);
    return {
      stuck: true,
      reason: `${messageCount} assistant messages over ${ageMin} min with no board items — likely stuck deliberation (zero-token provider)`,
    };
  }

  return { stuck: false };
}