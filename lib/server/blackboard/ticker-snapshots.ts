// Persistent ticker stop snapshots. 
//
// The in-memory tickers map is process-local; on dev-server restart
// or HMR module reload, every run's stop reason vanishes and the UI
// shows "no ticker ever ran" instead of "stopped: <reason> at <time>".
// This module persists the final TickerSnapshot for any stopped run
// so getTickerSnapshot can reconstruct after a restart.
//
// Only terminal state lives here — active runs continue to source
// their snapshots from the in-memory cache. Persistence fires once,
// on stopAutoTicker.
//
// Server-only.

import 'server-only';

import { blackboardDb } from './db';

export interface PersistedTickerSnapshot {
  swarmRunID: string;
  stoppedAtMs: number;
  stopReason: string;
  // Opaque to this module — TickerSnapshot shape lives in auto-ticker.ts.
  // We don't import the type here to keep this module decoupled and
  // forward-compatible (snapshot fields can grow without schema churn).
  snapshot: Record<string, unknown>;
  createdAt: number;
}

interface PersistedRow {
  swarm_run_id: string;
  stopped_at: number;
  stop_reason: string;
  snapshot_json: string;
  created_at: number;
}

export function persistTickerSnapshot(
  swarmRunID: string,
  stoppedAtMs: number,
  stopReason: string,
  snapshot: Record<string, unknown>,
): void {
  blackboardDb()
    .prepare(
      `INSERT INTO ticker_snapshots
       (swarm_run_id, stopped_at, stop_reason, snapshot_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(swarm_run_id) DO UPDATE SET
         stopped_at = excluded.stopped_at,
         stop_reason = excluded.stop_reason,
         snapshot_json = excluded.snapshot_json,
         created_at = excluded.created_at`,
    )
    .run(
      swarmRunID,
      stoppedAtMs,
      stopReason,
      JSON.stringify(snapshot),
      Date.now(),
    );
}

export function readTickerSnapshot(
  swarmRunID: string,
): PersistedTickerSnapshot | null {
  const row = blackboardDb()
    .prepare(
      `SELECT * FROM ticker_snapshots WHERE swarm_run_id = ?`,
    )
    .get(swarmRunID) as PersistedRow | undefined;
  if (!row) return null;
  let snapshot: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.snapshot_json) as unknown;
    snapshot =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    snapshot = {};
  }
  return {
    swarmRunID: row.swarm_run_id,
    stoppedAtMs: row.stopped_at,
    stopReason: row.stop_reason,
    snapshot,
    createdAt: row.created_at,
  };
}
