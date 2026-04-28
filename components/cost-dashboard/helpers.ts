// Pure helpers + cross-run aggregation for the CostDashboard.
//
// Lifted from cost-dashboard.tsx 2026-04-28. No React, no DOM —
// formatting + bucketing + per-workspace rollup. Extracted so the
// dashboard module body stays layout-focused and the math is
// trivially testable if we ever want to.

import type { SwarmRunListRow } from '@/lib/swarm-run-types';

// Seven daily buckets, ending today. Epoch ms at start-of-day, local tz —
// matches how a human reads "this week's spend" on a calendar.
export function weeklyBuckets(now: number): { start: number; end: number; label: string }[] {
  const out: { start: number; end: number; label: string }[] = [];
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  for (let i = 6; i >= 0; i--) {
    const start = d.getTime() - i * 86_400_000;
    const end = start + 86_400_000;
    const day = new Date(start);
    const label = day.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2);
    out.push({ start, end, label });
  }
  return out;
}

// Short workspace label — strip the common parent path so repos show as
// `repo` instead of `C:/Users/kevin/Desktop/repo`. Falls back to the full
// path when no common prefix exists.
export function shortWorkspace(ws: string, common: string): string {
  if (!common) return ws;
  if (ws === common) return '.';
  return ws.startsWith(common) ? ws.slice(common.length).replace(/^[\\/]+/, '') : ws;
}

export function commonPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  if (paths.length === 1) return paths[0].replace(/[\\/][^\\/]+$/, '');
  let prefix = paths[0];
  for (const p of paths.slice(1)) {
    while (!p.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return '';
    }
  }
  // Trim to the last separator so we split on path boundaries, not mid-name.
  const idx = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
  return idx >= 0 ? prefix.slice(0, idx) : prefix;
}

export function formatMoney(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  if (n < 10) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${n.toFixed(1)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

export function formatTokens(n: number): string {
  if (n === 0) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function directiveTeaser(d: string | undefined, cap = 48): string {
  if (!d) return '(no directive)';
  const first = d.split('\n', 1)[0]?.trim() ?? '';
  return first.length > cap ? first.slice(0, cap).replace(/\s+$/, '') + '…' : first;
}

// Pure projection: rows → everything the dashboard renders.
export function deriveAggregates(rows: SwarmRunListRow[]) {
  const costTotal = rows.reduce((s, r) => s + r.costTotal, 0);
  const tokensTotal = rows.reduce((s, r) => s + r.tokensTotal, 0);
  const liveCount = rows.filter((r) => r.status === 'live').length;

  // Weekly bucketing: assign each run's cost to the day it was created.
  // Not the day activity happened — createdAt is cheap, lastActivityTs
  // may be null, and for "this week's spend" the creation day is the
  // honest anchor for budget-thinking users.
  const buckets = weeklyBuckets(Date.now());
  const weekly = buckets.map((b) => {
    const hits = rows.filter((r) => r.meta.createdAt >= b.start && r.meta.createdAt < b.end);
    const cost = hits.reduce((s, r) => s + r.costTotal, 0);
    return { label: b.label, cost, runs: hits.length, dayStart: b.start };
  });
  const weeklyMax = weekly.reduce((m, b) => Math.max(m, b.cost), 0);

  // Per-workspace rollup. Path shortening uses the common prefix across
  // workspaces so a user who runs against ~/code/foo and ~/code/bar sees
  // `foo` / `bar` rather than the full absolute paths.
  const common = commonPrefix(rows.map((r) => r.meta.workspace));
  const wsMap = new Map<string, { cost: number; tokens: number; runs: number }>();
  for (const r of rows) {
    const existing = wsMap.get(r.meta.workspace) ?? { cost: 0, tokens: 0, runs: 0 };
    existing.cost += r.costTotal;
    existing.tokens += r.tokensTotal;
    existing.runs += 1;
    wsMap.set(r.meta.workspace, existing);
  }
  const byWorkspace = [...wsMap.entries()]
    .map(([workspace, v]) => ({
      workspace,
      short: shortWorkspace(workspace, common),
      cost: v.cost,
      tokens: v.tokens,
      runs: v.runs,
    }))
    .sort((a, b) => b.cost - a.cost);

  const topExpensive = [...rows]
    .sort((a, b) => b.costTotal - a.costTotal)
    .filter((r) => r.costTotal > 0)
    .slice(0, 5);

  return { costTotal, tokensTotal, liveCount, weekly, weeklyMax, byWorkspace, topExpensive };
}
