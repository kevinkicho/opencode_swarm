'use client';

// Sub-views for ProjectsMatrix: the day-axis header, per-repo rows,
// the per-day cells, and the per-day Popover (with run-list).
//
// Lifted from projects-matrix.tsx 2026-04-28 — pure renders driven
// by the Project / SwarmRunListRow primitives. Cells own a Tooltip
// + Popover hover/click interaction; everything else is read-only
// composition.

import clsx from 'clsx';
import Link from 'next/link';
import { useMemo } from 'react';
import type { SwarmRunListRow } from '@/lib/swarm-run-types';
import type { SwarmPattern } from '@/lib/swarm-types';
import { patternMeta, patternAccentText } from '@/lib/swarm-patterns';
import { Popover } from '../ui/popover';
import { Tooltip } from '../ui/tooltip';
import {
  DAY_WIDTH,
  REPO_COL_WIDTH,
  ROW_HEIGHT,
  STATUS_DOT_TONE,
  STATUS_TONE,
  activityIntensity,
  bucketByDay,
  dayKeyOf,
  dayStartMs,
  dominantStatus,
  fmtDayLong,
  fmtDayShort,
  fmtTime,
  type Project,
} from './helpers';

// Inner colored block size — leaves 1.5px gutter on each side for that
// GitHub contribution-graph rhythm.
const INNER_BLOCK = 11;

export function MatrixHeader({ days }: { days: number[] }) {
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

export function MatrixRow({
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

      {/* gap-[2px] gives the GitHub contribution-graph rhythm — cells
          read as a grid rather than a striped row of touching tiles. */}
      <div className="flex items-center gap-[2px]">
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

  // Empty day — render a dim base block (not just a dot). GitHub's
  // contribution graph keeps every cell a uniform square so the eye
  // tracks the grid; a single tiny dot for empties broke that rhythm
  // and made the matrix read striped rather than gridded.
  if (!runs || runs.length === 0) {
    return (
      <div
        className="shrink-0 grid place-items-center"
        style={{ width: DAY_WIDTH, height: ROW_HEIGHT }}
      >
        <span
          className={clsx(
            'block rounded-sm bg-ink-800',
            isToday && 'ring-1 ring-molten/40',
          )}
          style={{ width: INNER_BLOCK, height: INNER_BLOCK }}
        />
      </div>
    );
  }

  const status = dominantStatus(runs);
  // Opacity ladder by run count (1 → faint, 4+ → fully saturated) —
  // same GitHub-style intensity scaling, just expressed via opacity
  // since our hues encode status (live/idle/error/stale/unknown)
  // rather than a single contribution color.
  const intensity = activityIntensity(runs.length);

  const cell = (
    <button
      type="button"
      // Day cells render as colored squares — visually clear but
      // opaque to screen readers without an explicit label. axe flags
      // this as `button-name` (critical). Pull the day, run count, and
      // dominant status into the aria-label so the popover content is
      // discoverable without sighted UI.
      aria-label={`${fmtDayLong(dayMs)} · ${runs.length} run${runs.length === 1 ? '' : 's'} · ${status}`}
      className="shrink-0 grid place-items-center cursor-pointer transition hover:scale-110"
      style={{ width: DAY_WIDTH, height: ROW_HEIGHT }}
    >
      <span
        className={clsx(
          'block rounded-sm transition',
          STATUS_TONE[status],
          isToday && 'ring-1 ring-molten/60',
        )}
        style={{
          width: INNER_BLOCK,
          height: INNER_BLOCK,
          opacity: intensity,
        }}
      />
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
        // New tab — peer of the runs-picker pattern (2026-04-28).
        // Project matrix is a browse-multiple-runs surface, opening
        // in-place would force re-navigation back per click.
        href={`/?swarmRun=${encodeURIComponent(row.meta.swarmRunID)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="block rounded-sm hover:bg-ink-700/60 transition px-2 py-1"
        title={`open in new tab — ${row.meta.swarmRunID}`}
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
