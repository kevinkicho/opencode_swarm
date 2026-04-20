'use client';

import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { CommitRecord, CommitAction, CommitActionKind } from '@/lib/commits-data';
import {
  commits,
  rootAgent,
  agentCount,
  aggregateTokens,
  totalCost,
  shippedTokens,
  exploredTokens,
  tokensTotal,
} from '@/lib/commits-data';
import { Tooltip } from './ui/tooltip';
import { IconWinClose, IconSearch, IconBranch } from './icons';

const statusMeta: Record<
  CommitRecord['status'],
  { label: string; dot: string; text: string }
> = {
  success: { label: 'success', dot: 'bg-mint', text: 'text-mint' },
  failure: { label: 'rollback', dot: 'bg-rust', text: 'text-rust' },
  in_progress: { label: 'live', dot: 'bg-molten animate-pulse-ring', text: 'text-molten' },
};

const actionKindMeta: Record<CommitActionKind, { label: string; color: string }> = {
  directive: { label: 'directive', color: 'text-fog-100' },
  thought: { label: 'thought', color: 'text-iris' },
  delegate: { label: 'delegate', color: 'text-molten' },
  tool: { label: 'tool', color: 'text-fog-300' },
  response: { label: 'response', color: 'text-mint' },
  review: { label: 'review', color: 'text-amber' },
  commit: { label: 'commit', color: 'text-mint' },
};

export function CommitHistory({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [selectedId, setSelectedId] = useState<string>(commits[0].id);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!query) return commits;
    const q = query.toLowerCase();
    return commits.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.sha.toLowerCase().includes(q) ||
        rootAgent(c).toLowerCase().includes(q)
    );
  }, [query]);

  const selected = commits.find((c) => c.id === selectedId) ?? commits[0];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[70] grid place-items-center px-4 py-8"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <button
            aria-label="close"
            onClick={onClose}
            className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm"
          />
          <motion.div
            className="relative w-full max-w-[1440px] h-[90vh] bg-ink-850 mica-sheet rounded-lg hairline shadow-card overflow-hidden flex flex-col"
            initial={{ y: -8, opacity: 0, scale: 0.99 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -4, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
          >
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-molten/40 to-transparent" />

            <header className="h-11 shrink-0 hairline-b px-4 flex items-center gap-3 mica">
              <IconBranch size={14} className="text-molten" />
              <div>
                <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500 leading-none">
                  branch history
                </div>
                <div className="text-[13px] text-fog-100 leading-tight mt-0.5">
                  commits prompts tools reviews
                </div>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <div className="relative">
                  <IconSearch
                    size={11}
                    className="absolute left-2 top-1/2 -translate-y-1/2 text-fog-600"
                  />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="search commits..."
                    className="w-56 h-7 pl-6 pr-2 rounded bg-ink-900 hairline text-[12px] text-fog-100 placeholder:text-fog-700 focus:outline-none focus:border-molten/40 transition"
                  />
                </div>
                <button
                  onClick={onClose}
                  className="fluent-btn w-8 h-8 min-w-0 p-0 text-fog-400"
                  aria-label="close"
                >
                  <IconWinClose size={11} />
                </button>
              </div>
            </header>

            <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: '380px 1fr' }}>
              <CommitList
                commits={filtered}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
              <CommitDetail commit={selected} />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CommitList({
  commits,
  selectedId,
  onSelect,
}: {
  commits: CommitRecord[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="hairline-r overflow-y-auto bg-ink-850">
      <ul>
        {commits.map((c) => {
          const st = statusMeta[c.status];
          const totalAdded = c.files.reduce((s, f) => s + f.added, 0);
          const totalRemoved = c.files.reduce((s, f) => s + f.removed, 0);
          const active = c.id === selectedId;
          return (
            <li key={c.id}>
              <button
                onClick={() => onSelect(c.id)}
                className={clsx(
                  'w-full text-left px-3 py-2 hairline-b relative transition',
                  active ? 'bg-ink-800' : 'hover:bg-ink-800/60'
                )}
              >
                {active && (
                  <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-molten" />
                )}
                <div className="flex items-center gap-2">
                  <span className="font-mono text-micro text-fog-500 tabular-nums">
                    {c.sha}
                  </span>
                  {c.status !== 'in_progress' && (
                    <span
                      className={clsx(
                        'font-mono text-micro uppercase tracking-widest2 ml-auto',
                        st.text
                      )}
                    >
                      {st.label}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-[12.5px] text-fog-100 leading-tight line-clamp-2">
                  {c.title}
                </div>
                <div className="mt-1 flex items-center gap-3 font-mono text-micro text-fog-600 tabular-nums">
                  <span>{c.timestamp}</span>
                  <span className="text-mint/80 w-10 text-right">+{totalAdded}</span>
                  <span className="text-rust/80 w-10 text-right">-{totalRemoved}</span>
                  <span className="ml-auto">{rootAgent(c)}</span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function CommitDetail({ commit }: { commit: CommitRecord }) {
  const totalAdded = commit.files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = commit.files.reduce((s, f) => s + f.removed, 0);
  const tokens = aggregateTokens(commit);
  const total = tokensTotal(tokens);
  const shipped = shippedTokens(commit);
  const explored = exploredTokens(commit);
  const cost = totalCost(commit);

  return (
    <div className="flex flex-col min-h-0 bg-ink-800">
      <div className="shrink-0 hairline-b px-5 py-3 bg-ink-850/50">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="font-mono text-micro text-fog-500 tabular-nums">
            {commit.sha}
          </span>
          <span className="font-mono text-micro text-fog-500 tabular-nums">
            {commit.timestamp}
          </span>
          {commit.status !== 'in_progress' && (
            <span
              className={clsx(
                'ml-auto font-mono text-micro uppercase tracking-widest2',
                statusMeta[commit.status].text
              )}
            >
              {statusMeta[commit.status].label}
            </span>
          )}
        </div>
        <h2 className="text-[15px] text-fog-100 leading-tight">{commit.title}</h2>
        <p className="mt-1.5 text-[12px] text-fog-400 leading-snug max-w-[720px]">
          {commit.summary}
        </p>
        <div className="mt-2 flex items-center gap-4 font-mono text-micro text-fog-600 tabular-nums">
          <span>root <span className="text-fog-200">{rootAgent(commit)}</span></span>
          <span>{agentCount(commit)} agents</span>
          <span>{commit.duration}</span>
          <Tooltip
            content={
              <div className="font-mono text-micro text-fog-300 leading-relaxed">
                <div className="text-fog-500">in / out / cache-read / cache-create</div>
                <div className="tabular-nums text-fog-100">
                  {(tokens.in / 1000).toFixed(1)}k /{' '}
                  {(tokens.out / 1000).toFixed(1)}k /{' '}
                  {(tokens.cacheRead / 1000).toFixed(1)}k /{' '}
                  {(tokens.cacheCreation / 1000).toFixed(1)}k
                </div>
                {explored > 0 && (
                  <div className="mt-1 text-fog-500">
                    shipped {(shipped / 1000).toFixed(1)}k
                    <span className="text-fog-700"> · </span>
                    explored {(explored / 1000).toFixed(1)}k
                  </div>
                )}
              </div>
            }
          >
            <span className="cursor-help">
              {(total / 1000).toFixed(1)}k tok
              {explored > 0 && (
                <span className="text-fog-700">
                  {' '}(+{(explored / 1000).toFixed(1)}k explored)
                </span>
              )}
            </span>
          </Tooltip>
          <span>${cost.toFixed(2)}</span>
          <span className="ml-auto flex items-center gap-3">
            <span className="text-mint/80 w-12 text-right">+{totalAdded}</span>
            <span className="text-rust/80 w-12 text-right">-{totalRemoved}</span>
          </span>
        </div>
      </div>

      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <FilesPane files={commit.files} />
        <ActionsPane actions={commit.actions} />
      </div>
    </div>
  );
}

function FilesPane({ files }: { files: CommitRecord['files'] }) {
  return (
    <section className="flex flex-col min-h-0 hairline-r">
      <div className="shrink-0 h-9 hairline-b px-4 flex items-center gap-2 bg-ink-850/50">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
          files changed
        </span>
        <span className="font-mono text-micro text-fog-700">{files.length}</span>
      </div>
      <ul className="flex-1 overflow-y-auto">
        {files.map((f) => (
          <li
            key={f.path}
            className="px-4 h-6 flex items-center gap-3 hairline-b hover:bg-ink-800/50 transition"
          >
            <span className="font-mono text-[11.5px] text-fog-200 truncate flex-1 min-w-0">
              {f.path}
            </span>
            <span className="font-mono text-micro tabular-nums text-mint/80 w-10 text-right shrink-0">
              +{f.added}
            </span>
            <span className="font-mono text-micro tabular-nums text-rust/80 w-10 text-right shrink-0">
              -{f.removed}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ActionsPane({ actions }: { actions: CommitAction[] }) {
  return (
    <section className="flex flex-col min-h-0">
      <div className="shrink-0 h-9 hairline-b px-4 flex items-center gap-2 bg-ink-850/50">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
          action log
        </span>
        <span className="font-mono text-micro text-fog-700">{actions.length}</span>
      </div>
      <ul className="flex-1 overflow-y-auto">
        {actions.map((a) => (
          <ActionRow key={a.id} action={a} />
        ))}
      </ul>
    </section>
  );
}

function ActionRow({ action }: { action: CommitAction }) {
  const meta = actionKindMeta[action.kind];

  return (
    <li className="px-4 py-1.5 hairline-b hover:bg-ink-800/50 transition">
      <div className="flex items-center gap-3">
        <span className={clsx('font-mono text-micro uppercase tracking-wider shrink-0 w-16', meta.color)}>
          {meta.label}
        </span>
        <span className="font-mono text-micro text-fog-500 tabular-nums shrink-0 w-14">
          {action.timestamp}
        </span>
        <span className="font-mono text-micro text-fog-500 ml-auto shrink-0">
          {action.agent}
        </span>
      </div>
      <div className="mt-0.5 text-[12px] text-fog-100 leading-tight">{action.title}</div>
      {action.body && (
        <div className="mt-0.5 text-[11.5px] text-fog-400 leading-snug max-w-[420px]">
          {action.body}
        </div>
      )}
      {action.toolTarget && (
        <div className="mt-1 flex items-center gap-3 font-mono text-[11px] text-fog-500">
          {action.toolKind && (
            <span className="font-mono text-micro uppercase tracking-wider text-fog-600 shrink-0 w-10">
              {action.toolKind}
            </span>
          )}
          <span className="truncate flex-1 min-w-0">{action.toolTarget}</span>
          {action.cost != null && (
            <span className="text-fog-600 tabular-nums w-14 text-right shrink-0">
              ${action.cost.toFixed(3)}
            </span>
          )}
        </div>
      )}
    </li>
  );
}
