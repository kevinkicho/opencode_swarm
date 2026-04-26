// Auto-ticker state module.
//
// Owns the globalThis-keyed Map of TickerState entries, the startup
// orphan-cleanup pass, the SIGINT/SIGTERM shutdown hook, and the
// snapshot-shape converters that the public read APIs return.
//
// Extracted from auto-ticker.ts in #106 phase 2. The startup-cleanup
// + shutdown-hook initialization happens lazily on the first
// `tickers()` call (HMR-stable via globalThis symbols).

import { deriveRunRow, getRun, listRuns } from '../../swarm-registry';
import { abortSessionServer } from '../../opencode-server';
import { pruneDemoLog } from '../../demo-log-retention';
import { readTickerSnapshot } from '../ticker-snapshots';
import { MAX_TIER } from '../planner';
import type { TickOutcome } from '../coordinator';
import {
  globalBootCleanupKey,
  globalShutdownHookKey,
  globalTickerKey,
  IDLE_TICKS_BEFORE_STOP,
  type GlobalWithTickers,
  type TickerMap,
  type TickerSnapshot,
  type TickerState,
} from './types';

// Horizon for startup cleanup: only runs created in the last 48 h get
// audited. Anything older is near-certainly settled (Zen 429s time out
// well before this) and aborting sessions on it just spams opencode.
// If we ever see actual bleed from older runs, widen this; for now it's
// the noise / safety tradeoff that fits the size of our registry.
const STARTUP_CLEANUP_HORIZON_MS = 48 * 60 * 60 * 1000;

// Skip-cleanup threshold: if a run shows activity within this window we
// treat it as live + hands-off, leaving the orphan-cleanup to wait for
// the next dev restart. Catches the case observed 2026-04-24 where
// dev restart fired the cleanup mid-run (planner had ~1 min idle), the
// cleanup aborted the live planner, and the user lost their actively-
// generating run. STATUS.md "auto-ticker startup-cleanup too aggressive"
// queue item.
const STARTUP_CLEANUP_RECENT_ACTIVITY_MS = 5 * 60 * 1000;

export function tickers(): TickerMap {
  const g = globalThis as GlobalWithTickers;
  if (!g[globalTickerKey]) g[globalTickerKey] = new Map();
  // Startup orphan-session cleanup. Covers the SIGKILL / crash / reboot
  // gap where no shutdown handler ran and any in-flight opencode turns
  // were left burning tokens. Fires once per process, early, before the
  // user can launch a new run on top of the orphans. Restricted to runs
  // created within STARTUP_CLEANUP_HORIZON_MS so we don't spray opencode
  // with aborts on long-dead runs.
  if (!g[globalBootCleanupKey]) {
    g[globalBootCleanupKey] = true;
    void (async () => {
      try {
        const all = await listRuns();
        const cutoff = Date.now() - STARTUP_CLEANUP_HORIZON_MS;
        const recent = all.filter((m) => m.createdAt >= cutoff);
        if (recent.length > 0) {
          // Filter out runs with recent activity — those are healthy
          // (probably actively running) and aborting their sessions
          // would kill live planners. We check via deriveRunRow for
          // each recent run's lastActivityTs; if it falls inside
          // STARTUP_CLEANUP_RECENT_ACTIVITY_MS, skip. The check is
          // sequential rather than parallel because at startup there
          // are usually only a handful of recent runs and we don't
          // want to flood opencode with N parallel session lookups
          // before the actual cleanup work.
          const recentActivityCutoff =
            Date.now() - STARTUP_CLEANUP_RECENT_ACTIVITY_MS;
          const orphans: typeof recent = [];
          let skippedAlive = 0;
          for (const meta of recent) {
            try {
              const row = await deriveRunRow(meta);
              const lastActive = row.lastActivityTs ?? meta.createdAt;
              if (lastActive >= recentActivityCutoff) {
                skippedAlive += 1;
                continue;
              }
            } catch {
              // If we can't compute status (opencode unreachable for
              // this run's sessions, etc.), be conservative — fall
              // through and treat as an orphan. Status-unknown is
              // closer to dead than alive.
            }
            orphans.push(meta);
          }
          if (skippedAlive > 0) {
            console.log(
              `[board/auto-ticker] startup: skipped ${skippedAlive} run(s) with recent activity (< ${Math.round(STARTUP_CLEANUP_RECENT_ACTIVITY_MS / 60000)}m) — orphan-cleanup leaves them alone`,
            );
          }
          if (orphans.length > 0) {
            let targets = 0;
            await Promise.allSettled(
              orphans.flatMap((meta) => {
                const sids = [...meta.sessionIDs];
                if (meta.criticSessionID) sids.push(meta.criticSessionID);
                if (meta.verifierSessionID) sids.push(meta.verifierSessionID);
                if (meta.auditorSessionID) sids.push(meta.auditorSessionID);
                targets += sids.length;
                return sids.map((sid) =>
                  abortSessionServer(sid, meta.workspace).catch(() => undefined),
                );
              }),
            );
            console.log(
              `[board/auto-ticker] startup: aborted ${targets} session(s) across ${orphans.length} orphan run(s) (< ${Math.round(STARTUP_CLEANUP_HORIZON_MS / 3600000)}h old, > ${Math.round(STARTUP_CLEANUP_RECENT_ACTIVITY_MS / 60000)}m idle)`,
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[board/auto-ticker] startup cleanup failed: ${message}`);
      }
      // Demo-log retention: always-safe compress, opt-in delete. Runs
      // in the same startup pass so users don't have to remember to
      // invoke scripts/prune_demo_log.mjs manually. See
      // lib/server/demo-log-retention.ts.
      try {
        const s = await pruneDemoLog();
        if (s.scanned > 0) {
          console.log(
            `[board/auto-ticker] startup: demo-log retention — scanned=${s.scanned} compressed=${s.compressed} deleted=${s.deleted} errors=${s.errors}`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[board/auto-ticker] startup demo-log prune failed: ${message}`);
      }
    })();
  }
  // Install shutdown hook once per process so a dev-server Ctrl+C or
  // a parent-signal kill cleanly stops every live ticker — clearInterval
  // on each, flip state.stopped=true. Without this, SIGTERM dumps the
  // ticker map mid-tick with no trace. Guarded by a symbol so HMR
  // reloads don't re-register 200 listeners.
  if (!g[globalShutdownHookKey]) {
    g[globalShutdownHookKey] = true;
    // Guard so repeated signals don't re-enter the shutdown. Also
    // prevents the `beforeExit` handler from firing a second time
    // after our own async work unblocks it.
    let shuttingDown = false;
    // Hard cap on how long we'll wait for the abort HTTP calls to
    // resolve before forcing exit. Important: if opencode itself is
    // hung (the very state that often triggers a shutdown), the
    // abort calls can take the full opencode timeout. 5s keeps exit
    // snappy while still giving the quick path (opencode alive and
    // reachable) a realistic budget to finish N parallel aborts.
    const ABORT_BUDGET_MS = 5_000;
    const shutdown = async (signal: string, exitCode?: number) => {
      if (shuttingDown) return;
      shuttingDown = true;
      const map = g[globalTickerKey];
      if (!map || map.size === 0) {
        if (exitCode !== undefined) process.exit(exitCode);
        return;
      }
      console.log(
        `[board/auto-ticker] ${signal}: stopping ${map.size} ticker(s) + aborting sessions before exit`,
      );
      // Clear timers synchronously first — they'd otherwise keep the
      // event loop alive past our exit call. Then collect abort work
      // and await it with a budget so we don't hang an interactive
      // shell. fire-and-forget (our pre-b70d594 approach) loses the
      // HTTP responses when the process exits; this version actually
      // waits for opencode to acknowledge each abort.
      const aborts: Promise<unknown>[] = [];
      for (const state of map.values()) {
        if (state.stopped) continue;
        if (state.timer) clearInterval(state.timer);
        state.timer = null;
        if (state.periodicSweepTimer) clearInterval(state.periodicSweepTimer);
        state.periodicSweepTimer = null;
        if (state.livenessTimer) clearInterval(state.livenessTimer);
        state.livenessTimer = null;
        state.stopped = true;
        state.stoppedAtMs = Date.now();
        state.stopReason = 'manual';
        const swarmRunID = state.swarmRunID;
        aborts.push(
          (async () => {
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
          })(),
        );
      }
      await Promise.race([
        Promise.allSettled(aborts),
        new Promise((r) => setTimeout(r, ABORT_BUDGET_MS)),
      ]);
      console.log(
        `[board/auto-ticker] ${signal}: shutdown complete (${aborts.length} run(s) aborted or budget-timed-out)`,
      );
      if (exitCode !== undefined) process.exit(exitCode);
    };
    // SIGINT=130, SIGTERM=143 are the conventional "user interrupted"
    // exit codes. `beforeExit` fires for natural (no-signal) exits and
    // we let Node finish on its own — calling process.exit inside its
    // handler is an anti-pattern.
    process.on('SIGINT', () => void shutdown('SIGINT', 130));
    process.on('SIGTERM', () => void shutdown('SIGTERM', 143));
    process.on('beforeExit', () => void shutdown('beforeExit'));
  }
  return g[globalTickerKey]!;
}

// Defensive: state entries written before the 2026-04-22 per-session
// refactor carry `inFlight`/`consecutiveIdle` directly on the object
// with no `slots` Map. After the new module loads over the old one via
// Next.js HMR the globalThis map still holds those entries. Returning
// them as "stopped-looking" keeps the ticker API from 500ing for runs
// the user opened before the reload — fresh runs from startAutoTicker
// always use the new shape.
export function snapshot(s: TickerState): TickerSnapshot {
  const slotMap = s.slots;
  const slots =
    slotMap && typeof slotMap.values === 'function' ? [...slotMap.values()] : [];
  const inFlight = slots.some((sl) => sl.inFlight);
  // min(consecutiveIdle): auto-stop fires when EVERY slot >= threshold,
  // so the UI's countdown tracks the slot closest to keeping the run alive.
  // Empty slots (pre-first-fanout) report 0, matching the original semantics.
  const consecutiveIdle =
    slots.length === 0 ? 0 : Math.min(...slots.map((sl) => sl.consecutiveIdle));
  // Most recent outcome across any session is the one worth surfacing.
  let lastRanAtMs: number | undefined;
  let lastOutcome: TickOutcome | undefined;
  for (const sl of slots) {
    if (sl.lastRanAtMs == null) continue;
    if (lastRanAtMs == null || sl.lastRanAtMs > lastRanAtMs) {
      lastRanAtMs = sl.lastRanAtMs;
      lastOutcome = sl.lastOutcome;
    }
  }
  return {
    swarmRunID: s.swarmRunID,
    intervalMs: s.intervalMs,
    inFlight,
    stopped: s.stopped,
    stoppedAtMs: s.stoppedAtMs,
    stopReason: s.stopReason,
    consecutiveIdle,
    idleThreshold: IDLE_TICKS_BEFORE_STOP,
    lastOutcome,
    lastRanAtMs,
    startedAtMs: s.startedAtMs,
    currentTier: s.currentTier ?? 1,
    tierExhausted: s.tierExhausted ?? false,
    maxTier: MAX_TIER,
    // #7.Q21 — propagate the running commits counter. Defaults to 0
    // for legacy entries from the old shape (HMR carryover) so the
    // field is always defined per the type contract.
    totalCommits: s.totalCommits ?? 0,
    retryAfterEndsAtMs: s.retryAfterEndsAtMs,
  };
}

// Observability: surface current tickers for a debug route / smoke script.
export function listAutoTickers(): TickerSnapshot[] {
  return [...tickers().values()].map(snapshot);
}

// Single-run observability — feeds the board-rail ticker chip. Returns
// null when no ticker has ever run for this id (vs. stopped, which keeps
// an entry in the map with stopped: true).
export function getTickerSnapshot(swarmRunID: string): TickerSnapshot | null {
  const s = tickers().get(swarmRunID);
  if (s) return snapshot(s);

  // PATTERN_DESIGN/blackboard.md I3 — fallback to the persisted
  // snapshot when no in-memory state exists. After dev restart the
  // tickers map is empty; without this hydration the UI sees
  // "ticker never ran" instead of the original stop reason.
  // Only fires when in-memory is empty — running tickers always
  // win.
  const persisted = readTickerSnapshot(swarmRunID);
  if (!persisted) return null;
  // The persisted snapshot was written by snapshot() so the shape
  // matches TickerSnapshot exactly — return as-is. Defensive cast
  // because the read path stores it as Record<string, unknown> to
  // stay decoupled from this module's type.
  return persisted.snapshot as unknown as TickerSnapshot;
}
