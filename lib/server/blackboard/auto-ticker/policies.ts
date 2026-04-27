// Cross-policy helpers shared by the auto-ticker's decision paths:
//   1. retry-exhausted detector
//   2. orchestrator-worker re-plan cap

import 'server-only';

import { getRun } from '../../swarm-registry';
import { listPlanRevisions } from '../plan-revisions';

// ─── Retry-exhausted detector ──────────

// Detect items that workers refused at least twice. The retryOrStale
// path tags these with a `[retry:N]` note; once N≥2 the item should
// not count as "active work" for the ratchet's drained-board predicate.
// Exported so other ratchet-style callers (eager-sweep, audit) can apply
// the same exclusion if they add work-available checks later.
const RETRY_EXHAUSTED_RE = /^\[retry:(\d+)\]/;
const RETRY_EXHAUSTED_THRESHOLD = 2;

export function isRetryExhausted(note: string | null | undefined): boolean {
  if (!note) return false;
  const m = RETRY_EXHAUSTED_RE.exec(note);
  if (!m) return false;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= RETRY_EXHAUSTED_THRESHOLD;
}

// ─── Orchestrator-worker re-plan cap ──

// The cap counts ALL planner sweeps for the run (initial + re-plans),
// so MAX_ORCHESTRATOR_REPLANS = 6 means 1 initial + 5 re-plans before
// forced stop. Tuned generous because legit orchestrator runs do
// iterate plans as workers reveal scope; the cap exists for the
// pathological loop, not normal use.
export const MAX_ORCHESTRATOR_REPLANS = 6;

// Returns true when the orchestrator-worker run has hit
// MAX_ORCHESTRATOR_REPLANS planner sweeps and should be stopped.
// Self-organizing runs return false (uncapped). Counted via
// plan_revisions ledger (the same source feeding the strategy tab),
// so initial sweeps + re-plans + no-op sweeps all count uniformly.
export async function orchestratorReplanCapHit(swarmRunID: string): Promise<boolean> {
  const meta = await getRun(swarmRunID).catch(() => null);
  if (!meta || meta.pattern !== 'orchestrator-worker') return false;
  // Cheap synchronous read against the SQLite ledger. listPlanRevisions
  // returns the full delta history; we only need the count, but the
  // call cost is negligible at run scale (≤ 6 rows by the time the
  // cap fires).
  const revisions = listPlanRevisions(swarmRunID);
  return revisions.length >= MAX_ORCHESTRATOR_REPLANS;
}
