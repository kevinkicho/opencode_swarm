// Cross-policy helpers shared by the auto-ticker's decision paths.
//
// Three concerns currently live here:
//   1. role-imbalance watchdog (PATTERN_DESIGN/role-differentiated.md I2)
//   2. retry-exhausted detector (PATTERN_DESIGN/blackboard.md I2)
//   3. orchestrator-worker re-plan cap (PATTERN_DESIGN/orchestrator-worker.md I1)
//
// Each is small (< 50 lines) and pure-ish (single side effect = console.warn
// for role-imbalance; the rest are pure reads). They get grouped here
// because each is consumed by exactly ONE policy module (tier-escalation,
// runPeriodicSweep, attemptTierEscalation respectively) — splitting them
// into per-concern files would mean three ~30-line files with lots of
// import boilerplate.

import 'server-only';

import { getRun } from '../../swarm-registry';
import { listBoardItems } from '../store';
import { listPlanRevisions } from '../plan-revisions';
import type { TickerState } from './types';

// ─── Role-imbalance watchdog (PATTERN_DESIGN/role-differentiated.md I2) ──

// After 15 min of run wallclock, check whether any pinned role has
// claimed zero items while another has claimed ≥ 5. Log WARN once
// per ROLE_IMBALANCE_REPEAT_MS so a persistent imbalance produces
// signal but not spam. Pattern-gated: only fires for
// `role-differentiated` runs where roles are pinned per session.
const ROLE_IMBALANCE_GRACE_MS = 15 * 60 * 1000; // 15 min wallclock
const ROLE_IMBALANCE_REPEAT_MS = 30 * 60 * 1000; // 30 min between repeats
const ROLE_IMBALANCE_BUSY_THRESHOLD = 5;

export async function checkRoleImbalance(state: TickerState): Promise<void> {
  const meta = await getRun(state.swarmRunID).catch(() => null);
  if (!meta || meta.pattern !== 'role-differentiated') return;
  const ageMs = Date.now() - state.startedAtMs;
  if (ageMs < ROLE_IMBALANCE_GRACE_MS) return;
  const lastWarn = state.roleImbalanceWarnedAtMs ?? 0;
  if (Date.now() - lastWarn < ROLE_IMBALANCE_REPEAT_MS) return;

  // Aggregate per-role claimed-or-done counts from the board.
  const items = listBoardItems(state.swarmRunID);
  const byRole = new Map<string, number>();
  for (const sid of meta.sessionIDs) {
    const role = (meta.teamRoles ?? [])[meta.sessionIDs.indexOf(sid)];
    if (!role) continue;
    if (!byRole.has(role)) byRole.set(role, 0);
  }
  for (const it of items) {
    if (it.kind !== 'todo') continue;
    if (it.status === 'open') continue;
    const role = it.preferredRole;
    if (!role) continue;
    if (!byRole.has(role)) byRole.set(role, 0);
    byRole.set(role, (byRole.get(role) ?? 0) + 1);
  }
  if (byRole.size < 2) return;

  const counts = [...byRole.entries()];
  const idle = counts.filter(([, n]) => n === 0).map(([r]) => r);
  const busy = counts.filter(([, n]) => n >= ROLE_IMBALANCE_BUSY_THRESHOLD);
  if (idle.length === 0 || busy.length === 0) return;

  const ageMin = Math.round(ageMs / 60_000);
  const summary = counts.map(([r, n]) => `${r}=${n}`).join(' · ');
  console.warn(
    `[role-imbalance] run ${state.swarmRunID} (${ageMin}m): ` +
      `idle role(s) [${idle.join(', ')}] while busy role(s) ` +
      `[${busy.map(([r, n]) => `${r}=${n}`).join(', ')}]; ` +
      `consider a manual re-prompt to surface work for the idle role(s). ` +
      `Per-role claimed counts: ${summary}. ` +
      `(PATTERN_DESIGN/role-differentiated.md I2)`,
  );
  state.roleImbalanceWarnedAtMs = Date.now();
}

// ─── Retry-exhausted detector (PATTERN_DESIGN/blackboard.md I2) ──────────

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

// ─── Orchestrator-worker re-plan cap (PATTERN_DESIGN/orchestrator-worker.md I1) ──

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
