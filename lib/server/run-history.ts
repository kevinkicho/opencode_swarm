import 'server-only';

import { listRuns } from '@/lib/server/swarm-registry';
import { memoryDb } from '@/lib/server/memory/db';

export interface RunHistoryEntry {
  swarmRunID: string;
  pattern: string;
  directive: string;
  teamSize: number;
  costTotal: number;
  tokensTotal: number;
  todosCompleted: number;
  todosStale: number;
  costPerTodo: number;
  completionRate: number;
  createdAt: number;
  source?: string;
}

export async function readRunHistory(maxRuns = 20): Promise<RunHistoryEntry[]> {
  const metas = await listRuns();
  const db = memoryDb();

  // Fetch retro rollups for cost/outcome data (best-effort — rollups
  // may not exist for runs that haven't been finalized).
  const retroRows = db
    .prepare(
      `SELECT swarm_run_id, payload FROM rollups WHERE kind = 'retro' ORDER BY closed_at DESC`,
    )
    .all() as Array<{ swarm_run_id: string; payload: string }>;
  const retrosByRun = new Map<string, { costUSD: number; tokensTotal: number; outcome: string }>();
  for (const row of retroRows) {
    try {
      const p = JSON.parse(row.payload);
      retrosByRun.set(row.swarm_run_id, {
        costUSD: typeof p.cost?.costUSD === 'number' ? p.cost.costUSD : 0,
        tokensTotal: typeof p.cost?.tokensTotal === 'number' ? p.cost.tokensTotal : 0,
        outcome: typeof p.outcome === 'string' ? p.outcome : '',
      });
    } catch {
      /* skip corrupt rollup */
    }
  }

  const entries: RunHistoryEntry[] = [];

  for (const meta of metas) {
    const retro = retrosByRun.get(meta.swarmRunID);
    const costTotal = retro?.costUSD ?? 0;
    // Completion: retro outcome 'completed' → 1.0, 'aborted' / 'failed' → partial,
    // no retro → 0 for unknown.
    let completionRate = 0;
    if (retro) {
      if (retro.outcome === 'completed') completionRate = 1.0;
      else if (retro.outcome === 'aborted') completionRate = 0.5;
      else if (retro.outcome === 'failed') completionRate = 0.2;
    }
    // Treat completed runs as having 1 "todo completed" for cost/todo computation.
    // Without per-todo data in the retro, costPerTodo ≈ total cost for now.
    const todosCompleted = completionRate > 0 ? 1 : 0;

    entries.push({
      swarmRunID: meta.swarmRunID,
      pattern: meta.pattern ?? 'unknown',
      directive: meta.directive ?? '',
      teamSize: (meta.sessionIDs ?? []).length,
      costTotal,
      tokensTotal: retro?.tokensTotal ?? 0,
      todosCompleted,
      todosStale: 0,
      costPerTodo: costTotal > 0 && todosCompleted > 0 ? costTotal / todosCompleted : 0,
      completionRate,
      createdAt: meta.createdAt ?? 0,
      source: meta.source,
    });
  }

  return entries
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, maxRuns);
}

export function recommendFromHistory(
  directive: string,
  history: RunHistoryEntry[],
): {
  pattern: string;
  teamSize: number;
  confidence: string;
  avgCostPerTodo: number;
  basedOn: number;
  reason: string;
} | null {
  if (history.length === 0) return null;

  const keywords = directive
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);

  // Score each historical run by keyword overlap in the directive.
  const scored = history.map((run) => {
    const dirLower = (run.directive || '').toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (dirLower.includes(kw)) score += 1;
    }
    if (run.source) score += 1;
    return { ...run, score };
  });

  const relevant = scored
    .filter((r) => r.score >= 2)
    .sort((a, b) => b.score - a.score);
  if (relevant.length === 0) return null;

  // Aggregate by pattern — find the best-performing pattern.
  const byPattern = new Map<
    string,
    { count: number; totalCost: number; totalTodos: number; totalRate: number }
  >();
  for (const r of relevant) {
    const agg = byPattern.get(r.pattern) || {
      count: 0,
      totalCost: 0,
      totalTodos: 0,
      totalRate: 0,
    };
    agg.count += 1;
    agg.totalCost += r.costTotal || 0;
    agg.totalTodos += r.todosCompleted || 0;
    agg.totalRate += r.completionRate || 0;
    byPattern.set(r.pattern, agg);
  }

  let bestPattern = '';
  let bestRate = 0;
  let bestCount = 0;
  for (const [pattern, agg] of byPattern) {
    const avgRate = agg.totalRate / agg.count;
    if (avgRate > bestRate) {
      bestRate = avgRate;
      bestPattern = pattern;
      bestCount = agg.count;
    }
  }

  const bestPatternRuns = relevant.filter((r) => r.pattern === bestPattern);
  const avgTeamSize = Math.round(
    bestPatternRuns.reduce((s, r) => s + r.teamSize, 0) / bestPatternRuns.length,
  );
  const avgCost =
    bestPatternRuns.reduce((s, r) => s + r.costPerTodo, 0) / bestPatternRuns.length;

  return {
    pattern: bestPattern,
    teamSize: Math.max(2, avgTeamSize),
    confidence: bestCount >= 3 ? 'high' : 'medium',
    avgCostPerTodo: avgCost,
    basedOn: bestCount,
    reason: `Based on ${bestCount} similar run(s) with ${(bestRate * 100).toFixed(0)}% completion rate at $${avgCost.toFixed(3)}/todo`,
  };
}
