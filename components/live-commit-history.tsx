'use client';

import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { LiveTurn } from '@/lib/opencode/transform';
import type { DiffData } from '@/lib/types';
import { filterDiffsForTurn } from '@/lib/opencode/transform';
import { Tooltip } from './ui/tooltip';
import { DiffView } from './diff-view';
import { IconWinClose, IconSearch, IconBranch } from './icons';

const statusMeta: Record<
  LiveTurn['status'],
  { label: string; dot: string; text: string }
> = {
  success: { label: 'success', dot: 'bg-mint', text: 'text-mint' },
  failure: { label: 'rollback', dot: 'bg-rust', text: 'text-rust' },
  in_progress: { label: 'live', dot: 'bg-molten animate-pulse-ring', text: 'text-molten' },
};

export function LiveCommitHistory({
  open,
  onClose,
  turns,
  diffs,
  loading,
  error,
}: {
  open: boolean;
  onClose: () => void;
  turns: LiveTurn[];
  diffs: DiffData[] | null;
  loading: boolean;
  error: string | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // Auto-select the most recent turn when the drawer opens (or the turn list
  // grows with a newer turn than what's currently selected).
  useEffect(() => {
    if (!open) return;
    if (turns.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !turns.some((t) => t.id === selectedId)) {
      setSelectedId(turns[turns.length - 1].id);
    }
  }, [open, turns, selectedId]);

  const filtered = useMemo(() => {
    if (!query) return turns;
    const q = query.toLowerCase();
    return turns.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.sha.toLowerCase().includes(q) ||
        t.agent.toLowerCase().includes(q) ||
        t.files.some((f) => f.toLowerCase().includes(q))
    );
  }, [query, turns]);

  const selected = turns.find((t) => t.id === selectedId) ?? null;
  const scopedDiffs = useMemo(
    () => (selected && diffs ? filterDiffsForTurn(diffs, selected.files) : []),
    [selected, diffs]
  );

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
                  branch history · live session
                </div>
                <div className="text-[13px] text-fog-100 leading-tight mt-0.5">
                  turns diffs files
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
                    placeholder="search turns..."
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
              <TurnList
                turns={filtered}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
              <TurnDetail
                turn={selected}
                diffs={scopedDiffs}
                loading={loading}
                error={error}
                totalTurns={turns.length}
              />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function TurnList({
  turns,
  selectedId,
  onSelect,
}: {
  turns: LiveTurn[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (turns.length === 0) {
    return (
      <aside className="hairline-r bg-ink-850 grid place-items-center">
        <div className="text-center px-6">
          <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
            no file edits yet
          </div>
          <div className="mt-1.5 text-[12px] text-fog-500 leading-snug">
            turns show up here once the agent commits its first patch
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="hairline-r overflow-y-auto bg-ink-850">
      <ul>
        {turns.map((t) => {
          const st = statusMeta[t.status];
          const active = t.id === selectedId;
          return (
            <li key={t.id}>
              <button
                onClick={() => onSelect(t.id)}
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
                    {t.sha}
                  </span>
                  <span
                    className={clsx(
                      'font-mono text-micro uppercase tracking-widest2 ml-auto flex items-center gap-1.5',
                      st.text
                    )}
                  >
                    <span className={clsx('w-1 h-1 rounded-full', st.dot)} />
                    {st.label}
                  </span>
                </div>
                <div className="mt-1 text-[12.5px] text-fog-100 leading-tight line-clamp-2">
                  {t.title}
                </div>
                <div className="mt-1 flex items-center gap-3 font-mono text-micro text-fog-600 tabular-nums">
                  <span>{t.timestamp}</span>
                  <span className="text-fog-500">
                    {t.files.length} file{t.files.length === 1 ? '' : 's'}
                  </span>
                  <span className="ml-auto text-fog-500">{t.agent}</span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function TurnDetail({
  turn,
  diffs,
  loading,
  error,
  totalTurns,
}: {
  turn: LiveTurn | null;
  diffs: DiffData[];
  loading: boolean;
  error: string | null;
  totalTurns: number;
}) {
  if (!turn) {
    return (
      <div className="flex flex-col min-h-0 bg-ink-800 grid place-items-center">
        <div className="text-center px-6">
          <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
            {totalTurns === 0 ? 'nothing to show' : 'select a turn'}
          </div>
          {totalTurns > 0 && (
            <div className="mt-1.5 text-[12px] text-fog-500 leading-snug">
              pick a turn on the left to see the files it touched
            </div>
          )}
        </div>
      </div>
    );
  }

  const totalAdded = diffs.reduce((s, d) => s + d.additions, 0);
  const totalRemoved = diffs.reduce((s, d) => s + d.deletions, 0);

  return (
    <div className="flex flex-col min-h-0 bg-ink-800">
      <div className="shrink-0 hairline-b px-5 py-3 bg-ink-850/50">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="font-mono text-micro text-fog-500 tabular-nums">
            {turn.sha}
          </span>
          <span className="font-mono text-micro text-fog-500 tabular-nums">
            {turn.timestamp}
          </span>
          <span
            className={clsx(
              'ml-auto font-mono text-micro uppercase tracking-widest2',
              statusMeta[turn.status].text
            )}
          >
            {statusMeta[turn.status].label}
          </span>
        </div>
        <h2 className="text-[15px] text-fog-100 leading-tight">{turn.title}</h2>
        {turn.summary && (
          <p className="mt-1.5 text-[12px] text-fog-400 leading-snug max-w-[720px]">
            {turn.summary}
          </p>
        )}
        <div className="mt-2 flex items-center gap-4 font-mono text-micro text-fog-600 tabular-nums">
          <span>agent <span className="text-fog-200">{turn.agent}</span></span>
          <span>
            {turn.files.length} file{turn.files.length === 1 ? '' : 's'}
          </span>
          {turn.tokens != null && (
            <span>{(turn.tokens / 1000).toFixed(1)}k tok</span>
          )}
          {turn.cost != null && <span>${turn.cost.toFixed(3)}</span>}
          <span className="ml-auto flex items-center gap-3">
            <span className="text-mint/80 w-12 text-right">+{totalAdded}</span>
            <span className="text-rust/80 w-12 text-right">-{totalRemoved}</span>
          </span>
        </div>
      </div>

      <div className="shrink-0 hairline-b px-5 py-1.5 bg-ink-850/30 flex items-center gap-2">
        <Tooltip
          side="bottom"
          wide
          content={
            <div className="space-y-1 min-w-[280px]">
              <div className="font-mono text-[11px] text-fog-200">
                diff text is session-wide
              </div>
              <div className="font-mono text-[10.5px] text-fog-500 leading-snug">
                opencode's diff endpoint returns one delta per file across the
                entire session. We scope the file <em>list</em> to this turn's
                patch, but the patch <em>text</em> shows every change to those
                files in this session.
              </div>
            </div>
          }
        >
          <span className="font-mono text-micro uppercase tracking-widest2 text-amber/80 cursor-help">
            session-aggregate
          </span>
        </Tooltip>
        <span className="font-mono text-micro text-fog-600">
          — text below is the total delta for these {diffs.length} file
          {diffs.length === 1 ? '' : 's'}, not just what this turn contributed
        </span>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-3">
        {error && (
          <div className="rounded hairline border-rust/40 bg-rust/10 px-3 py-2 font-mono text-[11px] text-rust">
            diff fetch failed: {error}
          </div>
        )}
        {loading && !diffs.length && (
          <div className="font-mono text-micro text-fog-600 uppercase tracking-widest2 py-4 text-center">
            loading diff…
          </div>
        )}
        {!loading && !error && diffs.length === 0 && (
          <div className="font-mono text-micro text-fog-600 uppercase tracking-widest2 py-4 text-center">
            no diff data for this turn's files
          </div>
        )}
        {diffs.map((d) => (
          <DiffView key={d.file} diff={d} />
        ))}
      </div>
    </div>
  );
}
