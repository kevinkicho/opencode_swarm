'use client';

// Sub-views for CostDashboard:
//   TotalCell           one of the 3 big numbers at the top
//   WeeklySparkline     7-day bar chart of daily spend
//   WorkspaceBreakdown  per-repo rollup with a thin proportion bar
//   TopExpensive        top 5 most expensive runs as deeplinks
//
// Lifted from cost-dashboard.tsx 2026-04-28 — pure renders driven by
// the aggregates produced by ./helpers::deriveAggregates.

import clsx from 'clsx';
import Link from 'next/link';
import type { SwarmRunListRow } from '@/lib/swarm-run-types';
import { STATUS_VISUAL } from '../swarm-runs-picker';
import { directiveTeaser, formatMoney, formatTokens } from './helpers';

export function TotalCell({
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

export function WeeklySparkline({
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

export function WorkspaceBreakdown({
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

export function TopExpensive({
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
                      Mirrors the aggregate banner in CostDashboard. */}
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
