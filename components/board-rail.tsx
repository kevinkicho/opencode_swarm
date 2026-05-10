'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useMemo, useState, useCallback } from 'react';
import {
  deriveBoardAgents,
  type LiveBoard,
  type LiveTicker,
  type TickerState,
} from '@/lib/blackboard/live';
import type { BoardAgent, BoardItem, BoardItemKind, BoardItemStatus } from '@/lib/blackboard/types';
import { applyBoardFilters, type BoardFilter } from '@/lib/blackboard/board-filters';
import type { SwarmPattern } from '@/lib/swarm-types';
import type { FileHeat } from '@/lib/opencode/transform';
import { Tooltip } from './ui/tooltip';
// main file stays under 500 LOC. Imports and usage unchanged.
import { TickerChip } from './board-rail/ticker-chip';
import { BoardRailRow } from './board-rail/board-rail-row';

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

// KIND_GLYPH / KIND_TONE / retryCountFromNote moved to ./board-rail/
// board-rail-row.tsx (only consumer is BoardRailRow, lifted in W5.18).

// Stigmergy decoration helpers (, Phase
// 1.6). Mirrors coordinator.ts::scoreTodoByHeat — full-path mention
// in todo content scores 2× the file's edit count, basename-only match
// (≥4 chars) scores 1×. Sum across all matched files in the heat map
// to get the row's heat score; normalize by the max across open items
// to drive the bar's width + tone. Surfaces "the picker would prefer
// this row" (cold = low score) vs "this row keeps getting picked"
// (hot = high score) at a glance, without leaving the board view.
function fileBasename(path: string): string {
  const norm = path.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx < 0 ? norm : norm.slice(idx + 1);
}

// server-side decayFactor in coordinator.ts so the row's bar reflects
// what the picker would actually score. Default half-life is 30 min;
// no env override on the client (server's OPENCODE_HEAT_HALF_LIFE_S
// isn't visible). Files touched recently count fully; old touches
// fade out, matching the picker bias.
const HEAT_HALF_LIFE_MS = 30 * 60 * 1000;
function heatDecay(lastTouchedMs: number): number {
  if (!lastTouchedMs || lastTouchedMs <= 0) return 1;
  const dt = Math.max(0, Date.now() - lastTouchedMs);
  return Math.pow(0.5, dt / HEAT_HALF_LIFE_MS);
}

function heatScoreForItem(item: BoardItem, heat: FileHeat[]): number {
  if (!heat.length) return 0;
  const content = item.content;
  let score = 0;
  for (const h of heat) {
    const norm = h.path.replace(/\\/g, '/');
    const decayedCount = h.editCount * heatDecay(h.lastTouchedMs);
    if (content.includes(norm)) {
      score += decayedCount * 2;
      continue;
    }
    const base = fileBasename(norm);
    if (base.length >= 4 && content.includes(base)) {
      score += decayedCount;
    }
  }
  return score;
}

// heatBarTone + ACCENT_BG moved to ./board-rail/board-rail-row.tsx.

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
  { key: 'stale',       label: 'stale',       matches: ['stale'],       tone: 'text-amber',   dot: 'bg-amber', collapsed: true },
  { key: 'blocked',     label: 'blocked',     matches: ['blocked'],     tone: 'text-amber',   dot: 'bg-amber' },
  { key: 'done',        label: 'done',        matches: ['done'],        tone: 'text-fog-500', dot: 'bg-fog-600', collapsed: true },
];

function PostQuestion({ swarmRunID }: { swarmRunID: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);

  const submit = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setPosting(true);
    try {
      await fetch(
        `/api/swarm/run/${encodeURIComponent(swarmRunID)}/board/items`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'question', content: trimmed }),
        },
      );
      setDraft('');
      setOpen(false);
    } catch { console.warn('board item post failed'); }
    setPosting(false);
  }, [draft, swarmRunID]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="font-mono text-micro uppercase tracking-widest2 text-fog-600 hover:text-fog-200 transition-colors cursor-pointer"
        title="post a question for agents or the human"
      >
        + ask
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setOpen(false); }}
        placeholder="type a question…"
        autoFocus
        disabled={posting}
        className="flex-1 min-w-0 bg-ink-700 border border-amber/40 rounded-sm px-1.5 font-mono text-[11px] text-fog-100 outline-none focus:border-amber"
      />
      <button
        type="button"
        onClick={submit}
        disabled={posting || !draft.trim()}
        className="font-mono text-[9px] uppercase tracking-widest2 text-amber hover:text-amber/80 disabled:opacity-40 cursor-pointer"
      >
        post
      </button>
    </div>
  );
}

export function BoardRail({
  swarmRunID,
  live,
  ticker,
  embedded = false,
  roleNames,
  pattern,
  heat = [],
  onSelectAgent,
  selectedAgentId,
}: {
  swarmRunID: string;
  // Live data passed in from a parent that owns the SSE subscription.
  // Keeping the hooks above this component means the connection stays
  // open when the board tab isn't active — no re-handshake lag when
  // the user toggles tabs.
  live: LiveBoard;
  ticker: LiveTicker;
  embedded?: boolean;
  // Optional ownerAgentId → role-name map (built from meta at the page
  // level via roleNamesFromMeta). When provided, board chips show role
  // labels for hierarchical patterns; absent → numeric fallback.
  roleNames?: ReadonlyMap<string, string>;
  // Pattern context — currently unused but threaded through for future
  // empty-state copy variations.
  pattern?: SwarmPattern;
  // Per-file heat data for the stigmergy decoration. Empty array →
  // no decoration rendered.
  heat?: FileHeat[];
  // Cross-panel linking: clicking an owner glyph selects the agent in
  // the roster and switches to that tab.
  onSelectAgent?: (agentId: string) => void;
  // Cross-panel linking: when an agent is selected elsewhere (roster,
  // plan), dim board items not owned by that agent.
  selectedAgentId?: string | null;
}) {
  const items = live.items ?? [];

  const agents = useMemo(() => deriveBoardAgents(items, roleNames), [items, roleNames]);
  const agentById = useMemo(() => {
    const m = new Map<string, BoardAgent>();
    agents.forEach((a) => m.set(a.id, a));
    return m;
  }, [agents]);

  // Pre-compute heat scores for every open item + the max so each row
  // can normalize without re-walking the heat array. Closed items
  // (in-progress / done / stale / blocked) get 0 — the picker only
  // scores open items, so the decoration follows the same scope.
  const { heatScoreById, maxHeatScore } = useMemo(() => {
    const scoreById = new Map<string, number>();
    let max = 0;
    for (const it of items) {
      if (it.status !== 'open') continue;
      const s = heatScoreForItem(it, heat);
      scoreById.set(it.id, s);
      if (s > max) max = s;
    }
    return { heatScoreById: scoreById, maxHeatScore: max };
  }, [items, heat]);

  // "done" starts collapsed; all others expanded. User can toggle any.
  const [expanded, setExpanded] = useState<Record<Section['key'], boolean>>(() => {
    const out = {} as Record<Section['key'], boolean>;
    for (const s of SECTIONS) out[s.key] = !s.collapsed;
    return out;
  });

  const [boardFilter, setBoardFilter] = useState<BoardFilter>({});

  const matchingIds = useMemo(() => {
    const hasStatus = boardFilter.status && boardFilter.status.length > 0;
    const hasKind = boardFilter.kind && boardFilter.kind.length > 0;
    const hasSearch = !!boardFilter.search;
    if (!hasStatus && !hasKind && !hasSearch) return null;
    const matched = applyBoardFilters(items, boardFilter);
    return new Set(matched.map((it) => it.id));
  }, [items, boardFilter]);

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
        <div className="px-3 py-2 font-mono text-[10px] text-fog-600 leading-snug flex flex-col gap-1">
          <span>
            board is empty — the planner sweep may still be running.
          </span>
        </div>
      )}
      {/* All 6 sections always rendered (in-progress / claimed / open /
          stale / blocked / done) so the user has a stable set of
          collapsible containers. Sections with 0 items render header-only
          (no "(none)" placeholder — the count next to the chevron is
          enough). Click any header to collapse / expand. */}
      {SECTIONS.map((section) => {
        const secItems = items
          .filter((it) => section.matches.includes(it.status))
          // newest first for active sections; done can stay created-desc too
          .sort((a, b) => (b.completedAtMs ?? b.createdAtMs) - (a.completedAtMs ?? a.createdAtMs));
        const isOpen = expanded[section.key];
        const hasItems = secItems.length > 0;
        return (
          <div key={section.key}>
            <button
              type="button"
              onClick={() =>
                setExpanded((prev) => ({ ...prev, [section.key]: !prev[section.key] }))
              }
              disabled={!hasItems}
              className={clsx(
                'w-full h-6 px-3 flex items-center gap-2 text-left transition',
                hasItems
                  ? 'hover:bg-ink-800/60 cursor-pointer'
                  : 'cursor-default opacity-60',
              )}
            >
              {/* Disclosure chevron — only rendered for sections with
                  items so the affordance isn't misleading on empty
                  sections. */}
              <span
                className={clsx(
                  'font-mono text-[9px] tabular-nums w-2 shrink-0 transition-transform',
                  hasItems ? section.tone : 'text-fog-700',
                  isOpen && hasItems && 'rotate-90',
                )}
              >
                {hasItems ? '▸' : '·'}
              </span>
              <span className={clsx('font-mono text-micro uppercase tracking-widest2', section.tone)}>
                {section.label}
              </span>
              <span className="font-mono text-[10px] text-fog-600 tabular-nums ml-auto">
                {secItems.length}
              </span>
            </button>
            {isOpen && hasItems && (
              secItems.map((item) => (
                <BoardRailRow
                  key={item.id}
                  item={item}
                  owner={item.ownerAgentId ? agentById.get(item.ownerAgentId) ?? null : null}
                  heatScore={heatScoreById.get(item.id) ?? 0}
                  maxHeatScore={maxHeatScore}
                  swarmRunID={swarmRunID}
                  onSelectAgent={onSelectAgent}
                  dimmed={
                    (!!selectedAgentId && item.ownerAgentId !== selectedAgentId) ||
                    (!!matchingIds && !matchingIds.has(item.id))
                  }
                />
              ))
            )}
          </div>
        );
      })}
    </div>
  );

  const footer = (
    <>
      <TickerChip ticker={ticker} />
      <Link
        href={`/board-preview?swarmRun=${swarmRunID}`}
        className="h-6 hairline-t px-3 flex items-center gap-1 font-mono text-micro uppercase tracking-widest2 text-fog-600 hover:text-fog-200 hover:bg-ink-800/60 transition shrink-0"
        title="open full board view"
      >
        full board
        <span className="text-fog-700 group-hover:text-fog-400">→</span>
      </Link>
      <div className="h-6 hairline-t px-3 flex items-center">
        <PostQuestion swarmRunID={swarmRunID} />
      </div>
    </>
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
      {/* Filter pills — dense row below header. Active toggles get their
          accent; inactive are dim fog. Search input on the right. */}
      <div className="hairline-b px-4 py-1 flex items-center gap-1.5 bg-ink-900/40 flex-wrap">
        {(['open', 'in-progress', 'done', 'stale'] as const).map((s) => {
          const active = boardFilter.status?.includes(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() =>
                setBoardFilter((prev) => {
                  const cur = prev.status ?? [];
                  const next = active ? cur.filter((v) => v !== s) : [...cur, s];
                  return { ...prev, status: next.length ? next : undefined };
                })
              }
              className={clsx(
                'font-mono text-[9px] uppercase tracking-widest2 px-1.5 h-5 rounded-sm hairline transition cursor-pointer',
                active
                  ? 'border-molten/50 bg-molten/10 text-molten'
                  : 'border-fog-700 text-fog-600 hover:text-fog-400 hover:border-fog-600',
              )}
            >
              {s}
            </button>
          );
        })}
        <span className="w-px h-3 bg-ink-600 mx-0.5" />
        {(['todo', 'criterion', 'finding'] as const).map((k) => {
          const active = boardFilter.kind?.includes(k);
          return (
            <button
              key={k}
              type="button"
              onClick={() =>
                setBoardFilter((prev) => {
                  const cur = prev.kind ?? [];
                  const next = active ? cur.filter((v) => v !== k) : [...cur, k];
                  return { ...prev, kind: next.length ? next : undefined };
                })
              }
              className={clsx(
                'font-mono text-[9px] uppercase tracking-widest2 px-1.5 h-5 rounded-sm hairline transition cursor-pointer',
                active
                  ? 'border-iris/50 bg-iris/10 text-iris'
                  : 'border-fog-700 text-fog-600 hover:text-fog-400 hover:border-fog-600',
              )}
            >
              {k}
            </button>
          );
        })}
        <input
          type="text"
          value={boardFilter.search ?? ''}
          onChange={(e) =>
            setBoardFilter((prev) => ({
              ...prev,
              search: e.target.value || undefined,
            }))
          }
          placeholder="search…"
          className="ml-auto w-[80px] bg-transparent border-0 border-b hairline-b border-fog-700 focus:border-fog-400 outline-none font-mono text-[10px] text-fog-200 placeholder:text-fog-700 py-0.5"
        />
      </div>
      {body}
      {footer}
    </section>
  );
}

