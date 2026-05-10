#!/usr/bin/env npx tsx
// @ts-nocheck
//
// Morning summary — run daily via cron. Reads the runs ledger and
// produces a concise report of overnight activity.
//
// Usage: npx tsx scripts/morning-summary.ts

import { readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';

const ROOT = process.env.OPENCODE_SWARM_ROOT || resolve(process.cwd(), '.opencode_swarm');
const MEMORY_DB = join(ROOT, 'memory.sqlite');
const BOARD_DB = join(ROOT, 'blackboard.sqlite');

interface RunSummary {
  id: string;
  pattern: string;
  cost: number;
  tokens: number;
  todosCompleted: number;
  todosStale: number;
  durationMin: number;
  stoppedBy: string;
  startedAt: string;
}

function openDb(path: string) {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

function getRecentRuns(sinceHours: number): RunSummary[] {
  const memDb = openDb(MEMORY_DB);
  if (!memDb) return [];
  const boardDb = openDb(BOARD_DB);

  const now = Date.now();
  const cutoff = now - sinceHours * 60 * 60 * 1000;
  const summaries: RunSummary[] = [];

  try {
    const rows = memDb
      .prepare('SELECT swarm_run_id, payload, created_at FROM runs WHERE created_at >= ?')
      .all(cutoff) as Array<{ swarm_run_id: string; payload: string; created_at: number }>;

    for (const row of rows) {
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(row.payload);
      } catch { continue; }

      let todosCompleted = 0;
      let todosStale = 0;

      if (boardDb) {
        const done = boardDb
          .prepare(
            `SELECT COUNT(*) AS n FROM board_items
             WHERE swarm_run_id = ? AND status = 'done' AND kind != 'criterion'`,
          )
          .get(row.swarm_run_id) as { n: number } | undefined;
        todosCompleted = done?.n ?? 0;

        const stale = boardDb
          .prepare(
            `SELECT COUNT(*) AS n FROM board_items
             WHERE swarm_run_id = ? AND status = 'stale' AND kind != 'criterion'`,
          )
          .get(row.swarm_run_id) as { n: number } | undefined;
        todosStale = stale?.n ?? 0;
      }

      // Get cost from rollups
      let cost = 0;
      let tokens = 0;
      try {
        const retroRow = memDb
          .prepare(
            `SELECT payload FROM rollups
             WHERE swarm_run_id = ? AND kind = 'retro'
             ORDER BY closed_at DESC LIMIT 1`,
          )
          .get(row.swarm_run_id) as { payload: string } | undefined;
        if (retroRow) {
          const retro = JSON.parse(retroRow.payload);
          cost = retro.counters?.costUSD ?? 0;
          tokens = retro.counters?.tokensTotal ?? 0;
        }
      } catch { /* no rollup yet */ }

      // Duration from ticker snapshot if available
      let durationMin = 0;
      try {
        const snapshotsDir = join(ROOT, 'runs', row.swarm_run_id);
        if (existsSync(snapshotsDir)) {
          const files = readdirSync(snapshotsDir).filter((f) => f.startsWith('ticker-snapshot-'));
          if (files.length > 0) {
            const latest = files.sort().pop()!;
            const snap = JSON.parse(
              require('fs').readFileSync(join(snapshotsDir, latest), 'utf8'),
            );
            if (snap && snap.snapshot) {
              const sn = snap.snapshot;
              if (sn.startedAtMs && (sn.stoppedAtMs || sn.stopped)) {
                durationMin = Math.round(
                  ((sn.stoppedAtMs || sn.startedAtMs + 1) - sn.startedAtMs) / 60000,
                );
              } else {
                durationMin = Math.round((now - sn.startedAtMs) / 60000);
              }
            }
          }
        }
      } catch { /* no snapshot */ }

      summaries.push({
        id: meta.swarmRunID as string || row.swarm_run_id,
        pattern: (meta.pattern as string) || 'unknown',
        cost,
        tokens,
        todosCompleted,
        todosStale,
        durationMin,
        stoppedBy: 'unknown',
        startedAt: new Date(row.created_at).toISOString(),
      });
    }
  } finally {
    memDb.close();
    boardDb?.close();
  }

  return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function main(): void {
  const runs = getRecentRuns(24);

  console.log('# Swarm Morning Summary');
  console.log(`  ${new Date().toLocaleDateString()}\n`);

  if (runs.length === 0) {
    console.log('  No runs in the last 24 hours.');
    return;
  }

  const totalCost = runs.reduce((s, r) => s + r.cost, 0);
  const totalTodos = runs.reduce((s, r) => s + r.todosCompleted, 0);
  const totalStale = runs.reduce((s, r) => s + r.todosStale, 0);
  const totalTokens = runs.reduce((s, r) => s + r.tokens, 0);
  const avgCostPerTodo = totalTodos > 0 ? totalCost / totalTodos : 0;

  console.log('## Overview');
  console.log(`  Runs: ${runs.length}`);
  console.log(`  Total cost: $${totalCost.toFixed(2)}`);
  console.log(`  Total tokens: ${(totalTokens / 1_000_000).toFixed(1)}M`);
  console.log(`  Todos completed: ${totalTodos}`);
  console.log(`  Todos stale: ${totalStale}`);
  console.log(`  Cost per todo: $${avgCostPerTodo.toFixed(3)}`);
  console.log();

  console.log('## Per-Run Detail');
  console.log('| Run | Pattern | $ | Todos (done/stale) | Duration | Stop reason |');
  console.log('|-----|---------|---|-------------------|----------|-------------|');
  for (const r of runs) {
    console.log(`| ${r.id.slice(-8)} | ${r.pattern} | $${r.cost.toFixed(2)} | ${r.todosCompleted}/${r.todosStale} | ${r.durationMin}min | ${r.stoppedBy} |`);
  }

  // Health assessment
  const completionRate = totalTodos / Math.max(1, totalTodos + totalStale);
  console.log();
  if (runs.length === 0) {
    console.log('  Status: NO ACTIVITY');
  } else if (completionRate >= 0.85) {
    console.log('  Status: HEALTHY — high completion rate');
  } else if (completionRate >= 0.60) {
    console.log('  Status: OK — moderate completion rate');
  } else {
    console.log('  Status: NEEDS ATTENTION — low completion rate, check postmortems');
  }

  if (avgCostPerTodo > 0.042) {
    console.log('  Cost per todo ($' + avgCostPerTodo.toFixed(3) + ') exceeds P95 threshold ($0.042). Investigate planner token consumption.');
  }
}

main();
