'use client';

// Cross-run cost + token dashboard.
//
// This is the first surface that aggregates across every persisted run
// rather than scoping to one. It exists to answer "where's my spend
// going this week?" without having to open each run individually.
//
// Design choices:
//   - Single read source (useSwarmRuns). The list endpoint already folds
//     cost/tokens into every row via deriveRunRow (see swarm-registry.ts),
//     so the dashboard is a pure client-side projection — no second fan-
//     out, no new endpoint.
//   - Dense sections, one story each: totals / sparkline / per-workspace
//     / top-5 expensive. A user scanning this should be able to answer
//     "is the spend where I expect" in under 10 seconds.
//   - Read-only. Mutation of runs (delete, archive) is explicitly out of
//     scope here — retention is a backend concern per DESIGN.md §7.7.

import clsx from 'clsx';
import Link from 'next/link';
import { useMemo } from 'react';
import { Drawer } from './ui/drawer';
import { useSwarmRuns } from '@/lib/opencode/live';
import type { SwarmRunListRow } from '@/lib/swarm-run-types';
import { STATUS_VISUAL } from './swarm-runs-picker';

// Seven daily buckets, ending today. Epoch ms at start-of-day, local tz —
// matches how a human reads "this week's spend" on a calendar.
function weeklyBuckets(now: number): { start: number; end: number; label: string }[] {
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
function shortWorkspace(ws: string, common: string): string {
  if (!common) return ws;
  if (ws === common) return '.';
  return ws.startsWith(common) ? ws.slice(common.length).replace(/^[\\/]+/, '') : ws;
}

function commonPrefix(paths: string[]): string {
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

function formatMoney(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  if (n < 10) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${n.toFixed(1)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

function formatTokens(n: number): string {
  if (n === 0) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function directiveTeaser(d: string | undefined, cap = 48): string {
  if (!d) return '(no directive)';
  const first = d.split('\n', 1)[0]?.trim() ?? '';
  return first.length > cap ? first.slice(0, cap).replace(/\s+$/, '') + '…' : first;
}

export function CostDashboard({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  // Always poll at 4s — the endpoint is local and cheap, and keeping the
  // data warm means the dashboard is already populated when the user
  // opens the drawer. The picker polls independently; duplication is
  // trivial at prototype scale. When/if we add the deferred list-endpoint
  // cache (DESIGN.md §7 follow-up), both consumers coalesce automatically.
  const { rows, error, loading, lastUpdated } = useSwarmRuns(4000);

  const derived = useMemo(() => deriveAggregates(rows), [rows]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      eyebrow="cross-run cost"
      title="spend & tokens"
      width={520}
    >
      <div className="flex flex-col min-h-0 h-full">
        <div className="px-4 py-2.5 hairline-b flex items-center gap-3 bg-ink-900/40">
          <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
            totals
          </span>
          <span className="font-mono text-[11px] text-fog-700 ml-auto tabular-nums">
            {loading && lastUpdated === null
              ? 'scanning…'
              : error
                ? <span className="text-rust break-all">{error}</span>
                : `${rows.length} ${rows.length === 1 ? 'run' : 'runs'}`}
          </span>
        </div>

        <div className="px-4 py-3 hairline-b grid grid-cols-3 gap-3">
          <TotalCell label="$ spent" value={formatMoney(derived.costTotal)} tone="molten" />
          <TotalCell label="tokens" value={formatTokens(derived.tokensTotal)} tone="iris" />
          <TotalCell label="live now" value={String(derived.liveCount)} tone={derived.liveCount > 0 ? 'mint' : 'fog'} />
        </div>

        {/* Bundle-model banner: if any row has tokens > 0 but $0, the
            model is likely a Zen subscription bundle (big-pickle etc.)
            where the per-token price is $0 and the real cost is
            subscription-metered elsewhere. Without this note a pure-
            bundle fleet reads as "$0.00 for 20M tokens — something
            broken." Appears only when the signal is actually present. */}
        {derived.costTotal === 0 && derived.tokensTotal > 0 && (
          <div className="px-4 py-2 hairline-b flex items-center gap-2 bg-ink-900/40">
            <span className="font-mono text-[10px] text-fog-500">🏷️</span>
            <span className="font-mono text-[10.5px] text-fog-400 leading-snug">
              zero <span className="text-fog-600">$ spent</span> is expected
              for bundle-priced models (big-pickle / zen subscription) —
              per-token price is zero; subscription cost is billed
              separately by opencode.
            </span>
          </div>
        )}

        <WeeklySparkline buckets={derived.weekly} maxCost={derived.weeklyMax} />

        <WorkspaceBreakdown rows={derived.byWorkspace} />

        <TopExpensive rows={derived.topExpensive} onNavigate={onClose} />

        {!loading && rows.length === 0 && !error && (
          <div className="px-4 py-6 text-[11px] text-fog-600 flex items-center gap-2">
            <span className="w-1 h-1 rounded-full bg-fog-700" />
            no runs yet — start one from the new run button in the status rail
          </div>
        )}
      </div>
    </Drawer>
  );
}

function TotalCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'molten' | 'iris' | 'mint' | 'fog';
}) {
  const color =
    tone === 'molten' ? 'text-molten' :
    tone === 'iris'   ? 'text-iris' :
    tone === 'mint'   ? 'text-mint' :
                        'text-fog-400';
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600 truncate">
        {label}
      </span>
      <span className={clsx('font-mono text-[18px] tabular-nums truncate', color)}>
        {value}
      </span>
    </div>
  );
}

function WeeklySparkline({
  buckets,
  maxCost,
}: {
  buckets: { label: string; cost: number; runs: number; dayStart: number }[];
  maxCost: number;
}) {
  const todayStart = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  return (
    <div className="px-4 py-3 hairline-b">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
          last 7 days
        </span>
        <span className="font-mono text-[10px] text-fog-700 tabular-nums ml-auto">
          peak {formatMoney(maxCost)}
        </span>
      </div>
      <div className="flex items-end gap-1 h-16">
        {buckets.map((b, i) => {
          const pct = maxCost > 0 ? (b.cost / maxCost) * 100 : 0;
          const isToday = b.dayStart === todayStart;
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0">
              <div className="relative w-full flex-1 flex items-end">
                <div
                  className={clsx(
                    'w-full rounded-t transition-all',
                    b.cost > 0
                      ? isToday ? 'bg-molten' : 'bg-molten/60'
                      : 'bg-ink-800'
                  )}
                  style={{ height: `${Math.max(pct, b.cost > 0 ? 4 : 2)}%` }}
                  title={`${b.label}: ${formatMoney(b.cost)} across ${b.runs} run${b.runs === 1 ? '' : 's'}`}
                />
              </div>
              <span
                className={clsx(
                  'font-mono text-[9px] uppercase tabular-nums',
                  isToday ? 'text-molten' : 'text-fog-700'
                )}
              >
                {b.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WorkspaceBreakdown({
  rows,
}: {
  rows: { workspace: string; short: string; cost: number; tokens: number; runs: number }[];
}) {
  const total = rows.reduce((s, r) => s + r.cost, 0);
  return (
    <div className="hairline-b">
      <div className="px-4 h-6 hairline-b bg-ink-900/30 flex items-center">
        <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
          by workspace
        </span>
        <span className="font-mono text-[10px] text-fog-700 tabular-nums ml-auto">
          {rows.length} {rows.length === 1 ? 'repo' : 'repos'}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-3 text-[11px] text-fog-600">no workspaces yet</div>
      ) : (
        <ul className="max-h-[180px] overflow-y-auto divide-y divide-ink-800">
          {rows.map((r) => {
            const pct = total > 0 ? (r.cost / total) * 100 : 0;
            return (
              <li
                key={r.workspace}
                className="px-4 h-7 flex items-center gap-2"
                title={r.workspace}
              >
                <span className="font-mono text-[11px] text-fog-200 truncate flex-1 min-w-0">
                  {r.short || '.'}
                </span>
                <span className="relative w-16 h-1 rounded-full bg-ink-900 overflow-hidden shrink-0">
                  <span
                    className="absolute inset-y-0 left-0 bg-molten/70 rounded-full"
                    style={{ width: `${pct}%` }}
                  />
                </span>
                <span className="font-mono text-[10px] text-fog-600 tabular-nums w-10 text-right shrink-0">
                  {r.runs}
                </span>
                <span className="font-mono text-[10.5px] text-molten tabular-nums w-14 text-right shrink-0">
                  {formatMoney(r.cost)}
                </span>
                <span className="font-mono text-[9.5px] text-fog-600 tabular-nums w-12 text-right shrink-0">
                  {formatTokens(r.tokens)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function TopExpensive({
  rows,
  onNavigate,
}: {
  rows: SwarmRunListRow[];
  onNavigate: () => void;
}) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 h-6 hairline-b bg-ink-900/30 flex items-center">
        <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
          top 5 by spend
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-3 text-[11px] text-fog-600">—</div>
      ) : (
        <ul className="flex-1 overflow-y-auto divide-y divide-ink-800">
          {rows.map((row, i) => {
            const visual = STATUS_VISUAL[row.status];
            return (
              <li key={row.meta.swarmRunID}>
                <Link
                  href={`/?swarmRun=${row.meta.swarmRunID}`}
                  onClick={() => onNavigate()}
                  className="px-4 py-2 flex items-center gap-2 hover:bg-ink-800/60 transition"
                  title={row.meta.directive ?? row.meta.swarmRunID}
                >
                  <span className="font-mono text-[10px] text-fog-700 tabular-nums w-4 text-right shrink-0">
                    #{i + 1}
                  </span>
                  <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', visual.dot)} />
                  <span className="font-mono text-[11px] text-fog-200 truncate flex-1 min-w-0">
                    {directiveTeaser(row.meta.directive, 56)}
                  </span>
                  {/* Per-row bundle marker: a row with $0 cost but >0 tokens
                      is almost certainly a Zen subscription bundle model
                      (big-pickle), not actually free. Tag it so readers
                      don't confuse the row with a genuinely-zero run.
                      Mirrors the aggregate banner at line 139. */}
                  {row.costTotal === 0 && row.tokensTotal > 0 && (
                    <span
                      className="font-mono text-[8.5px] uppercase tracking-widest2 text-mint/70 px-1 rounded-sm hairline shrink-0"
                      title="bundle-priced model (big-pickle / zen subscription) — token cost covered by the subscription, not per-run"
                    >
                      bundle
                    </span>
                  )}
                  <span className="font-mono text-[10.5px] text-molten tabular-nums w-14 text-right shrink-0">
                    {formatMoney(row.costTotal)}
                  </span>
                  <span className="font-mono text-[9.5px] text-fog-600 tabular-nums w-12 text-right shrink-0">
                    {formatTokens(row.tokensTotal)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Pure projection: rows → everything the dashboard renders. Extracted so
// the component body stays layout-focused and the math is trivially
// testable if we ever want to.
function deriveAggregates(rows: SwarmRunListRow[]) {
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
