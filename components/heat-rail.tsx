'use client';

// Heat rail — stigmergy v0. A read-only projection of which files the
// swarm has touched, sorted hot-first. Each row: intensity bar +
// basename + dir hint + agent-badges for each distinct toucher + edit
// count + last-touched relative time.
//
// Design stance: observation, never assignment (DESIGN.md §4.2). The
// rail tells the human "look, agents keep converging on src/auth/" —
// it does NOT let you reassign or pin a file. If the human wants the
// swarm to focus elsewhere, they nudge via the composer / directive,
// not via this panel.
//
// Decomposition (#108): pure helpers in heat-rail/utils.ts, tree
// builder + flattener in heat-rail/tree.ts, all visual subcomponents
// in heat-rail/sub-components.tsx. This file owns the main HeatRail
// component (state + composition) only.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FileHeat } from '@/lib/opencode/transform';
import type { Agent } from '@/lib/swarm-types';
import {
  HeatRow,
  HeatTreeView,
  ViewToggleButton,
} from './heat-rail/sub-components';

// heat-rail ↔ sub-components import cycle. Re-exported so existing
// callers (page.tsx etc.) don't need to update their imports.
export type { DiffStatsByPath } from './heat-rail/types';
import type { DiffStatsByPath } from './heat-rail/types';

export function HeatRail({
  heat,
  agents,
  workspace,
  diffStatsByPath,
  onSelect,
  embedded = false,
  swarmRunID,
}: {
  heat: FileHeat[];
  agents: Agent[];
  workspace: string;
  diffStatsByPath: DiffStatsByPath;
  onSelect?: (heat: FileHeat) => void;
  embedded?: boolean;
  swarmRunID?: string;
}) {
  const agentBySession = new Map<string, Agent>();
  for (const a of agents) if (a.sessionID) agentBySession.set(a.sessionID, a);
  const maxCount = Math.max(1, ...heat.map((h) => h.editCount));

  const [view, setView] = useState<'list' | 'tree' | 'all'>('tree');
  const [filter, setFilter] = useState('');
  const [sortOrder, setSortOrder] = useState<'hot' | 'alpha'>('hot');

  const filteredHeat = useMemo(() => {
    let data = heat;
    if (filter) {
      const f = filter.toLowerCase();
      data = heat.filter((h) => h.path.toLowerCase().includes(f));
    }

    if (sortOrder === 'alpha') {
      return [...data].sort((a, b) => a.path.localeCompare(b.path));
    }
    return [...data].sort((a, b) => b.editCount - a.editCount);
  }, [heat, filter, sortOrder]);

  // Workspace tree (cold-files view). Migrated to TanStack Query
  // (#109) — multiple heat-rails sharing the same swarmRunID dedup
  // automatically, and per-run cache invalidation comes for free.
  // Long staleTime because the workspace tree is effectively static
  // for the run's duration.
  const treeQuery = useQuery({
    queryKey: ['swarm-run', swarmRunID, 'tree'],
    queryFn: async ({ signal }): Promise<string[]> => {
      const res = await fetch(
        `/api/swarm/run/${encodeURIComponent(swarmRunID!)}/tree`,
        { cache: 'no-store', signal },
      );
      if (!res.ok) throw new Error(`tree fetch failed (${res.status})`);
      const json = (await res.json()) as { paths?: string[] };
      return json.paths ?? [];
    },
    enabled: view === 'all' && !!swarmRunID,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const workspaceFiles = treeQuery.data ?? null;
  const workspaceFilesError = treeQuery.error
    ? (treeQuery.error as Error).message
    : null;

  const filteredWorkspaceFiles = useMemo(() => {
    if (!filter || !workspaceFiles) return workspaceFiles;
    const f = filter.toLowerCase();
    return workspaceFiles.filter((p) => p.toLowerCase().includes(f));
  }, [workspaceFiles, filter]);

  const body =
    view === 'tree' || view === 'all' ? (
       <HeatTreeView
         heat={filteredHeat}
         workspace={workspace}
         maxCount={maxCount}
         agentBySession={agentBySession}
         diffStatsByPath={diffStatsByPath}
         onSelect={onSelect}
         coldPaths={view === 'all' ? filteredWorkspaceFiles ?? [] : null}
         coldLoading={view === 'all' && workspaceFiles === null && !workspaceFilesError}
         coldError={view === 'all' ? workspaceFilesError : null}
       />
    ) : (
      <ul className="flex-1 overflow-y-auto overflow-x-hidden py-1 list-none">
        {filteredHeat.length === 0 ? (
          <li className="px-3 py-2 font-mono text-micro uppercase tracking-widest2 text-fog-700">
            no file edits yet
          </li>
        ) : (
          filteredHeat.map((h) => (
            <HeatRow
              key={h.path}
              heat={h}
              workspace={workspace}
              maxCount={maxCount}
              agentBySession={agentBySession}
              diffStats={diffStatsByPath.get(h.path)}
              onSelect={onSelect}
            />
          ))
        )}
      </ul>
    );

  const header = (
    <div className="h-7 hairline-b px-3 flex items-center gap-2 bg-ink-850/80 backdrop-blur shrink-0">
      <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600 shrink-0">
        heat
      </span>
      <span className="font-mono text-micro text-fog-700 tabular-nums">
        {heat.length} files
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => setSortOrder(sortOrder === 'hot' ? 'alpha' : 'hot')}
          className="h-4 px-1.5 rounded font-mono text-micro uppercase tracking-widest2 transition cursor-pointer bg-ink-900 border border-ink-700 text-fog-500 hover:text-fog-200 hover:bg-ink-800/50"
        >
          sort: {sortOrder === 'hot' ? 'hot' : 'α'}
        </button>
        <div className="relative flex items-center">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter paths..."
            className="h-4 w-24 px-1.5 font-mono text-micro text-fog-300 bg-ink-900 border border-ink-700 outline-none focus:border-fog-500 transition-colors placeholder:text-fog-700"
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter('')}
              className="absolute right-1 top-1/2 -translate-y-1/2 h-3 w-3 flex items-center justify-center rounded-full font-mono text-[8px] text-fog-500 hover:text-fog-200 hover:bg-ink-800 transition-colors"
            >
              ×
            </button>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <ViewToggleButton
            active={view === 'list'}
            onClick={() => setView('list')}
            label="list"
            tooltip="hot-first flat list"
          />
          <ViewToggleButton
            active={view === 'tree'}
            onClick={() => setView('tree')}
            label="tree"
            tooltip="grouped by directory · hot files only"
          />
          {swarmRunID && (
            <ViewToggleButton
              active={view === 'all'}
              onClick={() => setView('all')}
              label="all"
              tooltip="full workspace tree · cold files muted (gitignore-aware)"
            />
          )}
        </div>
      </div>
    </div>
  );

  if (embedded) return <>{header}{body}</>;

  return (
    <section className="relative flex flex-col min-w-0 shrink-0 overflow-hidden max-h-[320px] hairline-b bg-ink-850">
      {header}
      {body}
    </section>
  );
}
