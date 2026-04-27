'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  deriveBoardAgents,
  type LiveBoard,
  type LiveTicker,
  type TickerState,
} from '@/lib/blackboard/live';
import type { BoardAgent, BoardItem, BoardItemKind, BoardItemStatus } from '@/lib/blackboard/types';
import type { SwarmPattern } from '@/lib/swarm-types';
import type { DeliberationProgress } from '@/lib/deliberate-progress';
import type { FileHeat } from '@/lib/opencode/transform';
import { Tooltip } from './ui/tooltip';
// HARDENING_PLAN.md#C14 — TickerChip lifted to a sibling file so the
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

// Stigmergy decoration helpers (PATTERN_DESIGN/stigmergy.md §3, Phase
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

// PATTERN_DESIGN/stigmergy.md I1 — heat half-life decay. Mirrors the
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
  { key: 'stale',       label: 'stale',       matches: ['stale'],       tone: 'text-amber',   dot: 'bg-amber' },
  { key: 'blocked',     label: 'blocked',     matches: ['blocked'],     tone: 'text-amber',   dot: 'bg-amber' },
  { key: 'done',        label: 'done',        matches: ['done'],        tone: 'text-fog-500', dot: 'bg-fog-600', collapsed: true },
];

export function BoardRail({
  swarmRunID,
  live,
  ticker,
  embedded = false,
  roleNames,
  pattern,
  deliberationProgress,
  heat = [],
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
  // Pattern context — same purpose as BoardFullView.pattern: the empty-
  // state message reflects the correct phase for deliberate-execute.
  pattern?: SwarmPattern;
  // Deliberation round inference for deliberate-execute runs —
  // rendered inline in the empty-state. Null for other patterns.
  deliberationProgress?: DeliberationProgress | null;
  // Per-file heat data for the stigmergy decoration. Empty array →
  // no decoration rendered. PATTERN_DESIGN/stigmergy.md §3.
  heat?: FileHeat[];
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
            {pattern === 'deliberate-execute'
              ? 'deliberating — council is exchanging drafts before execution.'
              : 'board is empty — the planner sweep may still be running.'}
          </span>
          {pattern === 'deliberate-execute' && deliberationProgress && (
            <span className="tabular-nums text-fog-500">
              round {Math.max(deliberationProgress.round, 1)} of{' '}
              {deliberationProgress.maxRounds}
              {deliberationProgress.round >= deliberationProgress.maxRounds && (
                <span className="ml-1.5 text-mint/80">· synthesizing</span>
              )}
            </span>
          )}
        </div>
      )}
      {/* All 6 sections always rendered (in-progress / claimed / open /
          stale / blocked / done) so the user has a stable set of
          collapsible containers regardless of which statuses the run
          currently has items in. Empty sections show "(none)" when
          expanded so the header carries all the signal when collapsed. */}
      {SECTIONS.map((section) => {
        const secItems = items
          .filter((it) => section.matches.includes(it.status))
          // newest first for active sections; done can stay created-desc too
          .sort((a, b) => (b.completedAtMs ?? b.createdAtMs) - (a.completedAtMs ?? a.createdAtMs));
        const isOpen = expanded[section.key];
        return (
          <div key={section.key}>
            <button
              type="button"
              onClick={() =>
                setExpanded((prev) => ({ ...prev, [section.key]: !prev[section.key] }))
              }
              className="w-full h-6 px-3 flex items-center gap-2 text-left hover:bg-ink-800/60 transition cursor-pointer"
            >
              <span className={clsx('font-mono text-micro uppercase tracking-widest2', section.tone)}>
                {section.label}
              </span>
              <span className="font-mono text-[10px] text-fog-600 tabular-nums ml-auto">
                {secItems.length}
              </span>
            </button>
            {isOpen && (
              secItems.length === 0 ? (
                <div className="pl-5 pr-2 h-5 flex items-center font-mono text-[10px] text-fog-700">
                  (none)
                </div>
              ) : (
                secItems.map((item) => (
                  <BoardRailRow
                    key={item.id}
                    item={item}
                    owner={item.ownerAgentId ? agentById.get(item.ownerAgentId) ?? null : null}
                    heatScore={heatScoreById.get(item.id) ?? 0}
                    maxHeatScore={maxHeatScore}
                  />
                ))
              )
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
      {body}
      {footer}
    </section>
  );
}

