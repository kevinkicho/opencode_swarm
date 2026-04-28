'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useMemo } from 'react';
import type { SwarmRunListRow, SwarmRunStatus } from '@/lib/swarm-run-types';
import type { SwarmPattern } from '@/lib/swarm-types';
import { patternMeta, patternAccentText } from '@/lib/swarm-patterns';

// Cross-preset metrics view. Aggregates every persisted swarm-run into
// per-pattern stats — the surface the user can use to answer "is council
// worth the cost?" / "how does blackboard's wall-clock compare?" without
// opening each run individually.
//
// The source of truth is the existing `/api/swarm/run` GET endpoint, which
// already carries costTotal + tokensTotal + status per row. No new backend
// aggregation needed at prototype scale (tens of runs); when the list
// starts to hurt, a server-side /api/metrics that pre-groups would be the
// obvious next step.

interface PatternStats {
  pattern: SwarmPattern;
  count: number;
  avgDurMs: number;
  medDurMs: number;
  avgCost: number;
  totalCost: number;
  avgTokens: number;
  totalTokens: number;
  livePct: number;
  stalePct: number;
  errorPct: number;
}

// Stable pattern ordering for the table so rows don't reshuffle as new
// runs land. Matches the picker's preset order in DESIGN.md §12.
const PATTERN_ORDER: SwarmPattern[] = ['blackboard', 'council', 'map-reduce', 'none'];

function formatDur(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m${rem.toString().padStart(2, '0')}` : `${m}m`;
  const h = Math.floor(m / 60);
  const mrem = m % 60;
  return mrem > 0 ? `${h}h${mrem.toString().padStart(2, '0')}` : `${h}h`;
}

function formatUsd(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '$0';
  if (v < 0.01) return '<$0.01';
  if (v < 1) return `$${v.toFixed(3)}`;
  if (v < 100) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(0)}`;
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return n.toFixed(0);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

function formatPct(n: number): string {
  // Zero is a real value, not missing data. Render "0%" so the
  // user can tell "we have data and it's 0" from "we have no data."
  // Pre-2026-04-28 this returned "—" for 0, which read as a
  // placeholder/loading-state and confused readers of the totals row.
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '0%';
  if (n < 1) return '<1%';
  return `${n.toFixed(0)}%`;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function computePatternStats(rows: SwarmRunListRow[]): PatternStats[] {
  const groups = new Map<SwarmPattern, SwarmRunListRow[]>();
  for (const r of rows) {
    const list = groups.get(r.meta.pattern) ?? [];
    list.push(r);
    groups.set(r.meta.pattern, list);
  }
  const nowMs = Date.now();
  const out: PatternStats[] = [];
  for (const [pattern, list] of groups) {
    // Use lastActivityTs for completed runs; fall back to now for in-flight
    // so a currently-running blackboard doesn't show a negative / zero dur.
    const durations = list
      .map((r) => (r.lastActivityTs ?? nowMs) - r.meta.createdAt)
      .filter((d) => d >= 0);
    const costs = list.map((r) => r.costTotal);
    const tokens = list.map((r) => r.tokensTotal);
    const statusCount: Record<SwarmRunStatus, number> = {
      live: 0,
      idle: 0,
      error: 0,
      stale: 0,
      unknown: 0,
    };
    for (const r of list) statusCount[r.status] += 1;
    const n = list.length;
    out.push({
      pattern,
      count: n,
      avgDurMs: durations.length > 0 ? sum(durations) / durations.length : 0,
      medDurMs: median(durations),
      avgCost: sum(costs) / n,
      totalCost: sum(costs),
      avgTokens: sum(tokens) / n,
      totalTokens: sum(tokens),
      livePct: (statusCount.live / n) * 100,
      stalePct: (statusCount.stale / n) * 100,
      errorPct: (statusCount.error / n) * 100,
    });
  }
  out.sort((a, b) => {
    const ai = PATTERN_ORDER.indexOf(a.pattern);
    const bi = PATTERN_ORDER.indexOf(b.pattern);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });
  return out;
}

export function CrossPresetMetrics({
  rows,
  loading,
  error,
  onRefresh,
  refreshing,
}: {
  rows: SwarmRunListRow[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const stats = useMemo(() => computePatternStats(rows), [rows]);

  const totals = useMemo(() => {
    if (rows.length === 0) return null;
    const nowMs = Date.now();
    const durations = rows
      .map((r) => (r.lastActivityTs ?? nowMs) - r.meta.createdAt)
      .filter((d) => d >= 0);
    const liveCount = rows.filter((r) => r.status === 'live').length;
    const staleCount = rows.filter((r) => r.status === 'stale').length;
    const errorCount = rows.filter((r) => r.status === 'error').length;
    const n = rows.length;
    return {
      count: n,
      avgDurMs: durations.length > 0 ? sum(durations) / durations.length : 0,
      // medDurMs across all runs — analogous to per-preset medDurMs.
      // Was unwired ("—") through 2026-04-28; cheap to compute, useful
      // because the avg is skewed by long-tail multi-day stale runs.
      medDurMs: median(durations),
      totalCost: sum(rows.map((r) => r.costTotal)),
      avgCost: sum(rows.map((r) => r.costTotal)) / n,
      totalTokens: sum(rows.map((r) => r.tokensTotal)),
      avgTokens: sum(rows.map((r) => r.tokensTotal)) / n,
      // live/stale/error percentages across ALL runs — were rendered as
      // a colSpan=3 "—" placeholder before; now show the same shape as
      // per-preset rows.
      livePct: (liveCount / n) * 100,
      stalePct: (staleCount / n) * 100,
      errorPct: (errorCount / n) * 100,
    };
  }, [rows]);

  // Oldest → newest window bounds for the subtitle. Null when no runs.
  const windowLabel = useMemo(() => {
    if (rows.length === 0) return null;
    const times = rows.map((r) => r.meta.createdAt);
    const oldest = Math.min(...times);
    const newest = Math.max(...times);
    const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);
    if (fmt(oldest) === fmt(newest)) return `${fmt(oldest)} · ${rows.length} runs`;
    return `${fmt(oldest)} → ${fmt(newest)} · ${rows.length} runs`;
  }, [rows]);

  // For the avg-tokens column we render a faint background bar showing each
  // row's value as a fraction of the max, so the eye picks up "council uses
  // 3× as many tokens as blackboard" without doing mental math.
  const maxAvgTokens = useMemo(
    () => Math.max(0, ...stats.map((s) => s.avgTokens)),
    [stats],
  );
  const maxAvgCost = useMemo(
    () => Math.max(0, ...stats.map((s) => s.avgCost)),
    [stats],
  );

  return (
    <div className="min-h-screen bg-ink-950 text-fog-200 flex flex-col">
      <header className="h-10 hairline-b px-4 flex items-center gap-3 bg-ink-900/80 backdrop-blur sticky top-0 z-10 shrink-0">
        <Link
          href="/"
          className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600 hover:text-fog-200 transition"
        >
          ← run view
        </Link>
        <span className="w-px h-3 bg-ink-700" />
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-300">
          metrics · cross-preset
        </span>
        {windowLabel && (
          <span className="font-mono text-[10px] text-fog-600 tabular-nums">
            {windowLabel}
          </span>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="ml-auto h-6 px-2 rounded hairline bg-ink-800 hover:bg-ink-700 text-fog-400 hover:text-fog-200 disabled:opacity-50 disabled:cursor-not-allowed font-mono text-[10px] uppercase tracking-widest2 transition"
        >
          {refreshing ? 'refreshing…' : 'refresh'}
        </button>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 border border-molten/50 bg-molten/10 text-molten p-3 font-mono text-[11px]">
            error · {error}
          </div>
        )}

        {loading && !error && (
          <div className="font-mono text-[11px] text-fog-600">loading…</div>
        )}

        {!loading && !error && rows.length === 0 && (
          <div className="font-mono text-[11px] text-fog-600 max-w-md leading-snug">
            no runs yet. start one from the status rail — metrics appear here as
            soon as a run has any activity.
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <div className="max-w-5xl space-y-6">
            <section>
              <h2 className="font-mono text-micro uppercase tracking-widest2 text-fog-500 mb-2">
                per-preset aggregates
              </h2>
              <div className="hairline rounded">
                <table className="w-full font-mono text-[11px]">
                  <thead>
                    <tr className="text-fog-500 uppercase tracking-widest2 text-[9px] hairline-b">
                      <th className="text-left  py-2 px-3 font-normal">pattern</th>
                      <th className="text-right py-2 px-3 font-normal">runs</th>
                      <th className="text-right py-2 px-3 font-normal">avg dur</th>
                      <th className="text-right py-2 px-3 font-normal">med dur</th>
                      <th className="text-right py-2 px-3 font-normal">avg $</th>
                      <th className="text-right py-2 px-3 font-normal">avg tok</th>
                      <th className="text-right py-2 px-3 font-normal">live%</th>
                      <th className="text-right py-2 px-3 font-normal">stale%</th>
                      <th className="text-right py-2 px-3 font-normal">err%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.map((s) => (
                      <tr
                        key={s.pattern}
                        className="hairline-t hover:bg-ink-900/40 transition"
                      >
                        <td
                          className={clsx(
                            'py-2 px-3',
                            patternAccentText[patternMeta[s.pattern].accent],
                          )}
                        >
                          {s.pattern}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-fog-300">
                          {s.count}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-fog-300">
                          {formatDur(s.avgDurMs)}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-fog-500">
                          {formatDur(s.medDurMs)}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-fog-300 relative">
                          {maxAvgCost > 0 && (
                            <span
                              className="absolute inset-y-0 right-0 bg-amber/10"
                              style={{ width: `${(s.avgCost / maxAvgCost) * 100}%` }}
                            />
                          )}
                          <span className="relative">{formatUsd(s.avgCost)}</span>
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-fog-300 relative">
                          {maxAvgTokens > 0 && (
                            <span
                              className="absolute inset-y-0 right-0 bg-iris/10"
                              style={{ width: `${(s.avgTokens / maxAvgTokens) * 100}%` }}
                            />
                          )}
                          <span className="relative">{formatTokens(s.avgTokens)}</span>
                        </td>
                        <td
                          className={clsx(
                            'py-2 px-3 text-right tabular-nums',
                            s.livePct > 0 ? 'text-mint' : 'text-fog-700',
                          )}
                        >
                          {formatPct(s.livePct)}
                        </td>
                        <td
                          className={clsx(
                            'py-2 px-3 text-right tabular-nums',
                            s.stalePct > 0 ? 'text-amber' : 'text-fog-700',
                          )}
                        >
                          {formatPct(s.stalePct)}
                        </td>
                        <td
                          className={clsx(
                            'py-2 px-3 text-right tabular-nums',
                            s.errorPct > 0 ? 'text-molten' : 'text-fog-700',
                          )}
                        >
                          {formatPct(s.errorPct)}
                        </td>
                      </tr>
                    ))}
                    {totals && (
                      <tr className="hairline-t bg-ink-900/60">
                        <td className="py-2 px-3 text-fog-500 uppercase tracking-widest2 text-[9px]">
                          all
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-fog-400">
                          {totals.count}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-fog-400">
                          {formatDur(totals.avgDurMs)}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-fog-400">
                          {formatDur(totals.medDurMs)}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-fog-400">
                          {formatUsd(totals.avgCost)}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-fog-400">
                          {formatTokens(totals.avgTokens)}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-mint">
                          {formatPct(totals.livePct)}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-amber">
                          {formatPct(totals.stalePct)}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums text-rust">
                          {formatPct(totals.errorPct)}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 font-mono text-[9.5px] text-fog-600 leading-snug max-w-3xl">
                dur = lastActivityTs − createdAt (uses now() for in-flight runs).
                avg $ and avg tok columns include a faint bar showing each
                preset's value as a fraction of the column max — eye-friendly
                way to see "council costs 3× blackboard" without math.
              </div>
            </section>

            <section>
              <h2 className="font-mono text-micro uppercase tracking-widest2 text-fog-500 mb-2">
                totals
              </h2>
              <div className="hairline rounded p-3 grid grid-cols-2 md:grid-cols-4 gap-4 font-mono text-[11px]">
                {totals && (
                  <>
                    <Cell label="runs" value={totals.count.toString()} />
                    <Cell label="avg dur" value={formatDur(totals.avgDurMs)} />
                    <Cell label="total $" value={formatUsd(totals.totalCost)} />
                    <Cell label="total tok" value={formatTokens(totals.totalTokens)} />
                  </>
                )}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600">
        {label}
      </span>
      <span className="font-mono text-[16px] text-fog-100 tabular-nums">{value}</span>
    </div>
  );
}
