'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { deriveBoardAgents, useLiveBoard } from '@/lib/blackboard/live';
import type { BoardAgent, BoardItem, BoardItemKind, BoardItemStatus } from '@/lib/blackboard/types';
import { Tooltip } from './ui/tooltip';

// Inline board rail for the blackboard preset. Lives as a third tab in
// LeftTabs so blackboard runs don't force the user to leave `/?swarmRun=<id>`
// to see board state. The full 5-column kanban still lives at
// `/board-preview?swarmRun=<id>` and is one click away via the footer link —
// the rail is a compact read-only view optimized for 260px width.
//
// Contract:
//   - Read-only. Board mutations come from the coordinator loop, not the UI.
//   - Polls via useLiveBoard (2s cadence, same as /board-preview).
//   - Groups items by status in the order that encodes lifecycle time:
//     in-progress → claimed → open → stale → blocked → done. "done" is
//     collapsed behind a count; click to expand.
//   - Drift indicator (↯ sha) on stale items; owner pill matches the
//     color derived in deriveBoardAgents so the same agent gets the same
//     accent on board-preview and the rail.

const KIND_GLYPH: Record<BoardItemKind, string> = {
  claim: '◎',
  question: '?',
  todo: '·',
  finding: '✓',
};

const KIND_TONE: Record<BoardItemKind, string> = {
  claim: 'text-iris',
  question: 'text-amber',
  todo: 'text-fog-400',
  finding: 'text-mint',
};

const ACCENT_BG: Record<BoardAgent['accent'], string> = {
  molten: 'bg-molten/20 text-molten',
  mint: 'bg-mint/20 text-mint',
  iris: 'bg-iris/20 text-iris',
  amber: 'bg-amber/20 text-amber',
  fog: 'bg-fog-700/40 text-fog-300',
};

interface Section {
  key: 'in-progress' | 'claimed' | 'open' | 'stale' | 'blocked' | 'done';
  label: string;
  tone: string;
  dot: string;
  matches: BoardItemStatus[];
  collapsed?: boolean; // initial collapse state
}

const SECTIONS: Section[] = [
  { key: 'in-progress', label: 'in-progress', matches: ['in-progress'], tone: 'text-mint',    dot: 'bg-mint' },
  { key: 'claimed',     label: 'claimed',     matches: ['claimed'],     tone: 'text-iris',    dot: 'bg-iris' },
  { key: 'open',        label: 'open',        matches: ['open'],        tone: 'text-fog-300', dot: 'bg-fog-500' },
  { key: 'stale',       label: 'stale',       matches: ['stale'],       tone: 'text-amber',   dot: 'bg-amber' },
  { key: 'blocked',     label: 'blocked',     matches: ['blocked'],     tone: 'text-amber',   dot: 'bg-amber' },
  { key: 'done',        label: 'done',        matches: ['done'],        tone: 'text-fog-500', dot: 'bg-fog-600', collapsed: true },
];

export function BoardRail({
  swarmRunID,
  embedded = false,
}: {
  swarmRunID: string;
  embedded?: boolean;
}) {
  const live = useLiveBoard(swarmRunID);
  const items = live.items ?? [];

  const agents = useMemo(() => deriveBoardAgents(items), [items]);
  const agentById = useMemo(() => {
    const m = new Map<string, BoardAgent>();
    agents.forEach((a) => m.set(a.id, a));
    return m;
  }, [agents]);

  // "done" starts collapsed; all others expanded. User can toggle any.
  const [expanded, setExpanded] = useState<Record<Section['key'], boolean>>(() => {
    const out = {} as Record<Section['key'], boolean>;
    for (const s of SECTIONS) out[s.key] = !s.collapsed;
    return out;
  });

  const loading = live.items === null && !live.error;

  const body = (
    <div className="flex-1 overflow-y-auto">
      {live.error && (
        <div className="px-3 py-2 font-mono text-[10px] text-molten" title={live.error}>
          error · {live.error.slice(0, 80)}
        </div>
      )}
      {loading && !live.error && (
        <div className="px-3 py-2 font-mono text-[10px] text-fog-600">loading…</div>
      )}
      {!loading && !live.error && items.length === 0 && (
        <div className="px-3 py-2 font-mono text-[10px] text-fog-600 leading-snug">
          board is empty — the planner sweep may still be running.
        </div>
      )}
      {SECTIONS.map((section) => {
        const secItems = items
          .filter((it) => section.matches.includes(it.status))
          // newest first for active sections; done can stay created-desc too
          .sort((a, b) => (b.completedAtMs ?? b.createdAtMs) - (a.completedAtMs ?? a.createdAtMs));
        if (secItems.length === 0) return null;
        const isOpen = expanded[section.key];
        return (
          <div key={section.key}>
            <button
              type="button"
              onClick={() =>
                setExpanded((prev) => ({ ...prev, [section.key]: !prev[section.key] }))
              }
              className="w-full h-6 px-3 flex items-center gap-2 text-left hover:bg-ink-800/60 transition"
            >
              <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', section.dot)} />
              <span className={clsx('font-mono text-micro uppercase tracking-widest2', section.tone)}>
                {section.label}
              </span>
              <span className="font-mono text-[10px] text-fog-600 tabular-nums ml-auto">
                {secItems.length}
              </span>
              <span className="font-mono text-[9px] text-fog-700 w-2 text-right">
                {isOpen ? '−' : '+'}
              </span>
            </button>
            {isOpen &&
              secItems.map((item) => (
                <BoardRailRow
                  key={item.id}
                  item={item}
                  owner={item.ownerAgentId ? agentById.get(item.ownerAgentId) ?? null : null}
                />
              ))}
          </div>
        );
      })}
    </div>
  );

  const footer = (
    <Link
      href={`/board-preview?swarmRun=${swarmRunID}`}
      className="h-6 hairline-t px-3 flex items-center gap-1 font-mono text-micro uppercase tracking-widest2 text-fog-600 hover:text-fog-200 hover:bg-ink-800/60 transition shrink-0"
      title="open full board view"
    >
      full board
      <span className="text-fog-700 group-hover:text-fog-400">→</span>
    </Link>
  );

  if (embedded) {
    return (
      <>
        {body}
        {footer}
      </>
    );
  }

  return (
    <section className="relative flex flex-col min-w-0 shrink-0 max-h-[420px] hairline-b bg-ink-850">
      <div className="h-10 hairline-b px-4 flex items-center gap-2 bg-ink-850/80 backdrop-blur">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          board
        </span>
        <span className="font-mono text-micro text-fog-700 tabular-nums">
          {items.filter((i) => i.status === 'done').length}/{items.length}
        </span>
      </div>
      {body}
      {footer}
    </section>
  );
}

function BoardRailRow({
  item,
  owner,
}: {
  item: BoardItem;
  owner: BoardAgent | null;
}) {
  const isStale = item.status === 'stale';
  return (
    <Tooltip
      side="right"
      wide
      content={
        <div className="space-y-1 max-w-[340px]">
          <div className="font-mono text-[11px] text-fog-200 leading-snug break-words">
            {item.content}
          </div>
          <div className="font-mono text-[10px] text-fog-500 flex items-center gap-1 flex-wrap">
            <span className={KIND_TONE[item.kind]}>{item.kind}</span>
            <span className="text-fog-700">·</span>
            <span className="uppercase tracking-widest2">{item.status}</span>
            {owner && (
              <>
                <span className="text-fog-700">·</span>
                <span className="text-fog-300">{owner.name}</span>
              </>
            )}
            <span className="text-fog-700">·</span>
            <span className="tabular-nums">{item.id}</span>
          </div>
          {isStale && item.staleSinceSha && (
            <div className="font-mono text-[10px] text-amber">
              files moved · head now {item.staleSinceSha}
            </div>
          )}
          {item.fileHashes && item.fileHashes.length > 0 && (
            <div className="font-mono text-[10px] text-fog-500 leading-snug">
              {item.fileHashes.map((f) => (
                <div key={f.path} className="flex items-center gap-1">
                  <span className="text-fog-600 truncate">{f.path}</span>
                  <span className="text-fog-700">@</span>
                  <span className="text-fog-400 tabular-nums">{f.sha}</span>
                </div>
              ))}
            </div>
          )}
          {item.note && (
            <div className="font-mono text-[10px] text-fog-500 italic leading-snug">
              {item.note}
            </div>
          )}
        </div>
      }
    >
      <div className="pl-5 pr-2 h-6 flex items-center gap-1.5 hover:bg-ink-800/40 cursor-default transition">
        <span
          className={clsx(
            'shrink-0 w-3 text-center font-mono text-[11px] leading-none',
            KIND_TONE[item.kind]
          )}
          aria-label={item.kind}
        >
          {KIND_GLYPH[item.kind]}
        </span>
        <span className="text-[11.5px] text-fog-200 truncate flex-1 min-w-0 font-mono">
          {item.content}
        </span>
        {isStale && item.staleSinceSha && (
          <span
            className="shrink-0 font-mono text-[9px] text-amber tabular-nums"
            title={`files moved · head ${item.staleSinceSha}`}
          >
            ↯{item.staleSinceSha.slice(0, 4)}
          </span>
        )}
        {owner ? (
          <span
            className={clsx(
              'shrink-0 w-4 h-4 grid place-items-center rounded-sm font-mono text-[9.5px] leading-none',
              ACCENT_BG[owner.accent]
            )}
            title={owner.name}
          >
            {owner.glyph}
          </span>
        ) : (
          <span
            className="shrink-0 w-4 h-4 grid place-items-center rounded-sm font-mono text-[9.5px] leading-none text-fog-700 bg-ink-800"
            title="unclaimed"
          >
            —
          </span>
        )}
      </div>
    </Tooltip>
  );
}
