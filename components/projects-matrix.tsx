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

import clsx from 'clsx';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { SwarmRunListRow, SwarmRunStatus } from '@/lib/swarm-run-types';
import type { SwarmPattern } from '@/lib/swarm-types';
import { patternMeta, patternAccentText } from '@/lib/swarm-patterns';
import { Popover } from './ui/popover';
import { Tooltip } from './ui/tooltip';
import { STATUS_BURN_VISUAL, STATUS_PRIORITY } from './swarm-run-visual';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;

// Fixed cell geometry. Day column narrows on smaller windows; we don't
// scale — readers learn the pitch once and scanning is spatial.
const DAY_WIDTH = 16;
const ROW_HEIGHT = 20;
const REPO_COL_WIDTH = 200;

// Day cells use the burn-rate palette (live=amber, idle=mint, stale=fog)
// because this view's mental model is "who burned compute today."
const STATUS_TONE = Object.fromEntries(
  Object.entries(STATUS_BURN_VISUAL).map(([k, v]) => [k, v.bg]),
) as Record<SwarmRunStatus, string>;
const STATUS_DOT_TONE = Object.fromEntries(
  Object.entries(STATUS_BURN_VISUAL).map(([k, v]) => [k, v.tone]),
) as Record<SwarmRunStatus, string>;

function repoNameOf(workspace: string): string {
  // Workspace is always an absolute path; the repo is the leaf dir. Both
  // forward and back slashes may appear (opencode records Windows paths
  // with forward slashes per /api/swarm/run POST normalizer, but cross-
  // platform defensive).
  const normalized = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
  const leaf = normalized.split('/').pop() ?? '';
  return leaf || workspace;
}

function dayKeyOf(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayStartMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function fmtDayShort(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtDayLong(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

interface Project {
  workspace: string;
  repoName: string;
  source?: string;
  runs: SwarmRunListRow[];
  firstRunAt: number;
  lastRunAt: number;
}

// Group rows by workspace, sort runs desc within each, sort projects by
// most-recent activity. O(N log N) in the number of runs — fine at
// prototype scale (hundreds).
function groupByWorkspace(rows: SwarmRunListRow[]): Project[] {
  const byWs = new Map<string, Project>();
  for (const row of rows) {
    const ws = row.meta.workspace;
    let proj = byWs.get(ws);
    if (!proj) {
      proj = {
        workspace: ws,
        repoName: repoNameOf(ws),
        source: row.meta.source,
        runs: [],
        firstRunAt: row.meta.createdAt,
        lastRunAt: row.meta.createdAt,
      };
      byWs.set(ws, proj);
    }
    proj.runs.push(row);
    proj.firstRunAt = Math.min(proj.firstRunAt, row.meta.createdAt);
    proj.lastRunAt = Math.max(proj.lastRunAt, row.meta.createdAt);
    if (!proj.source && row.meta.source) proj.source = row.meta.source;
  }
  for (const p of byWs.values()) {
    p.runs.sort((a, b) => b.meta.createdAt - a.meta.createdAt);
  }
  return Array.from(byWs.values()).sort((a, b) => b.lastRunAt - a.lastRunAt);
}

// Collapse runs for one project into per-day buckets keyed by local date.
// `dayKeys` is the window — days outside that window are ignored (those
// runs still count toward the project's activity window but don't
// render as cells).
function bucketByDay(
  runs: SwarmRunListRow[],
  dayKeys: Set<string>,
): Map<string, SwarmRunListRow[]> {
  const out = new Map<string, SwarmRunListRow[]>();
  for (const r of runs) {
    const k = dayKeyOf(r.meta.createdAt);
    if (!dayKeys.has(k)) continue;
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function dominantStatus(rows: SwarmRunListRow[]): SwarmRunStatus {
  const set = new Set(rows.map((r) => r.status));
  for (const s of STATUS_PRIORITY) {
    if (set.has(s)) return s;
  }
  return 'unknown';
}

export function ProjectsMatrix({
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

  return (
    <div className="flex flex-col min-h-screen bg-ink-900 text-fog-200">
      {/* Chrome — mirrors the /metrics page header pattern */}
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
      </header>

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

function MatrixHeader({ days }: { days: number[] }) {
  // Week markers: show the day-of-month only on Mondays or on the first
  // visible day; every other day renders a blank column so the grid
  // rhythm survives. Today's column is subtly highlighted.
  const todayStart = dayStartMs(Date.now());
  return (
    <div
      className="sticky top-0 z-10 flex items-end h-6 hairline-b bg-ink-850/90 backdrop-blur"
      style={{ paddingLeft: REPO_COL_WIDTH }}
    >
      {days.map((t) => {
        const d = new Date(t);
        const dow = d.getDay();
        const isToday = t === todayStart;
        const showLabel = dow === 1 || t === days[0];
        return (
          <Tooltip key={t} content={fmtDayLong(t)} side="top">
            <div
              className={clsx(
                'shrink-0 flex items-end justify-center font-mono text-micro text-fog-600 tabular-nums cursor-default',
                isToday && 'text-molten',
              )}
              style={{ width: DAY_WIDTH, height: 24 }}
            >
              {showLabel ? fmtDayShort(t) : ''}
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}

function MatrixRow({
  project,
  days,
  dayKeys,
}: {
  project: Project;
  days: number[];
  dayKeys: Set<string>;
}) {
  const byDay = useMemo(() => bucketByDay(project.runs, dayKeys), [project.runs, dayKeys]);
  const totalInWindow = Array.from(byDay.values()).reduce((a, xs) => a + xs.length, 0);

  return (
    <li
      className="flex items-stretch hairline-b hover:bg-ink-800/40 transition-colors"
      style={{ height: ROW_HEIGHT }}
    >
      <div
        className="shrink-0 flex items-center gap-2 pl-3 pr-2 hairline-r"
        style={{ width: REPO_COL_WIDTH }}
      >
        <Tooltip
          content={
            <div className="space-y-0.5 max-w-[340px]">
              <div className="font-mono text-[11px] text-fog-200 break-all">
                {project.workspace}
              </div>
              {project.source && (
                <div className="font-mono text-[10.5px] text-fog-500 break-all">
                  {project.source}
                </div>
              )}
              <div className="font-mono text-micro uppercase tracking-widest2 text-fog-700 tabular-nums">
                {project.runs.length} total · {totalInWindow} in window · click to compare runs
              </div>
            </div>
          }
          side="right"
        >
          <Link
            href={`/projects/${encodeURIComponent(project.repoName)}`}
            className="font-mono text-[11px] text-fog-300 truncate hover:text-fog-100 transition-colors"
          >
            {project.repoName}
          </Link>
        </Tooltip>
      </div>

      <div className="flex items-center">
        {days.map((t) => {
          const key = dayKeyOf(t);
          const runs = byDay.get(key);
          return <DayCell key={t} dayMs={t} runs={runs} />;
        })}
      </div>
    </li>
  );
}

function DayCell({ dayMs, runs }: { dayMs: number; runs?: SwarmRunListRow[] }) {
  const isToday = dayMs === dayStartMs(Date.now());

  if (!runs || runs.length === 0) {
    return (
      <div
        className={clsx(
          'shrink-0 flex items-center justify-center',
          isToday && 'bg-molten/[0.04]',
        )}
        style={{ width: DAY_WIDTH, height: ROW_HEIGHT }}
      >
        <span className="w-0.5 h-0.5 rounded-full bg-fog-800" />
      </div>
    );
  }

  const status = dominantStatus(runs);
  const cell = (
    <button
      type="button"
      // Day cells render as small colored squares — visually clear but
      // opaque to screen readers without an explicit label. axe flags
      // this as `button-name` (critical). Pull the day, run count, and
      // dominant status into the aria-label so the popover content is
      // discoverable without sighted UI.
      aria-label={`${fmtDayLong(dayMs)} · ${runs.length} run${runs.length === 1 ? '' : 's'} · ${status}`}
      className={clsx(
        'shrink-0 grid place-items-center relative cursor-pointer hover:ring-1 hover:ring-fog-500 transition',
        isToday && 'bg-molten/[0.04]',
      )}
      style={{ width: DAY_WIDTH, height: ROW_HEIGHT }}
    >
      <span
        className={clsx('block rounded-[1px]', STATUS_TONE[status])}
        style={{ width: 10, height: 10 }}
      />
      {runs.length > 1 && (
        <span className="absolute -top-0.5 -right-0.5 font-mono text-[8px] leading-none text-ink-900 bg-fog-400 rounded-full px-[2px] tabular-nums">
          {runs.length > 9 ? '9+' : runs.length}
        </span>
      )}
    </button>
  );

  return (
    <Popover content={() => <DayCellPopover runs={runs} dayMs={dayMs} />} side="bottom">
      {cell}
    </Popover>
  );
}

function DayCellPopover({ runs, dayMs }: { runs: SwarmRunListRow[]; dayMs: number }) {
  return (
    <div className="min-w-[320px] max-w-[420px] space-y-1.5">
      <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 flex items-center gap-2">
        <span>{fmtDayLong(dayMs)}</span>
        <span className="text-fog-700">·</span>
        <span className="tabular-nums">{runs.length} run{runs.length === 1 ? '' : 's'}</span>
      </div>
      <ul className="flex flex-col gap-1">
        {runs.map((r) => (
          <DayCellRun key={r.meta.swarmRunID} row={r} />
        ))}
      </ul>
    </div>
  );
}

function DayCellRun({ row }: { row: SwarmRunListRow }) {
  const pattern: SwarmPattern = row.meta.pattern;
  return (
    <li>
      <Link
        href={`/?swarmRun=${encodeURIComponent(row.meta.swarmRunID)}`}
        className="block rounded-sm hover:bg-ink-700/60 transition px-2 py-1"
      >
        <div className="flex items-center gap-2 font-mono text-[11px]">
          <span className={clsx('text-[10px] leading-none', STATUS_DOT_TONE[row.status])}>●</span>
          <span className="text-fog-500 tabular-nums">{fmtTime(row.meta.createdAt)}</span>
          <span className="text-fog-700">·</span>
          <span
            className={clsx(
              'uppercase tracking-widest2 text-micro',
              patternAccentText[patternMeta[pattern].accent],
            )}
          >
            {pattern}
          </span>
          <span className="text-fog-700">·</span>
          <span className="text-fog-300 truncate flex-1">
            {row.meta.title ?? row.meta.swarmRunID.slice(-8)}
          </span>
        </div>
        <div className="flex items-center gap-2 font-mono text-micro text-fog-600 tabular-nums pl-6 pt-0.5">
          <span className="uppercase tracking-widest2">{row.status}</span>
          {row.costTotal > 0 && <span>${row.costTotal.toFixed(3)}</span>}
          {row.tokensTotal > 0 && <span>{row.tokensTotal.toLocaleString()} tok</span>}
          <span className="text-fog-700 truncate">{row.meta.swarmRunID}</span>
        </div>
      </Link>
    </li>
  );
}
