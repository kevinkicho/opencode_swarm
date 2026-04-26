// Liveness watchdog — detects the case where opencode accepts prompts
// (HTTP 204 from /prompt_async) but never generates any tokens. The
// 2026-04-23 overnight run hit this at ~01:15: every sweep queued to
// stuck sessions, no LLM output, run dead for 4 hours until human
// intervention. Silent because our code-side signals (ticker firing,
// HTTP 200s on reads) all looked fine.
//
// Extracted from auto-ticker.ts in #106 phase 3f.

import 'server-only';

import { deriveRunRow, getRun } from '../../swarm-registry';
import {
  detectRecentZen429,
  formatRetryAfter,
} from '../../zen-rate-limit-probe';
import { maybeRestartOpencode } from '../../opencode-restart';
import { checkHardCaps } from './hard-caps';
import { stopAutoTicker } from './stop';
import type { TickerState } from './types';

// Polled every LIVENESS_CHECK_INTERVAL_MS via the per-run timer in
// startAutoTicker. Exported so the lifecycle module can wire it.
export const LIVENESS_CHECK_INTERVAL_MS = 60_000;
// If tokens haven't moved for this long AND we've seen tokens produce
// before, declare frozen. Chosen at 10 min because legitimate long
// turns can go 5-10 min without a token update on slow tool calls;
// shorter thresholds trip false positives.
const FROZEN_TOKENS_THRESHOLD_MS = 10 * 60 * 1000;
// If a brand-new run produces zero tokens for this long, also declare
// frozen. Planner should emit within ~90s; actual worker turns start
// within 2 min. 15 min is generous — any run not making any noise by
// then is broken in a way worth stopping.
const STARTUP_GRACE_MS = 15 * 60 * 1000;

// Liveness check — the opencode-frozen watchdog. Polls token growth on
// a fresh deriveRunRow call; compares to the last check. Declares frozen
// and stops the ticker in two cases:
//   - tokens > 0 has been observed, but tokens haven't advanced for
//     FROZEN_TOKENS_THRESHOLD_MS (opencode was alive but went silent)
//   - tokens === 0 and the ticker has been running for STARTUP_GRACE_MS
//     (startup freeze — opencode never started producing)
// Fire-and-forget via setInterval; per-run single-flight via the timer.
// Errors inside the check log and exit without stopping the ticker — a
// transient opencode read failure shouldn't kill a healthy run.
export async function checkLiveness(state: TickerState): Promise<void> {
  if (state.stopped) return;
  // Stage 2 hard-cap check piggy-backs on the liveness interval. The
  // commit-time check in tickSession covers burst overruns; this
  // catches wall-clock breaches on runs that go quiet (no 'picked'
  // outcomes for an extended window) but have been running long
  // enough to trip the minutes cap.
  if (await checkHardCaps(state)) return;
  try {
    const meta = await getRun(state.swarmRunID);
    if (!meta) return;
    const row = await deriveRunRow(meta);
    const tokens = row.tokensTotal ?? 0;
    const now = Date.now();

    if (tokens === 0) {
      // Nothing produced yet — grace period before calling it frozen.
      const age = now - state.startedAtMs;
      if (age >= STARTUP_GRACE_MS) {
        const rl = await detectRecentZen429();
        if (rl.found) {
          if (rl.retryAfterSec && rl.retryAfterSec > 0) {
            state.retryAfterEndsAtMs = Date.now() + rl.retryAfterSec * 1000;
          }
          console.warn(
            `[board/auto-ticker] ${state.swarmRunID}: zen-rate-limit (startup) — 0 tokens after ${Math.round(age / 60_000)}min; most recent 429 at ${new Date(rl.lastHitAt!).toISOString()}, retry-after ${formatRetryAfter(rl.retryAfterSec)}. Stopping ticker; self-heals once quota clears.`,
          );
          stopAutoTicker(state.swarmRunID, 'zen-rate-limit');
        } else {
          console.warn(
            `[board/auto-ticker] ${state.swarmRunID}: opencode-frozen (startup) — 0 tokens after ${Math.round(age / 60_000)}min, no recent 429 in the log. Stopping ticker. Restart opencode + the ticker to recover.`,
          );
          stopAutoTicker(state.swarmRunID, 'opencode-frozen');
          maybeRestartOpencode(`${state.swarmRunID} (startup freeze)`);
        }
      }
      return;
    }

    if (tokens !== state.lastSeenTokens) {
      // Progress! Reset the clock.
      state.lastSeenTokens = tokens;
      state.lastTokensChangedAtMs = now;
      return;
    }

    // Tokens stuck. If long enough, declare frozen — but first check
    // if the opencode log shows a recent 429. That's self-healing
    // (wait out retry-after) and warrants a different stop reason so
    // the UI can surface a useful "retry 5h" instead of a generic
    // "process dead" message.
    const stuckFor = now - state.lastTokensChangedAtMs;
    if (stuckFor >= FROZEN_TOKENS_THRESHOLD_MS) {
      const rl = await detectRecentZen429();
      if (rl.found) {
        if (rl.retryAfterSec && rl.retryAfterSec > 0) {
          state.retryAfterEndsAtMs = Date.now() + rl.retryAfterSec * 1000;
        }
        console.warn(
          `[board/auto-ticker] ${state.swarmRunID}: zen-rate-limit — no token delta in ${Math.round(stuckFor / 60_000)}min (tokens at ${tokens}); most recent 429 at ${new Date(rl.lastHitAt!).toISOString()}, retry-after ${formatRetryAfter(rl.retryAfterSec)}. Stopping ticker; self-heals once quota clears.`,
        );
        stopAutoTicker(state.swarmRunID, 'zen-rate-limit');
      } else {
        console.warn(
          `[board/auto-ticker] ${state.swarmRunID}: opencode-frozen — no token delta in ${Math.round(stuckFor / 60_000)}min (tokens stuck at ${tokens}), no recent 429 in the log. Stopping ticker. Restart opencode + the ticker to recover.`,
        );
        stopAutoTicker(state.swarmRunID, 'opencode-frozen');
        maybeRestartOpencode(`${state.swarmRunID} (mid-run freeze)`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[board/auto-ticker] ${state.swarmRunID}: liveness check threw:`,
      message,
    );
  }
}
