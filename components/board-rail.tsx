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

// Per-kind glyph. Todo is the default kind — we leave its glyph blank so
// the row reads as content-first. Other kinds get a one-char marker
// because they're structurally distinct: claims have an owner already,
// questions need a reply, findings are immutable results, synthesize is
// the map-reduce reduce phase. The marker earns its column only when it
// differentiates from the default.
const KIND_GLYPH: Record<BoardItemKind, string> = {
  claim: '◎',
  question: '?',
  todo: '',
  finding: '✓',
  synthesize: 'Σ',
  // Acceptance criterion (Stage 2 declared-roles). Auditor verdicts
  // against these; never dispatched to a worker. Diamond glyph marks
  // them as contract-shape, not work-shape.
  criterion: '◆',
};

const KIND_TONE: Record<BoardItemKind, string> = {
  claim: 'text-iris',
  question: 'text-amber',
  todo: 'text-fog-400',
  finding: 'text-mint',
  synthesize: 'text-mint',
  criterion: 'text-amber',
};

// Parse the retry counter out of a coordinator-stamped note. Format from
// retryOrStale() in coordinator.ts: `[retry:N] reason text`. Surfaced
// inline on the row body (not just the hover tooltip) so a glance at the
// rail tells the user "this item has been retried N times" without
// dragging the cursor over every stale row. POSTMORTEMS F9.
const RETRY_TAG_RE = /^\[retry:(\d+)\]/;
function retryCountFromNote(note: string | null | undefined): number {
  if (!note) return 0;
  const m = RETRY_TAG_RE.exec(note);
  return m ? Math.max(0, parseInt(m[1] ?? '0', 10)) : 0;
}

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
  live,
  ticker,
  embedded = false,
  roleNames,
  pattern,
  deliberationProgress,
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
}) {
  const items = live.items ?? [];

  const agents = useMemo(() => deriveBoardAgents(items, roleNames), [items, roleNames]);
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
        {KIND_GLYPH[item.kind] && (
          <span
            className={clsx(
              'shrink-0 w-3 text-center font-mono text-[11px] leading-none',
              KIND_TONE[item.kind]
            )}
            aria-label={item.kind}
          >
            {KIND_GLYPH[item.kind]}
          </span>
        )}
        <span className="text-[11.5px] text-fog-200 truncate flex-1 min-w-0 font-mono">
          {item.content}
        </span>
        {(() => {
          const retries = retryCountFromNote(item.note);
          if (retries <= 0) return null;
          // Tone steps: 1 retry → amber (warning), 2 retries → rust (max
          // out, retryOrStale gives up after MAX_STALE_RETRIES=2). Keeps
          // the eye drawn to truly-exhausted items while still flagging
          // the once-failed ones.
          const tone = retries >= 2 ? 'text-rust' : 'text-amber';
          return (
            <span
              className={clsx(
                'shrink-0 font-mono text-[9px] tabular-nums',
                tone,
              )}
              title={`retried ${retries}× · ${item.note ?? ''}`}
            >
              ↻{retries}
            </span>
          );
        })()}
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
              'shrink-0 w-4 h-4 grid place-items-center rounded-sm font-mono text-[9.5px] leading-none tabular-nums',
              ACCENT_BG[owner.accent]
            )}
            title={`session ${owner.name} · ${owner.id}`}
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

// TickerChip — surfaces the per-run auto-ticker state as a compact footer row.
// Three shapes:
//   - none     → fog dot, "none" (no ticker has ever run for this swarmRunID)
//   - active   → mint dot (pulse while inFlight), idle counter "idle N/M" when
//                consecutiveIdle > 0, tone escalates to amber past ⅔ of the
//                auto-idle threshold so the user sees "about to stop" coming.
//   - stopped  → amber dot, reason label, inline "restart" button. Clicking
//                calls ticker.start() which hits POST /board/ticker {start}.
// Title attribute carries started/last-tick/last-outcome detail for hover
// inspection; the visible line stays h-6-friendly.
function TickerChip({ ticker }: { ticker: LiveTicker }) {
  const { state } = ticker;

  if (state.state === 'none') {
    return (
      <div
        className="h-6 hairline-t px-3 flex items-center gap-2 shrink-0 bg-ink-900/30"
        title={ticker.error ?? 'no ticker has run for this run yet'}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-fog-700 shrink-0" />
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          ticker
        </span>
        <span className="font-mono text-[10px] text-fog-700 ml-auto">none</span>
      </div>
    );
  }

  if (state.state === 'active') {
    const { consecutiveIdle, idleThreshold, inFlight } = state;
    const idleRatio = idleThreshold > 0 ? consecutiveIdle / idleThreshold : 0;
    const idleTone =
      consecutiveIdle === 0
        ? 'text-mint'
        : idleRatio >= 0.66
          ? 'text-amber'
          : 'text-fog-400';
    return (
      <div
        className="h-6 hairline-t px-3 flex items-center gap-2 shrink-0 bg-ink-900/30"
        title={ticker.error ?? tickerActiveTitle(state)}
      >
        <span
          className={clsx(
            'w-1.5 h-1.5 rounded-full shrink-0 bg-mint',
            inFlight && 'animate-pulse',
          )}
        />
        <span className="font-mono text-micro uppercase tracking-widest2 text-mint">
          ticker
        </span>
        <span className={clsx('font-mono text-[10px] tabular-nums ml-auto', idleTone)}>
          {inFlight
            ? 'tick…'
            : consecutiveIdle > 0
              ? `idle ${consecutiveIdle}/${idleThreshold}`
              : 'running'}
        </span>
      </div>
    );
  }

  const reasonLabel =
    state.stopReason === 'auto-idle'
      ? 'auto-idle'
      : state.stopReason === 'opencode-frozen'
        ? 'opencode-frozen'
        : 'manual';
  return (
    <div
      className="h-6 hairline-t px-3 flex items-center gap-2 shrink-0 bg-ink-900/30"
      title={ticker.error ?? tickerStoppedTitle(state)}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-amber/70 shrink-0" />
      <span className="font-mono text-micro uppercase tracking-widest2 text-amber">
        ticker
      </span>
      <span className="font-mono text-[10px] text-fog-500 truncate">
        stopped · {reasonLabel}
      </span>
      <button
        type="button"
        onClick={() => void ticker.start()}
        disabled={ticker.busy}
        className="ml-auto font-mono text-micro uppercase tracking-widest2 text-iris hover:text-iris/80 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {ticker.busy ? '…' : 'restart'}
      </button>
    </div>
  );
}

function tickerActiveTitle(s: Extract<TickerState, { state: 'active' }>): string {
  const parts = [`started ${formatAgo(s.startedAtMs)} ago`];
  if (s.lastRanAtMs) parts.push(`last tick ${formatAgo(s.lastRanAtMs)} ago`);
  if (s.lastOutcome) parts.push(`last outcome: ${s.lastOutcome.status}`);
  parts.push(`interval ${Math.round(s.intervalMs / 1000)}s`);
  return parts.join(' · ');
}

function tickerStoppedTitle(s: Extract<TickerState, { state: 'stopped' }>): string {
  const parts = [`started ${formatAgo(s.startedAtMs)} ago`];
  if (s.stoppedAtMs) parts.push(`stopped ${formatAgo(s.stoppedAtMs)} ago`);
  parts.push(`reason: ${s.stopReason ?? 'manual'}`);
  if (s.lastOutcome) parts.push(`last outcome: ${s.lastOutcome.status}`);
  return parts.join(' · ');
}

function formatAgo(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}
