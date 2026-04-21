'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Popover } from './ui/popover';
import { useLiveSessions } from '@/lib/opencode/live';
import type { OpencodeProject, OpencodeSession } from '@/lib/opencode/types';
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

// Compact local timestamp, e.g. "04-21 08:08".
function fmtTs(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

// Pull the last path segment from a worktree string (handles both '\' and '/').
// Used to show a readable label for projectID instead of its opaque hash.
function worktreeBasename(worktree: string): string {
  const norm = worktree.replace(/[\\/]+$/, '');
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  return i >= 0 ? norm.slice(i + 1) : norm;
}

type SortKey = 'none' | 'name' | 'created' | 'activity';

const sortOptions: { key: SortKey; label: string; hint: string }[] = [
  {
    key: 'none',
    label: 'none',
    hint: "stable — sorted by session id (immutable), so new messages never reshuffle the list. Probed 2026-04-21: opencode's own /session order drifts between polls, so we always apply this tiebreak.",
  },
  { key: 'name', label: 'name', hint: 'slug A→Z' },
  { key: 'created', label: 'created', hint: 'newest session first' },
  { key: 'activity', label: 'activity', hint: 'most recent message first (will reshuffle as messages arrive)' },
];

function applySort(sessions: OpencodeSession[], key: SortKey): OpencodeSession[] {
  const arr = [...sessions];
  switch (key) {
    case 'none':
      // Sort by immutable id so the list is fully stable across polls —
      // opencode's native /session ordering drifts, which would visually
      // reshuffle the picker even with zero client-side sort applied.
      arr.sort((a, b) => a.id.localeCompare(b.id));
      break;
    case 'name':
      arr.sort((a, b) => a.slug.localeCompare(b.slug));
      break;
    case 'created':
      arr.sort((a, b) => b.time.created - a.time.created);
      break;
    case 'activity':
      arr.sort((a, b) => b.time.updated - a.time.updated);
      break;
  }
  return arr;
}

export function LiveSessionPicker({ title }: { title: string }) {
  const { data, error, loading } = useLiveSessions(3000);
  const sessions = data?.sessions ?? [];
  const projects = data?.projects ?? [];
  const [sortKey, setSortKey] = useState<SortKey>('none');
  const [query, setQuery] = useState('');

  // Map projectID -> worktree so we can show a readable label in the proj column.
  const projectMap = useMemo(() => {
    const m = new Map<string, OpencodeProject>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  // Substring match against slug, id (with and without ses_ prefix), title,
  // projectID, and worktree (both full path and basename). Case-insensitive.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      const project = projectMap.get(s.projectID);
      const worktree = project?.worktree ?? '';
      const haystack = [
        s.slug,
        s.id,
        s.id.replace(/^ses_/, ''),
        s.title,
        s.projectID,
        worktree,
      ]
        .join('|')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [sessions, query, projectMap]);

  const sorted = useMemo(() => applySort(filtered, sortKey), [filtered, sortKey]);

  const statusLabel = error
    ? 'offline'
    : loading && !data
      ? 'scanning…'
      : query
        ? `${filtered.length} of ${sessions.length}`
        : `${sessions.length} live`;

  return (
    <Popover
      side="bottom"
      align="start"
      width={880}
      content={(close) => (
        <div className="flex flex-col min-h-0">
          <div className="px-3 py-2 hairline-b flex items-center gap-3">
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600 shrink-0">
              recent opencode sessions
            </span>
            <div className="flex items-center gap-0.5 ml-auto">
              <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 mr-1">
                sort
              </span>
              {sortOptions.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setSortKey(opt.key)}
                  title={opt.hint}
                  className={clsx(
                    'px-1.5 h-5 rounded font-mono text-[9px] uppercase tracking-widest2 transition',
                    sortKey === opt.key
                      ? 'bg-ink-700 text-fog-100'
                      : 'text-fog-600 hover:text-fog-300 hover:bg-ink-800/60'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <span className="font-mono text-[10px] text-fog-700 tabular-nums shrink-0 ml-1">
              {statusLabel}
            </span>
          </div>
          <div className="px-3 py-1.5 hairline-b flex items-center gap-2 bg-ink-900/30">
            <IconSearch size={12} className="text-fog-600 shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter by slug, id, project, title…"
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
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-[120px] shrink-0">
              slug
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-[168px] shrink-0">
              id
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 flex-1 min-w-0">
              title
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-[80px] shrink-0">
              created
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-[112px] shrink-0">
              project
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-[32px] text-right shrink-0">
              age
            </span>
          </div>
          <ul className="max-h-[360px] overflow-y-auto divide-y divide-ink-800">
            {error && !loading && (
              <li className="px-3 py-2 text-[11px] text-rust break-all">{error}</li>
            )}
            {sorted.map((s) => {
              const isGlobal = s.projectID === 'global';
              const project = projectMap.get(s.projectID);
              const projLabel = isGlobal
                ? 'global'
                : project
                  ? worktreeBasename(project.worktree)
                  : s.projectID.slice(0, 8);
              const projHoverDetail = isGlobal
                ? 'unscoped session'
                : project
                  ? `${project.worktree}\nproject ${s.projectID}`
                  : `project ${s.projectID} (worktree unknown)`;
              const idTail = s.id.startsWith('ses_') ? s.id.slice(4) : s.id;
              return (
                <li key={s.id}>
                  <Link
                    href={`/?session=${s.id}`}
                    onClick={() => close()}
                    className="px-3 h-7 flex items-center gap-3 hover:bg-ink-800/60 transition"
                    title={`${s.id}\n${projHoverDetail}`}
                  >
                    <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-700 w-[120px] shrink-0 whitespace-nowrap truncate">
                      {s.slug}
                    </span>
                    <span className="font-mono text-[10px] text-fog-500 tabular-nums shrink-0 w-[168px] whitespace-nowrap">
                      {idTail}
                    </span>
                    <span className="text-[11.5px] text-fog-200 flex-1 min-w-0 whitespace-nowrap truncate">
                      {s.title}
                    </span>
                    <span className="font-mono text-[10px] text-fog-500 tabular-nums shrink-0 w-[80px] whitespace-nowrap">
                      {fmtTs(s.time.created)}
                    </span>
                    <span
                      className={clsx(
                        'font-mono text-[10px] shrink-0 w-[112px] whitespace-nowrap truncate',
                        isGlobal ? 'text-fog-700' : 'text-iris'
                      )}
                    >
                      {projLabel}
                    </span>
                    <span className="font-mono text-[10px] text-fog-600 tabular-nums shrink-0 w-[32px] text-right">
                      {fmtAge(s.time.updated)}
                    </span>
                  </Link>
                </li>
              );
            })}
            {!loading && !error && sessions.length === 0 && (
              <li className="px-3 py-2 text-[11px] text-fog-600">no sessions found</li>
            )}
          </ul>
        </div>
      )}
    >
      <button className="inline-flex items-center gap-1.5 min-w-0 group max-w-full cursor-pointer">
        <span className="text-fog-200 group-hover:text-fog-100 truncate transition">
          {title}
        </span>
        <span className="font-mono text-[9px] text-fog-700 group-hover:text-fog-500 transition shrink-0">
          ▾
        </span>
      </button>
    </Popover>
  );
}
