'use client';

// Browseable index of every persisted swarm run. The status rail "runs"
// button opens this — it's the discovery counterpart to "new run", which
// only creates. Without this list, a run is only findable by the URL
// returned from POST /api/swarm/run, which turns the ledger into write-
// only storage.
//
// Design choices:
//   - Read-only: no delete / archive affordances. Retention is a backend
//     concern (DESIGN.md §7.7) — compression runs as a server sweep, never
//     from a user click. The picker is pure discovery.
//   - Wide dense-row popover, one-eye-look density: the point is to spot
//     the run you want in one glance. Progressive disclosure for a list
//     view kills that.
//   - Current run highlighted via `currentSwarmRunID` prop rather than
//     reading the URL here. Keeps the component URL-agnostic — it can
//     also render inside the palette or a future dashboard.

import clsx from 'clsx';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Popover } from './ui/popover';
import { useSwarmRuns } from '@/lib/opencode/live';
import { patternMeta, patternAccentText } from '@/lib/swarm-patterns';
import type { SwarmRunMeta, SwarmRunStatus } from '@/lib/swarm-run-types';
import { IconSearch } from './icons';

// Color + dot styling per status bucket. Lives alongside the picker so the
// topbar status dot can import the same table — one source of truth for
// what "live" looks like visually.
export const STATUS_VISUAL: Record<
  SwarmRunStatus,
  { dot: string; label: string; rank: number; tone: string }
> = {
  live:    { dot: 'bg-mint animate-pulse', label: 'live',    rank: 0, tone: 'text-mint' },
  stale:   { dot: 'bg-amber',              label: 'stale',   rank: 1, tone: 'text-amber' },
  error:   { dot: 'bg-rust',               label: 'error',   rank: 2, tone: 'text-rust' },
  idle:    { dot: 'bg-fog-500',            label: 'idle',    rank: 3, tone: 'text-fog-400' },
  unknown: { dot: 'bg-fog-700',            label: '—',       rank: 4, tone: 'text-fog-700' },
};

// Date + time formatter for the runs-picker row. The previous relative-
// age ("3h", "9h") lost the specific moment once runs piled up — user
// wanted exact wall-clock down to seconds. Compact "M/D HH:MM:SS" fits
// in a 108px column at 10px mono without wrapping.
function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  const mon = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mon}/${day} ${hh}:${mm}:${ss}`;
}

// Strip the "run_" prefix so the id column shows the sortable payload
// without wasted columns on a fixed prefix shared by every row.
function idTail(id: string): string {
  return id.startsWith('run_') ? id.slice(4) : id;
}

function directiveTeaser(directive: string | undefined): string {
  if (!directive) return '(no directive)';
  const firstLine = directive.split('\n', 1)[0]?.trim() ?? '';
  return firstLine.length > 96 ? firstLine.slice(0, 96).replace(/\s+$/, '') + '…' : firstLine;
}

function formatBoundsShort(meta: SwarmRunMeta): string {
  const parts: string[] = [];
  if (meta.bounds?.costCap != null) {
    parts.push(`$${meta.bounds.costCap.toFixed(meta.bounds.costCap < 10 ? 2 : 0)}`);
  }
  if (meta.bounds?.minutesCap != null) parts.push(`${meta.bounds.minutesCap}m`);
  return parts.join(' · ');
}

// Outer shell — just wires the trigger <children> into the Popover. The
// picker's data-fetching (useSwarmRuns polling) lives in PickerPanel which
// is ONLY mounted when the popover actually opens. Before this split, the
// hook ran on every render of the outer component (which is always mounted
// in page.tsx), meaning /api/swarm/run polled every 4s forever even when
// the user hadn't touched the picker. Confirmed by perf:cold which caught
// 28+ polls to that endpoint during a 40s cold load.
export function SwarmRunsPicker({
  children,
  currentSwarmRunID,
}: {
  children: React.ReactElement;
  currentSwarmRunID?: string | null;
}) {
  return (
    <Popover
      side="top"
      align="start"
      width={1100}
      content={(close) => (
        <PickerPanel close={close} currentSwarmRunID={currentSwarmRunID ?? null} />
      )}
    >
      {children}
    </Popover>
  );
}

function PickerPanel({
  close,
  currentSwarmRunID,
}: {
  close: () => void;
  currentSwarmRunID: string | null;
}) {
  const { rows, error, loading, lastUpdated } = useSwarmRuns(4000);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? rows.filter((r) => {
          const m = r.meta;
          const haystack = [
            m.swarmRunID,
            m.pattern,
            m.directive ?? '',
            m.title ?? '',
            m.source ?? '',
            m.workspace,
            r.status,
          ]
            .join('|')
            .toLowerCase();
          return haystack.includes(q);
        })
      : rows;
    // Sort by status rank (live first, unknown last) with createdAt
    // descending as tiebreak. This pushes in-flight runs to the top where
    // users are most likely to want them — the "what's happening right
    // now" answer shouldn't require scrolling.
    return [...base].sort((a, b) => {
      const ra = STATUS_VISUAL[a.status].rank;
      const rb = STATUS_VISUAL[b.status].rank;
      if (ra !== rb) return ra - rb;
      return b.meta.createdAt - a.meta.createdAt;
    });
  }, [rows, query]);

  const liveCount = useMemo(
    () => rows.filter((r) => r.status === 'live').length,
    [rows]
  );

  const statusLabel = error
    ? 'offline'
    : loading && lastUpdated === null
      ? 'scanning…'
      : query
        ? `${filtered.length} of ${rows.length}`
        : liveCount > 0
          ? `${liveCount} live · ${rows.length} total`
          : `${rows.length} ${rows.length === 1 ? 'run' : 'runs'}`;

  return (
    <div className="flex flex-col min-h-0">
      <div className="px-3 h-7 hairline-b flex items-center gap-3">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600 shrink-0">
          swarm runs
        </span>
        <span className="font-mono text-[10px] text-fog-700 tabular-nums ml-auto shrink-0">
          {statusLabel}
        </span>
      </div>
          <div className="px-3 py-1.5 hairline-b flex items-center gap-2 bg-ink-900/30">
            <IconSearch size={12} className="text-fog-600 shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter by directive, id, pattern, source…"
              aria-label="filter by directive, id, pattern, source"
              className="flex-1 bg-transparent border-0 outline-none font-mono text-[11px] text-fog-100 placeholder:text-fog-700"
              autoFocus
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600 hover:text-fog-300 transition shrink-0"
              >
                clear
              </button>
            )}
          </div>
          {/* Mirror the LI body structure exactly: inner flex row with the
              same px-3 + gap-3 as the Link, plus a sibling retro spacer
              matching the 56 px retro-div and LI's pr-1. Earlier the
              header flex had two extra children (retro + w-1) inside the
              gap sequence, adding 24 px of gaps not present in the body
              row — SESS / CAPS / WHEN drifted right of their value cells.
              Keeping the two shells isomorphic is the only reliable fix. */}
          <div className="flex items-center h-5 hairline-b bg-ink-900/40 pr-1">
            <div className="flex-1 min-w-0 px-3 h-full flex items-center gap-3">
              <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-[52px] shrink-0">
                status
              </span>
              <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-[140px] shrink-0">
                pat
              </span>
              <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-[124px] shrink-0">
                id
              </span>
              <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 flex-1 min-w-0">
                directive
              </span>
              <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-[28px] text-right shrink-0">
                sess
              </span>
              <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-[64px] shrink-0">
                caps
              </span>
              <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-[108px] text-right shrink-0">
                when
              </span>
            </div>
            {/* Retro column header intentionally blank — the chip only
                appears on row hover. Empty spacer preserves alignment with
                the body's retro-div which has matching w-[56px]. */}
            <div className="w-[56px] shrink-0" aria-hidden />
          </div>
          <ul className="max-h-[360px] overflow-y-auto divide-y divide-ink-800">
            {error && !loading && (
              <li className="px-3 py-2 text-[11px] text-rust break-all">{error}</li>
            )}
            {filtered.map((row) => {
              const meta = row.meta;
              const isCurrent = meta.swarmRunID === currentSwarmRunID;
              const bounds = formatBoundsShort(meta);
              const visual = STATUS_VISUAL[row.status];
              // Retro link only offered for runs that have likely produced
              // rollups — live/unknown runs haven't been reduced yet. idle
              // / error / stale runs are eligible. The page itself handles
              // the "no rollup yet" case, so a false positive here just
              // shows the empty-state with the generate-curl recipe.
              const retroEligible = row.status !== 'live' && row.status !== 'unknown';
              return (
                <li
                  key={meta.swarmRunID}
                  className={clsx(
                    'group flex items-center h-7 pr-1 hover:bg-ink-800/60 transition',
                    isCurrent && 'bg-iris/10 hover:bg-iris/15',
                  )}
                >
                  <Link
                    href={`/?swarmRun=${meta.swarmRunID}`}
                    onClick={() => close()}
                    className="flex-1 min-w-0 px-3 h-full flex items-center gap-3"
                    title={[
                      `status: ${row.status}`,
                      meta.swarmRunID,
                      meta.workspace,
                      meta.directive ? `\n${meta.directive}` : '',
                    ].filter(Boolean).join('\n')}
                  >
                    {/* Status column 2026-04-24: dropped the status
                        dot per user request — the colored label alone
                        carries the same severity signal in less
                        visual real estate. Width unchanged so the
                        rest of the row keeps its grid alignment. */}
                    <span className="flex items-center w-[52px] shrink-0">
                      <span
                        className={clsx(
                          'font-mono text-[9.5px] uppercase tracking-widest2',
                          visual.tone
                        )}
                      >
                        {visual.label}
                      </span>
                      {row.stuck && (
                        <span
                          className="ml-1 font-mono text-[9.5px] uppercase tracking-widest2 text-rust"
                          title={`stuck: ${row.stuck.reason}`}
                        >
                          ⚠
                        </span>
                      )}
                    </span>
                    <span
                      className={clsx(
                        'font-mono text-[10px] uppercase tracking-widest2 w-[140px] shrink-0 truncate',
                        patternAccentText[patternMeta[meta.pattern].accent],
                      )}
                    >
                      {meta.pattern}
                    </span>
                    <span
                      className={clsx(
                        'font-mono text-[10px] tabular-nums shrink-0 w-[124px] whitespace-nowrap truncate',
                        isCurrent ? 'text-iris' : 'text-fog-500'
                      )}
                    >
                      {idTail(meta.swarmRunID)}
                    </span>
                    <span className="text-[11.5px] text-fog-200 flex-1 min-w-0 whitespace-nowrap truncate">
                      {directiveTeaser(meta.directive)}
                    </span>
                    <span
                      className={clsx(
                        'font-mono text-[10px] tabular-nums shrink-0 w-[28px] text-right',
                        meta.sessionIDs.length > 1 ? 'text-iris' : 'text-fog-400',
                      )}
                      title={
                        meta.sessionIDs.length > 1
                          ? `${meta.sessionIDs.length} parallel sessions`
                          : undefined
                      }
                    >
                      {meta.sessionIDs.length}
                    </span>
                    <span className="font-mono text-[10px] text-fog-600 tabular-nums shrink-0 w-[64px] truncate">
                      {bounds || '—'}
                    </span>
                    <span
                      className="font-mono text-[10px] text-fog-600 tabular-nums shrink-0 w-[108px] text-right whitespace-nowrap"
                      title={new Date(row.lastActivityTs ?? meta.createdAt).toLocaleString()}
                    >
                      {fmtDateTime(row.lastActivityTs ?? meta.createdAt)}
                    </span>
                  </Link>
                  {/* Retro column — dedicated 56px slot, right of the
                      row-level Link so clicking it navigates to the
                      retro page instead of the run view. Reveal on
                      group-hover (non-hovered rows keep the slot
                      reserved but empty). */}
                  <div className="w-[56px] shrink-0 flex items-center justify-end pr-1">
                    {retroEligible && (
                      <Link
                        href={`/retro/${meta.swarmRunID}`}
                        onClick={() => close()}
                        title="open retro for this run"
                        className="h-5 px-2 rounded font-mono text-[9px] uppercase tracking-widest2 text-fog-400 bg-ink-800 border border-fog-700 hover:text-molten hover:bg-molten/10 hover:border-molten/30 transition-opacity opacity-0 group-hover:opacity-100 flex items-center"
                      >
                        retro
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
            {!loading && !error && rows.length === 0 && (
              <li className="px-3 py-3 text-[11px] text-fog-600 flex items-center gap-2">
                <span className="w-1 h-1 rounded-full bg-fog-700" />
                no runs yet — start one from the new run button
              </li>
            )}
            {!loading && !error && rows.length > 0 && filtered.length === 0 && (
              <li className="px-3 py-3 text-[11px] text-fog-600">
                no runs match "{query}"
              </li>
            )}
          </ul>
    </div>
  );
}
