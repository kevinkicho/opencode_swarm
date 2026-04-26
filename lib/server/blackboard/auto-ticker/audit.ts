// Auditor-cadence policy — Stage 2 declared-roles contract gate.
//
// Extracted from auto-ticker.ts in #106 phase 3b. Decoupled from
// stopAutoTicker / lifecycle / tier-escalation so each can import this
// without circular dependencies.

import { getRun } from '../../swarm-registry';
import { listBoardItems, transitionStatus } from '../store';
import { auditCriteria } from '../auditor';
import { prewarmModels } from '../model-prewarm';
import type { TickerState } from './types';

// Audit trigger — Stage 2 declared-roles contract gate.
//
// Invoked from three places in the ticker's lifecycle:
//   - 'cadence'          : after every Nth 'picked' outcome (default N=5)
//   - 'tier-escalation'  : before the planner re-sweeps at tier+1 so the
//                          new sweep sees fresh verdicts in its prompt
//   - 'run-end'          : before stopAutoTicker so the archived run has
//                          a final verdict on every pending criterion
//
// Fail-open on every path: a missing auditor session, a read error, or
// an in-flight re-entrancy → log and skip. Resets the cadence counter
// even when the audit is skipped for re-entrancy so the counter doesn't
// permanently leak past K.
//
// Verdict → status mapping:
//   MET      → done     (criterion satisfied; sticky unless re-audited)
//   UNMET    → blocked  (not yet; may flip to done on a later audit)
//   WONT_DO  → stale    (criterion misguided or out of scope now)
//   unclear  → (no transition; leave open/blocked as-is for next pass)
export async function maybeRunAudit(
  state: TickerState,
  reason: 'cadence' | 'tier-escalation' | 'run-end',
): Promise<void> {
  if (state.stopped && reason !== 'run-end') return;
  if (state.auditInFlight) {
    if (reason === 'cadence') state.commitsSinceLastAudit = 0;
    return;
  }

  const { swarmRunID } = state;
  const meta = await getRun(swarmRunID).catch(() => null);
  if (!meta) return;
  if (!meta.enableAuditorGate || !meta.auditorSessionID) return;

  // Lazily sync the cadence setting from meta. A user-supplied
  // auditEveryNCommits lands on the TickerState here (rather than at
  // startAutoTicker) so HMR-reloads pick up meta changes without a
  // restart.
  if (typeof meta.auditEveryNCommits === 'number' && meta.auditEveryNCommits > 0) {
    state.auditEveryNCommits = meta.auditEveryNCommits;
  }

  const items = listBoardItems(swarmRunID);
  const pending = items.filter(
    (i) =>
      i.kind === 'criterion' &&
      (i.status === 'open' || i.status === 'blocked'),
  );

  // Cadence skip without an audit still resets the counter so the next
  // commit doesn't immediately re-trigger. Other reasons (tier-escalation,
  // run-end) are single-shot and don't gate on the counter.
  if (pending.length === 0) {
    if (reason === 'cadence') state.commitsSinceLastAudit = 0;
    console.log(
      `[board/auto-ticker] ${swarmRunID}: audit (${reason}) skipped — no pending criteria`,
    );
    return;
  }

  state.auditInFlight = true;
  try {
    const doneSummaries = items
      .filter((i) => i.status === 'done' && i.kind !== 'criterion')
      .slice(-30)
      .map((i) => i.content);
    console.log(
      `[board/auto-ticker] ${swarmRunID}: audit (${reason}) — judging ${pending.length} pending criteria`,
    );
    // Re-warm the auditor's ollama model. Auditor cadence is 5-20 min
    // apart; ollama cloud evicts warm models between calls, and we've
    // observed nemotron hanging opencode's prompt client when cold.
    // A per-audit prewarm is cheap (~1s on a recently-warm model,
    // up to 60s on truly cold). Non-ollama pins no-op.
    if (meta.auditorModel) {
      await prewarmModels([meta.auditorModel]).catch((err) => {
        console.warn(
          `[board/auto-ticker] ${swarmRunID}: auditor prewarm threw:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    }
    const result = await auditCriteria({
      swarmRunID,
      auditorSessionID: meta.auditorSessionID,
      workspace: meta.workspace,
      directive: meta.directive,
      criteria: pending,
      recentDoneSummaries: doneSummaries,
      currentTier: state.currentTier,
      auditorModel: meta.auditorModel,
    });

    let metCount = 0;
    let unmetCount = 0;
    let wontDoCount = 0;
    let unclearCount = 0;
    for (const v of result.verdicts) {
      if (v.verdict === 'unclear') {
        unclearCount += 1;
        continue;
      }
      const toStatus =
        v.verdict === 'met'
          ? ('done' as const)
          : v.verdict === 'unmet'
            ? ('blocked' as const)
            : ('stale' as const);
      // Allow transition from either 'open' or 'blocked' — criteria
      // can oscillate: a prior UNMET (blocked) can later become MET
      // if subsequent work satisfies it.
      const note = `[audit:${reason}] ${v.reason}`.slice(0, 200);
      const t = transitionStatus(swarmRunID, v.criterionID, {
        from: ['open', 'blocked'],
        to: toStatus,
        note,
        setCompletedAt: toStatus === 'done',
      });
      if (t.ok) {
        if (v.verdict === 'met') metCount += 1;
        else if (v.verdict === 'unmet') unmetCount += 1;
        else wontDoCount += 1;
      }
      // CAS loss is acceptable — a concurrent audit or manual
      // transition moved the criterion; this run's verdict for it is
      // stale and we drop it.
    }
    console.log(
      `[board/auto-ticker] ${swarmRunID}: audit (${reason}) done — met=${metCount} unmet=${unmetCount} wont-do=${wontDoCount} unclear=${unclearCount}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[board/auto-ticker] ${swarmRunID}: audit (${reason}) threw: ${message}`,
    );
  } finally {
    state.auditInFlight = false;
    if (reason === 'cadence') state.commitsSinceLastAudit = 0;
  }
}
