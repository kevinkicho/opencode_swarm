'use client';

// Browseable index of every persisted swarm run. The status rail "runs"
// button opens this — it's the discovery counterpart to "new run", which
// only creates. Without this list, a run is only findable by the URL
// returned from POST /api/swarm/run, which turns the ledger into write-
// only storage.
//
// Design choices:
//   - Read-only: no delete / archive affordances yet. Prototype stage; we
//     haven't decided on retention semantics (see Tier 4 todo in
//     DESIGN.md §7 — rotation). Adding action buttons now would tell the
//     user something works that doesn't.
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
import type { SwarmRunMeta } from '@/lib/swarm-run-types';
import { IconSearch } from './icons';

function fmtAge(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
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

export function SwarmRunsPicker({
  children,
  currentSwarmRunID,
}: {
  children: React.ReactElement;
  currentSwarmRunID?: string | null;
}) {
  const { runs, error, loading, lastUpdated } = useSwarmRuns(4000);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return runs;
    return runs.filter((r) => {
      const haystack = [
        r.swarmRunID,
        r.pattern,
        r.directive ?? '',
        r.title ?? '',
        r.source ?? '',
        r.workspace,
      ]
        .join('|')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [runs, query]);

  const statusLabel = error
    ? 'offline'
    : loading && lastUpdated === null
      ? 'scanning…'
      : query
        ? `${filtered.length} of ${runs.length}`
        : `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`;

  return (
    <Popover
      side="top"
      align="start"
      width={760}
      content={(close) => (
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
          <div className="px-3 h-5 hairline-b flex items-center gap-3 bg-ink-900/40">
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-[52px] shrink-0">
              pat
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-[132px] shrink-0">
              id
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 flex-1 min-w-0">
              directive
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-[44px] text-right shrink-0">
              sess
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-[68px] shrink-0">
              caps
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-[32px] text-right shrink-0">
              age
            </span>
          </div>
          <ul className="max-h-[360px] overflow-y-auto divide-y divide-ink-800">
            {error && !loading && (
              <li className="px-3 py-2 text-[11px] text-rust break-all">{error}</li>
            )}
            {filtered.map((r) => {
              const isCurrent = r.swarmRunID === currentSwarmRunID;
              const bounds = formatBoundsShort(r);
              return (
                <li key={r.swarmRunID}>
                  <Link
                    href={`/?swarmRun=${r.swarmRunID}`}
                    onClick={() => close()}
                    className={clsx(
                      'px-3 h-7 flex items-center gap-3 hover:bg-ink-800/60 transition',
                      isCurrent && 'bg-iris/10 hover:bg-iris/15'
                    )}
                    title={[
                      r.swarmRunID,
                      r.workspace,
                      r.directive ? `\n${r.directive}` : '',
                    ].filter(Boolean).join('\n')}
                  >
                    <span
                      className={clsx(
                        'font-mono text-[10px] uppercase tracking-widest2 w-[52px] shrink-0 whitespace-nowrap',
                        r.pattern === 'none' ? 'text-fog-600' : 'text-iris'
                      )}
                    >
                      {r.pattern}
                    </span>
                    <span
                      className={clsx(
                        'font-mono text-[10px] tabular-nums shrink-0 w-[132px] whitespace-nowrap truncate',
                        isCurrent ? 'text-iris' : 'text-fog-500'
                      )}
                    >
                      {idTail(r.swarmRunID)}
                    </span>
                    <span className="text-[11.5px] text-fog-200 flex-1 min-w-0 whitespace-nowrap truncate">
                      {directiveTeaser(r.directive)}
                    </span>
                    <span className="font-mono text-[10px] text-fog-400 tabular-nums shrink-0 w-[44px] text-right">
                      {r.sessionIDs.length}
                    </span>
                    <span className="font-mono text-[10px] text-fog-600 tabular-nums shrink-0 w-[68px] truncate">
                      {bounds || '—'}
                    </span>
                    <span className="font-mono text-[10px] text-fog-600 tabular-nums shrink-0 w-[32px] text-right">
                      {fmtAge(r.createdAt)}
                    </span>
                  </Link>
                </li>
              );
            })}
            {!loading && !error && runs.length === 0 && (
              <li className="px-3 py-3 text-[11px] text-fog-600 flex items-center gap-2">
                <span className="w-1 h-1 rounded-full bg-fog-700" />
                no runs yet — start one from the new run button
              </li>
            )}
            {!loading && !error && runs.length > 0 && filtered.length === 0 && (
              <li className="px-3 py-3 text-[11px] text-fog-600">
                no runs match "{query}"
              </li>
            )}
          </ul>
        </div>
      )}
    >
      {children}
    </Popover>
  );
}
