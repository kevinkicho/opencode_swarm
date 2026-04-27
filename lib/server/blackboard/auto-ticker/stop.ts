// Auto-ticker stop primitive.
//
// Extracted from auto-ticker.ts in #106 phase 3c so the policy modules
// (hard-caps, tier-escalation, liveness, sweep, tick) can call
// stopAutoTicker without import cycles. Lifecycle's startAutoTicker
// also imports from here.

import 'server-only';

import { abortSessionServer } from '../../opencode-server';
import { getRun } from '../../swarm-registry';
import { emitTickerTick } from '../bus';
import { persistTickerSnapshot } from '../ticker-snapshots';
import { maybeRunAudit } from './audit';
import { snapshot, tickers } from './state';
import type { StopReason } from './types';

// Stop the ticker but KEEP the map entry so observers can distinguish
// "never started" (no entry) from "ran and stopped" (stopped: true).
// `reason` records why: 'auto-idle' after the idle-ticks threshold;
// 'manual' from an explicit user action through the control route.
// Entries persist for the life of the process — at prototype scale
// (dozens of runs per session) this is a few hundred bytes total.
export function stopAutoTicker(
  swarmRunID: string,
  reason: StopReason = 'manual',
): void {
  const s = tickers().get(swarmRunID);
  if (!s || s.stopped) return;

  // Stage 2 audit: final contract verdict before teardown, so the
  // archived run's board has a clean MET / UNMET / WONT_DO state on
  // every criterion. Fire-and-forget — stop is synchronous and we
  // don't want a slow auditor call to delay the abort cascade. The
  // auditor's per-run mutex will serialize against any in-flight
  // audit; criteria the audit doesn't finish in time stay open for
  // when the run is resumed or archived as-is.
  //
  // Guarded by s.stopped=false check below to avoid firing on a
  // redundant stopAutoTicker call for an already-stopped run.
  void maybeRunAudit(s, 'run-end');

  s.stopped = true;
  s.stoppedAtMs = Date.now();
  s.stopReason = reason;

  // SQLite so getTickerSnapshot can reconstruct a stopped-state
  // response after dev restart / HMR. Synchronous + cheap (single
  // INSERT/REPLACE); failure here is logged but doesn't block the
  // stop sequence below.
  try {
    persistTickerSnapshot(swarmRunID, s.stoppedAtMs, reason, snapshot(s) as unknown as Record<string, unknown>);
  } catch (err) {
    console.warn(
      `[board/auto-ticker] ${swarmRunID}: ticker snapshot persist failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  if (s.periodicSweepTimer) clearInterval(s.periodicSweepTimer);
  s.periodicSweepTimer = null;
  if (s.livenessTimer) clearInterval(s.livenessTimer);
  s.livenessTimer = null;

  // subscribers see the transition without polling.
  emitTickerTick(swarmRunID, snapshot(s));

  // Fire-and-forget abort on every session associated with this run.
  // Purpose: ensure no opencode assistant turn keeps streaming tokens
  // into the void after the coordinator has given up on it. A turn
  // already completed is a no-op; one in flight gets cancelled.
  //
  // Includes the critic session when present — it's outside sessionIDs
  // (workers-only pool) but equally capable of hanging a turn if a review
  // was in flight when the run was stopped.
  //
  // abortSessionServer is swallowed per-call; if opencode is down or
  // the session no longer exists the stop still completes. We never
  // block the stop path on opencode reachability — that would defeat
  // the point of the liveness watchdog.
  //
  // After aborts settle, fire-and-forget a rollup so the retro page
  // (`/retro/<swarmRunID>`) lands populated on every stopped run
  // without requiring a manual `POST /api/swarm/memory/rollup`
  // (#7.Q20 + #7.Q24). Dynamic import keeps stop.ts's static
  // dependency graph tight; a slow rollup doesn't gate the stop.
  void (async () => {
    const meta = await getRun(swarmRunID).catch(() => null);
    if (!meta) return;
    const targets = [...meta.sessionIDs];
    if (meta.criticSessionID) targets.push(meta.criticSessionID);
    if (meta.verifierSessionID) targets.push(meta.verifierSessionID);
    if (meta.auditorSessionID) targets.push(meta.auditorSessionID);
    await Promise.allSettled(
      targets.map((sid) =>
        abortSessionServer(sid, meta.workspace).catch(() => undefined),
      ),
    );
    console.log(
      `[board/auto-ticker] ${swarmRunID}: stop(${reason}) aborted ${targets.length} session(s)`,
    );

    try {
      const { generateRollupById } = await import('../../memory/rollup');
      await generateRollupById(swarmRunID);
      console.log(
        `[board/auto-ticker] ${swarmRunID}: rollup generated post-stop`,
      );
    } catch (err) {
      console.warn(
        `[board/auto-ticker] ${swarmRunID}: rollup generation failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  })();
}
