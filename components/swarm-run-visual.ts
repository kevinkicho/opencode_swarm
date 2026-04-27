// Shared visual maps for SwarmRunStatus. Two palettes that read different
// questions:
//
//   STATUS_VISUAL — "what's still attached to compute right now?"
//     live = mint pulse (active and producing)
//     idle = mint solid (alive but quiet — between dispatches)
//     error = rust (issue showing)
//     stale = fog gray (stopped, no concern)
//     unknown = darker fog
//   Used by: swarm-runs-picker, run-anchor-chip, cost-dashboard, retro-view.
//
//   STATUS_BURN_VISUAL — "who burned compute today?"
//     live = amber (actively spending)
//     idle = mint (alive but calm)
//     error = rust (issue)
//     stale = fog gray (done, neutral)
//     unknown = darker fog
//   Used by: projects-matrix, repo-runs-view (time-aggregated cells).
//
// Pre-2026-04-26 these were copy-pasted across 4 components with subtle
// drift. Consolidated here so a future palette change is one edit.
//
// STATUS_PRIORITY orders: error first (most actionable), live, idle, stale,
// unknown. Used to fold N statuses into a single "dominant" status (e.g.
// when a project-day cell has multiple runs). Re-ordered from old schema
// (live > error > stale > idle) so error dominates everything.

import type { SwarmRunStatus } from '@/lib/swarm-run-types';

export interface StatusVisual {
  /** Tailwind class for a small dot/swatch. */
  dot: string;
  /** User-visible label. */
  label: string;
  /** Sort rank — lower = surfaced first in lists. */
  rank: number;
  /** Tailwind class for tinted text. */
  tone: string;
}

/**
 * Default palette: "what's attached to compute?"
 * Live runs pulse mint; idle (alive-but-quiet) holds mint solid; stopped
 * runs fade to fog gray. Used by the picker, run-anchor chip, cost
 * dashboard, retro view.
 */
export const STATUS_VISUAL: Record<SwarmRunStatus, StatusVisual> = {
  live:    { dot: 'bg-mint animate-pulse', label: 'live',    rank: 0, tone: 'text-mint' },
  idle:    { dot: 'bg-mint',               label: 'idle',    rank: 1, tone: 'text-mint' },
  error:   { dot: 'bg-rust',               label: 'error',   rank: 2, tone: 'text-rust' },
  stale:   { dot: 'bg-fog-500',            label: 'stale',   rank: 3, tone: 'text-fog-400' },
  unknown: { dot: 'bg-fog-700',            label: '—',       rank: 4, tone: 'text-fog-700' },
};

/**
 * Burn-rate palette: "who spent compute when?"
 * Live=amber (actively burning), idle=mint (quiet), stale=fog (done).
 * Used by the projects-matrix day cells and repo-runs-view rows where the
 * mental model is time-aggregated cost rather than current liveness.
 */
export const STATUS_BURN_VISUAL: Record<SwarmRunStatus, { bg: string; tone: string }> = {
  live:    { bg: 'bg-amber',    tone: 'text-amber' },
  idle:    { bg: 'bg-mint',     tone: 'text-mint' },
  error:   { bg: 'bg-rust',     tone: 'text-rust' },
  stale:   { bg: 'bg-fog-500',  tone: 'text-fog-500' },
  unknown: { bg: 'bg-fog-700',  tone: 'text-fog-700' },
};

/**
 * Sort priority for folding N statuses into one "dominant" status.
 * error first (most actionable), then alive bucket (live > idle), then
 * stale, then unknown.
 */
export const STATUS_PRIORITY: SwarmRunStatus[] = [
  'error',
  'live',
  'idle',
  'stale',
  'unknown',
];
