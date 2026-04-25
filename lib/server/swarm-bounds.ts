// Shared wall-clock bound checker for non-ticker pattern orchestrators.
//
// Background: blackboard-family patterns enforce `bounds.minutesCap` via
// auto-ticker.ts::checkHardCaps (per-commit + 60s liveness). Non-ticker
// orchestrators (runCouncilRounds, runMapReduceSynthesis,
// runDebateJudgeKickoff, runCriticLoopKickoff,
// runDeliberateExecuteKickoff) had NO wall-clock enforcement — a council
// run with maxRounds=3 could go 90+ min if rounds were slow, with the
// user's bounds.minutesCap silently ignored. Surfaced as a real gap by
// task #77's audit on 2026-04-25.
//
// Contract: each non-ticker orchestrator checks `isWallClockExpired`
// at the start of every round / iteration / wait-cycle. On expiration,
// log a clear abort reason and return cleanly — partial progress
// (drafts produced so far) stays in opencode for the human to review.
//
// Default cap: 60 minutes when `meta.bounds.minutesCap` isn't set.
// Matches the auto-ticker DEFAULT_WALLCLOCK_MINUTES so user expectation
// is consistent across patterns.

import type { SwarmRunMeta } from '@/lib/swarm-run-types';

export const DEFAULT_NONTICKER_WALLCLOCK_MINUTES = 60;

export function effectiveMinutesCap(meta: Pick<SwarmRunMeta, 'bounds'>): number {
  return meta.bounds?.minutesCap ?? DEFAULT_NONTICKER_WALLCLOCK_MINUTES;
}

// Returns true when the elapsed wall-clock from `startedAtMs` exceeds
// `meta.bounds.minutesCap`. Pure function, no side effects — caller
// owns logging + abort.
export function isWallClockExpired(
  meta: Pick<SwarmRunMeta, 'bounds'>,
  startedAtMs: number,
  nowMs: number = Date.now(),
): boolean {
  const cap = effectiveMinutesCap(meta);
  const elapsedMin = (nowMs - startedAtMs) / 60_000;
  return elapsedMin >= cap;
}

// Convenience for log messages — formats elapsed minutes alongside cap.
export function formatWallClockState(
  meta: Pick<SwarmRunMeta, 'bounds'>,
  startedAtMs: number,
  nowMs: number = Date.now(),
): string {
  const cap = effectiveMinutesCap(meta);
  const elapsedMin = Math.round((nowMs - startedAtMs) / 60_000);
  return `${elapsedMin}min/${cap}min cap`;
}
