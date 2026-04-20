'use client';

import clsx from 'clsx';
import { useMemo, useState } from 'react';
import type { TimelineNode } from '@/lib/types';
import { TimelineNodeCard } from './timeline-node';
import { IconSearch, IconFilter, IconBranch } from './icons';

type FilterKey = 'all' | 'tool' | 'edit' | 'think' | 'agent' | 'decision' | 'errors';

const filters: { key: FilterKey; label: string; count?: number }[] = [
  { key: 'all', label: 'all' },
  { key: 'tool', label: 'tools' },
  { key: 'edit', label: 'edits' },
  { key: 'think', label: 'thinking' },
  { key: 'agent', label: 'agents' },
  { key: 'decision', label: 'decisions' },
  { key: 'errors', label: 'errors' },
];

function matches(node: TimelineNode, f: FilterKey): boolean {
  if (f === 'all') return true;
  if (f === 'tool') return node.kind === 'tool';
  if (f === 'edit') return node.kind === 'tool' && (node.toolKind === 'edit' || node.toolKind === 'write');
  if (f === 'think') return node.kind === 'thinking';
  if (f === 'agent') return node.kind === 'agent';
  if (f === 'decision') return node.kind === 'decision';
  if (f === 'errors') return node.status === 'error';
  return true;
}

export function TimelinePane({
  nodes,
  focusedId,
  onFocus,
}: {
  nodes: TimelineNode[];
  focusedId: string | null;
  onFocus: (id: string) => void;
}) {
  const [filter, setFilter] = useState<FilterKey>('all');
  const [query, setQuery] = useState('');

  const counts = useMemo(() => {
    const c: Partial<Record<FilterKey, number>> = {};
    filters.forEach((f) => {
      c[f.key] = nodes.filter((n) => matches(n, f.key)).length;
    });
    return c;
  }, [nodes]);

  const flat = useMemo(() => {
    const parentIds = new Set<string>();
    nodes.forEach((n) => n.agentChildren?.forEach((id) => parentIds.add(id)));
    return nodes.map((n) => ({
      node: n,
      nested: parentIds.has(n.id),
    }));
  }, [nodes]);

  const visible = flat.filter(({ node }) => {
    if (!matches(node, filter)) return false;
    if (!query) return true;
    const hay =
      `${node.title} ${node.subtitle ?? ''} ${node.preview ?? ''} ${node.toolKind ?? ''}`.toLowerCase();
    return hay.includes(query.toLowerCase());
  });

  const stats = useMemo(() => {
    const total = nodes.length;
    const tools = nodes.filter((n) => n.kind === 'tool').length;
    const edits = nodes.filter(
      (n) => n.kind === 'tool' && (n.toolKind === 'edit' || n.toolKind === 'write')
    ).length;
    const errors = nodes.filter((n) => n.status === 'error').length;
    return { total, tools, edits, errors };
  }, [nodes]);

  return (
    <section className="relative flex flex-col min-w-0 min-h-0 bg-ink-800">
      <div className="relative hairline-b">
        <div className="h-10 px-4 flex items-center gap-3 bg-ink-800/80 backdrop-blur">
          <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
            session timeline
          </span>
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-micro text-fog-700">{stats.total} events</span>
            <span className="text-fog-800"> </span>
            <span className="font-mono text-micro text-fog-700">{stats.tools} tools</span>
            <span className="text-fog-800"> </span>
            <span className="font-mono text-micro text-mint">+{stats.edits} edits</span>
            {stats.errors > 0 && (
              <>
                <span className="text-fog-800"> </span>
                <span className="font-mono text-micro text-rust">{stats.errors} errors</span>
              </>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button className="flex items-center gap-1.5 h-6 px-2 rounded hairline bg-ink-700 hover:border-ink-500 transition">
              <IconBranch size={11} className="text-molten" />
              <span className="font-mono text-micro uppercase tracking-wider text-fog-400">
                branch from here
              </span>
            </button>
          </div>
        </div>

        <div className="px-4 pb-3 pt-1 flex items-center gap-2">
          <div className="relative flex-1 max-w-md">
            <IconSearch
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fog-600"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search titles, files, tools..."
              className="w-full h-7 pl-7 pr-2.5 rounded bg-ink-900 hairline text-[12px] text-fog-100 placeholder:text-fog-700 focus:outline-none focus:border-molten/40 transition"
            />
          </div>

          <div className="flex items-center gap-1">
            <IconFilter size={11} className="text-fog-700 mr-1" />
            {filters.map((f) => {
              const active = filter === f.key;
              const n = counts[f.key] ?? 0;
              return (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={clsx(
                    'group h-7 px-2 rounded-md flex items-center gap-1.5 transition',
                    active ? 'bg-ink-700 text-fog-100 hairline border-ink-500' : 'text-fog-500 hover:text-fog-200'
                  )}
                >
                  <span className="font-mono text-micro uppercase tracking-wider">
                    {f.label}
                  </span>
                  <span
                    className={clsx(
                      'font-mono text-micro',
                      active ? 'text-molten' : 'text-fog-700'
                    )}
                  >
                    {n}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div
          aria-hidden
          className="absolute left-0 right-0 bottom-0 h-px bg-gradient-to-r from-transparent via-ink-500/40 to-transparent"
        />
      </div>

      <div className="relative flex-1 overflow-y-auto bg-grid-dots">
        {visible.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="font-display italic text-[22px] text-fog-600">nothing here</div>
            <div className="font-mono text-micro text-fog-700 mt-1">
              filter {filter} no matches
            </div>
          </div>
        )}

        <div className="py-3">
          {visible.map(({ node, nested }) => (
            <TimelineNodeCard
              key={node.id}
              node={node}
              focused={focusedId === node.id}
              onFocus={onFocus}
              nested={nested}
            />
          ))}
        </div>

        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-ink-800 to-transparent"
        />
      </div>
    </section>
  );
}
