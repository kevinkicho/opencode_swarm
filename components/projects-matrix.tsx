'use client';

// Project-time matrix: rows = repos (one per workspace seen in the swarm
// registry), columns = days, cells = per-day run markers. The answer to
// "where and when has my agent work been happening?" without opening
// every run individually. Uses the existing GET /api/swarm/run feed —
// same rows the run picker and /metrics consume — so no new backend.
//
// Layout aesthetic: contribution-graph-style dense grid, but with the
// project stance (hairline borders, monospace, dense factory tokens).
// GitHub's calendar is the reference, not the model — we keep rows
// per-repo instead of collapsing to a single stream.
//
// 2026-04-28 decomposition: helpers + constants + types →
// projects-matrix/helpers.ts; MatrixHeader/MatrixRow/DayCell/popovers →
// projects-matrix/cells.tsx. This file is the page composition only.

import clsx from 'clsx';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { SwarmRunListRow, SwarmRunStatus } from '@/lib/swarm-run-types';
import {
  DAY_MS,
  DAY_WIDTH,
  DEFAULT_WINDOW_DAYS,
  REPO_COL_WIDTH,
  STATUS_TONE,
  dayKeyOf,
  dayStartMs,
  groupByWorkspace,
} from './projects-matrix/helpers';
import { MatrixHeader, MatrixRow } from './projects-matrix/cells';

export function ProjectsMatrix({
  rows,
  loading,
  error,
  onRefresh,
  refreshing,
  embedded = false,
}: {
  rows: SwarmRunListRow[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  refreshing: boolean;
  // When true, drop the page-level chrome (back-link, big title)
  // and constrain to a modal-friendly height. Modal supplies its
  // own title + close.
  embedded?: boolean;
}) {
  const [windowDays, setWindowDays] = useState<number>(DEFAULT_WINDOW_DAYS);

  const { projects, dayKeys, days } = useMemo(() => {
    const projects = groupByWorkspace(rows);
    // Window endpoints. Today's end-of-day included so runs that fire now
    // land in the rightmost column, not a phantom tomorrow cell.
    const todayStart = dayStartMs(Date.now());
    const oldestStart = todayStart - (windowDays - 1) * DAY_MS;
    const days: number[] = [];
    for (let t = oldestStart; t <= todayStart; t += DAY_MS) days.push(t);
    const dayKeys = new Set(days.map(dayKeyOf));
    return { projects, dayKeys, days };
  }, [rows, windowDays]);

  const totalRuns = rows.length;
  const visibleProjects = projects.filter((p) =>
    p.runs.some((r) => {
      const k = dayKeyOf(r.meta.createdAt);
      return dayKeys.has(k);
    }),
  );

  const matrixWidth = REPO_COL_WIDTH + days.length * DAY_WIDTH;

  // Window picker + refresh — small enough to render in both modes;
  // the back-link / page title fall away when embedded.
  const controls = (
    <>
      <div className="flex items-center gap-0.5 font-mono text-micro uppercase tracking-widest2">
        <span className="text-fog-600 mr-1">window</span>
        {[7, 30, 90].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setWindowDays(d)}
            className={clsx(
              'h-5 px-1.5 rounded-sm transition-colors cursor-pointer tabular-nums',
              windowDays === d
                ? 'bg-molten/15 text-molten'
                : 'text-fog-500 hover:text-fog-300 hover:bg-ink-800/60',
            )}
          >
            {d}d
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="h-5 px-2 rounded-sm font-mono text-micro uppercase tracking-widest2 text-fog-500 hover:text-fog-200 hover:bg-ink-800/60 disabled:opacity-50 cursor-pointer"
      >
        {refreshing ? 'refreshing…' : 'refresh'}
      </button>
    </>
  );

  return (
    <div className={clsx(
      'flex flex-col text-fog-200',
      embedded ? 'min-h-0 max-h-[80vh] bg-transparent' : 'min-h-screen bg-ink-900',
    )}>
      {!embedded && (
        <header className="h-10 hairline-b px-4 flex items-center gap-3 bg-ink-850/80 backdrop-blur sticky top-0 z-10">
          <Link
            href="/"
            className="font-mono text-micro uppercase tracking-widest2 text-fog-600 hover:text-fog-200 transition"
          >
            ← opencode
          </Link>
          <span className="font-mono text-micro uppercase tracking-widest2 text-fog-700">/</span>
          <span className="font-mono text-[12px] text-fog-200">projects</span>
          <span className="font-mono text-micro text-fog-700 tabular-nums">
            {visibleProjects.length} repos · {totalRuns} runs · last {windowDays}d
          </span>
          <div className="flex-1" />
          {controls}
        </header>
      )}
      {embedded && (
        <div className="hairline-b px-4 h-7 flex items-center gap-3 bg-ink-900/40 shrink-0">
          <span className="font-mono text-micro text-fog-700 tabular-nums">
            {visibleProjects.length} repos · {totalRuns} runs · last {windowDays}d
          </span>
          <div className="flex-1" />
          {controls}
        </div>
      )}

      {error && (
        <div className="px-4 py-2 font-mono text-[11px] text-rust hairline-b bg-rust/5">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex-1 grid place-items-center">
          <span className="font-mono text-micro uppercase tracking-widest2 text-fog-700">
            loading…
          </span>
        </div>
      ) : visibleProjects.length === 0 ? (
        <div className="flex-1 grid place-items-center">
          <div className="font-mono text-[11px] text-fog-600 space-y-1 text-center">
            <div>no runs in the last {windowDays} days.</div>
            <div className="text-fog-700">try widening the window or launch a new run.</div>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <div style={{ width: matrixWidth }} className="min-w-full">
            <MatrixHeader days={days} />
            <ul className="flex flex-col">
              {visibleProjects.map((p) => (
                <MatrixRow key={p.workspace} project={p} days={days} dayKeys={dayKeys} />
              ))}
            </ul>
          </div>

          {/* Legend — status color key */}
          <div className="px-4 py-2 hairline-t bg-ink-850/40">
            <div className="flex items-center gap-3 font-mono text-micro uppercase tracking-widest2 text-fog-600">
              <span>status:</span>
              {(['live', 'idle', 'error', 'stale', 'unknown'] as SwarmRunStatus[]).map((s) => (
                <span key={s} className="flex items-center gap-1">
                  <span className={clsx('inline-block w-2.5 h-2.5', STATUS_TONE[s])} />
                  <span className="text-fog-500 normal-case">{s}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
