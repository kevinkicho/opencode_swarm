// Shared wall-clock bound checker for non-ticker pattern orchestrators.
//
// Background: blackboard-family patterns enforce `bounds.minutesCap` via
// auto-ticker.ts::checkHardCaps (per-commit + 60s liveness). Non-ticker
// orchestrators (council, debate-judge, critic-loop, map-reduce) check
// `isWallClockExpired` at the start of every round / iteration / wait-
// cycle. On expiration, log a clear abort reason and return cleanly.
//
// Contract: 0 = disabled (unbounded). Default 60 minutes when
// `meta.bounds.minutesCap` isn't set — matches user expectations for
// finite-round patterns. ticker-driven patterns (blackboard, orchestrator-
// worker) default to 0 via checkHardCaps.

import 'server-only';

import type { SwarmRunMeta } from '@/lib/swarm-run-types';
import { recordPartialOutcome } from './degraded-completion';

export const DEFAULT_NONTICKER_WALLCLOCK_MINUTES = 60;

export function effectiveMinutesCap(meta: Pick<SwarmRunMeta, 'bounds'>): number {
  return meta.bounds?.minutesCap ?? DEFAULT_NONTICKER_WALLCLOCK_MINUTES;
}

// Returns true when the elapsed wall-clock from `startedAtMs` exceeds
// `meta.bounds.minutesCap`. Pure function, no side effects — caller
// owns logging + abort. Returns false when cap is 0 (disabled).
export function isWallClockExpired(
  meta: Pick<SwarmRunMeta, 'bounds'>,
  startedAtMs: number,
  nowMs: number = Date.now(),
): boolean {
  const cap = effectiveMinutesCap(meta);
  if (cap <= 0) return false;
  const elapsedMs = nowMs - startedAtMs;
  if (elapsedMs < 0) {
    console.warn(`[swarm-bounds] Negative elapsed time detected: ${elapsedMs}ms. Clock drift or system time change?`);
  }
  const elapsedMin = elapsedMs / 60_000;
  return elapsedMin >= cap;
}

// Returns the current elapsed time in minutes against the cap.
// Returns a number from 0 to 1+, where 1.0 means exactly at the cap.
export function getWallClockRatio(
  meta: Pick<SwarmRunMeta, 'bounds'>,
  startedAtMs: number,
  nowMs: number = Date.now(),
): number {
  const cap = effectiveMinutesCap(meta);
  return (nowMs - startedAtMs) / (60_000 * cap);
}

// Convenience for log messages — formats elapsed minutes alongside cap.
// Returns "unbounded" when cap is 0 (disabled).
export function formatWallClockState(
  meta: Pick<SwarmRunMeta, 'bounds'>,
  startedAtMs: number,
  nowMs: number = Date.now(),
): string {
  const cap = effectiveMinutesCap(meta);
  const elapsedMin = Math.round((nowMs - startedAtMs) / 60_000);
  return cap <= 0 ? `${elapsedMin}min (unbounded)` : `${elapsedMin}min/${cap}min cap`;
}

// Combined wall-clock check + log + partial-outcome record.
//
// Replaces the 4-copy pattern in council, debate-judge, critic-loop,
// and map-reduce where each orchestrator repeats:
//   if (isWallClockExpired(...)) {
//     console.warn(`[ctx] run ${id}: wall-clock cap — aborting`);
//     recordPartialOutcome(id, { pattern, phase, reason: 'wall-clock-cap', summary });
//     return;   ← caller's return
//   }
//
// Returns true when expired (caller should return / abort the loop).
// The summary is composed by the caller from its accumulated state —
// we just hand it to recordPartialOutcome.
export function checkWallClockExpired(
  swarmRunID: string,
  meta: Pick<SwarmRunMeta, 'bounds'> & { createdAt: number; pattern: string },
  phase: string,
  summary: string,
  nowMs: number = Date.now(),
): boolean {
  if (!isWallClockExpired(meta, meta.createdAt, nowMs)) return false;
  console.warn(
    `[${meta.pattern}] run ${swarmRunID}: wall-clock cap reached (${formatWallClockState(meta, meta.createdAt, nowMs)}) — aborting at ${phase}`,
  );
  recordPartialOutcome(swarmRunID, {
    pattern: meta.pattern,
    phase: `${phase} (wall-clock)`,
    reason: 'wall-clock-cap',
    summary,
  });
  return true;
}
