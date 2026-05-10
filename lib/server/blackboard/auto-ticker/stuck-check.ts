// Stuck-deliberation detector for the auto-ticker tick loop.
//
// Wraps detectStuckDeliberation (pure function in stuck-detector.ts)
// with the auto-ticker's state + registry access so tick.ts can call
// it as a fire-and-forget policy alongside checkHardCaps and
// checkLiveness. When the detector fires, the ticker stops with
// reason='stuck-deliberation' and a partial-outcome finding lands on
// the board so the operator can see why the run died.
//
// Extracted as a module (rather than inline in tick.ts) so the policy
// is independently testable and doesn't bloat the tick function.

import 'server-only';
 
 import { getRun, deriveRunRow } from '../../swarm-registry';
 import { listBoardItems } from '../store';
 import { recordPartialOutcome } from '../../degraded-completion';
 import { detectStuckDeliberation } from '../../stuck-detector';
 import { stopAutoTicker } from './stop';
 import type { TickerState } from './types';


export interface StuckCheckResult {
  stuck: boolean;
  reason?: string;
}

// Check whether the run is burning tokens with zero board progress.
// Called from the tick loop (fire-and-forget). Returns { stuck, reason }
// so the caller can decide whether to log additionally; side effects
// (stopAutoTicker + recordPartialOutcome) are internal so tick.ts
// only needs to await and catch.
export async function checkStuckDeliberation(
  state: TickerState,
): Promise<StuckCheckResult> {
  if (state.stopped) return { stuck: false };

  const meta = await getRun(state.swarmRunID).catch(() => null);
  if (!meta) return { stuck: false };
 
  const boardItemCount = listBoardItems(state.swarmRunID).length;
  const row = await deriveRunRow(meta);
  const result = detectStuckDeliberation({
    tokensTotal: row.tokensTotal ?? 0,
    ageMs: Date.now() - meta.createdAt,
    boardItemCount,
  });


  if (result.stuck) {
    console.warn(
      `[board/auto-ticker] ${state.swarmRunID}: stuck deliberation detected — ${result.reason ?? 'unknown'}`,
    );
    stopAutoTicker(state.swarmRunID, 'stuck-deliberation');
    recordPartialOutcome(state.swarmRunID, {
      pattern: meta.pattern,
      phase: 'stuck-detector',
      reason: 'stuck-deliberation',
      summary:
        result.reason ??
        'Likely stuck deliberation: significant token spend with zero board output.',
    });
  }

  return { stuck: result.stuck, reason: result.reason };
}