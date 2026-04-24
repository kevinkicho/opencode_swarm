'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  MOCK_AGENTS,
  MOCK_BOARD,
} from '@/lib/blackboard-mock';
import type {
  BoardAgent,
  BoardItem,
  BoardItemKind,
  BoardItemStatus,
} from '@/lib/blackboard/types';
import { deriveBoardAgents, roleNamesFromMeta, useLiveBoard } from '@/lib/blackboard/live';
import type { SwarmRunMeta } from '@/lib/swarm-run-types';

// Board view for the blackboard preset. Runs in two modes:
//   - /board-preview                  → mock data (design-time showcase, kept so
//                                       the aesthetic can be validated offline)
//   - /board-preview?swarmRun=<id>    → live data over the SQLite-backed API at
//                                       /api/swarm/run/:id/board (step 4 of
//                                       SWARM_PATTERNS.md §1 roadmap)
//
// Layout: a 5-column pipeline (open → claimed → active → stale → done).
// Kanban-ish, but the column ordering encodes time not priority — "stale" sits
// between active and done because its resolution is replan-then-reclaim, which
// is closer to "undone" than to either active or archived.
//
// When we build a dedicated /run/<id>/board route later this file becomes a
// thin redirect; leaving it at /board-preview keeps the URL stable for the
// smoke scripts that drive it.

const COLUMNS: {
  key: 'open' | 'claimed' | 'active' | 'stale' | 'done';
  label: string;
  matches: BoardItemStatus[];
  tone: string;
  dot: string;
  tint: string;
}[] = [
  { key: 'open',    label: 'open',        matches: ['open'],                   tone: 'text-fog-300',  dot: 'bg-fog-500', tint: 'bg-ink-900/40' },
  { key: 'claimed', label: 'claimed',     matches: ['claimed'],                tone: 'text-iris',     dot: 'bg-iris',    tint: 'bg-iris/[0.04]' },
  { key: 'active',  label: 'in-progress', matches: ['in-progress', 'blocked'], tone: 'text-mint',     dot: 'bg-mint',    tint: 'bg-mint/[0.04]' },
  { key: 'stale',   label: 'stale',       matches: ['stale'],                  tone: 'text-amber',    dot: 'bg-amber',   tint: 'bg-amber/[0.04]' },
  { key: 'done',    label: 'done',        matches: ['done'],                   tone: 'text-fog-500',  dot: 'bg-fog-600', tint: 'bg-ink-900/20' },
];

const KIND_GLYPH: Record<BoardItemKind, string> = {
  claim:      '◎',
  question:   '?',
  todo:       '·',
  finding:    '✓',
  synthesize: 'Σ',
  criterion:  '◆',
};

const KIND_LABEL: Record<BoardItemKind, string> = {
  claim:      'claim',
  question:   'question',
  todo:       'todo',
  finding:    'finding',
  synthesize: 'synthesize',
  criterion:  'criterion',
};

const KIND_TONE: Record<BoardItemKind, string> = {
  claim:      'text-iris',
  question:   'text-amber',
  todo:       'text-fog-400',
  finding:    'text-mint',
  synthesize: 'text-mint',
  criterion:  'text-amber',
};

const ACCENT_BG: Record<BoardAgent['accent'], string> = {
  molten: 'bg-molten/20 text-molten',
  mint:   'bg-mint/20 text-mint',
  iris:   'bg-iris/20 text-iris',
  amber:  'bg-amber/20 text-amber',
  fog:    'bg-fog-700/40 text-fog-300',
};

function fmtAge(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function BoardPreviewInner() {
  const params = useSearchParams();
  const swarmRunID = params.get('swarmRun');
  const live = useLiveBoard(swarmRunID);

  // One-shot meta fetch for role-name labels on hierarchical patterns.
  // deriveBoardAgents falls back to numeric labels when meta is missing,
  // so a failed fetch / mock mode still renders correctly.
  const [meta, setMeta] = useState<SwarmRunMeta | null>(null);
  useEffect(() => {
    if (!swarmRunID) return;
    let cancelled = false;
    fetch(`/api/swarm/run/${swarmRunID}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.meta) setMeta(data.meta as SwarmRunMeta);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [swarmRunID]);

  const isLive = Boolean(swarmRunID);
  // In live mode we wait for the first fetch to land before rendering cards,
  // so a blank run doesn't flash the mock fallback.
  const items: BoardItem[] = isLive ? live.items ?? [] : MOCK_BOARD;
  const roleNames = useMemo(() => roleNamesFromMeta(meta), [meta]);
  const agents: BoardAgent[] = isLive
    ? deriveBoardAgents(items, roleNames)
    : MOCK_AGENTS;

  const agentMap = useMemo(() => {
    const m = new Map<string, BoardAgent>();
    agents.forEach((a) => m.set(a.id, a));
    return m;
  }, [agents]);

  const counts = useMemo(() => {
    const out: Record<BoardItemStatus, number> = {
      open: 0, claimed: 0, 'in-progress': 0, blocked: 0, stale: 0, done: 0,
    };
    items.forEach((it) => { out[it.status] += 1; });
    return out;
  }, [items]);

  const perAgentLoad = useMemo(() => {
    const load = new Map<string, number>();
    items.forEach((it) => {
      if (!it.ownerAgentId) return;
      if (it.status === 'done') return;
      load.set(it.ownerAgentId, (load.get(it.ownerAgentId) ?? 0) + 1);
    });
    return load;
  }, [items]);

  // Mock mode anchors nowRef off the newest item so synthetic ages stay stable
  // across renders. Live mode uses real wall-clock — ages advance on every
  // poll like any other live-view.
  const nowRef = useMemo(() => {
    if (isLive) return Date.now();
    return Math.max(...MOCK_BOARD.map((b) => b.completedAtMs ?? b.createdAtMs)) + 60_000;
  }, [isLive, items]); // items in deps so live mode re-anchors between polls

  return (
    <div className="min-h-screen bg-ink-950 text-fog-100 font-sans">
      <header className="h-12 hairline-b mica flex items-center px-4 gap-3 sticky top-0 z-10">
        <Link
          href="/"
          className="font-mono text-micro uppercase tracking-widest2 text-fog-500 hover:text-fog-200 transition"
        >
          ← run view
        </Link>
        <span className="w-px h-4 bg-ink-600" />
        <span className="font-display italic text-[16px] tracking-tight text-fog-100">
          blackboard
        </span>
        {isLive ? (
          <>
            <span className="font-mono text-micro uppercase tracking-widest2 text-mint/80">
              live
            </span>
            <span className="font-mono text-[10px] text-fog-500 tabular-nums">
              {swarmRunID}
            </span>
            {live.error && (
              <span className="font-mono text-[10px] text-molten tabular-nums" title={live.error}>
                error · {live.error.slice(0, 40)}
              </span>
            )}
            {!live.error && live.items === null && (
              <span className="font-mono text-[10px] text-fog-600">loading…</span>
            )}
          </>
        ) : (
          <>
            <span className="font-mono text-micro uppercase tracking-widest2 text-amber/80">
              preview
            </span>
            <span className="font-mono text-[10px] text-fog-600">
              mock data · append ?swarmRun=&lt;id&gt; for live
            </span>
          </>
        )}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest2 text-fog-600 tabular-nums flex items-center gap-3">
          <span>{items.length} items</span>
          <span className="w-px h-3 bg-ink-700" />
          <span>{agents.length} agents</span>
          <span className="w-px h-3 bg-ink-700" />
          <span className="text-fog-500">{counts.open} open</span>
          <span className="text-iris">{counts.claimed} claimed</span>
          <span className="text-mint">{counts['in-progress'] + counts.blocked} active</span>
          <span className="text-amber">{counts.stale} stale</span>
          <span className="text-fog-500">{counts.done} done</span>
        </span>
      </header>

      <AgentsRow agents={agents} load={perAgentLoad} />

      <div className="grid grid-cols-5 gap-0 hairline-b">
        {COLUMNS.map((col) => (
          <div
            key={col.key}
            className={clsx('px-3 h-7 flex items-center gap-2 hairline-r last:border-r-0', col.tint)}
          >
            <span className={clsx('w-1.5 h-1.5 rounded-full', col.dot)} />
            <span className={clsx('font-mono text-[10px] uppercase tracking-widest2', col.tone)}>
              {col.label}
            </span>
            <span className="font-mono text-[10px] text-fog-600 tabular-nums ml-auto">
              {items.filter((b) => col.matches.includes(b.status)).length}
            </span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-0 min-h-[calc(100vh-12rem)]">
        {COLUMNS.map((col) => {
          const colItems = items
            .filter((b) => col.matches.includes(b.status))
            .sort((a, b) => b.createdAtMs - a.createdAtMs);
          return (
            <div
              key={col.key}
              className={clsx(
                'hairline-r last:border-r-0 flex flex-col gap-0 py-1 overflow-y-auto',
                col.tint
              )}
            >
              {colItems.length === 0 && (
                <div className="px-3 h-8 flex items-center font-mono text-[10px] text-fog-700">
                  (none)
                </div>
              )}
              {colItems.map((item) => (
                <BoardCard
                  key={item.id}
                  item={item}
                  owner={item.ownerAgentId ? agentMap.get(item.ownerAgentId) ?? null : null}
                  nowRef={nowRef}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function BoardPreviewPage() {
  return (
    <Suspense fallback={null}>
      <BoardPreviewInner />
    </Suspense>
  );
}

function AgentsRow({
  agents,
  load,
}: {
  agents: BoardAgent[];
  load: Map<string, number>;
}) {
  return (
    <div className="hairline-b flex items-center px-4 h-8 gap-2 bg-ink-900/60">
      <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600 shrink-0">
        roster
      </span>
      <span className="w-px h-3 bg-ink-700 shrink-0" />
      <div className="flex items-center gap-1.5 flex-wrap">
        {agents.length === 0 && (
          <span className="font-mono text-[10px] text-fog-700">
            (no agents yet — claims will populate this)
          </span>
        )}
        {agents.map((a) => {
          const n = load.get(a.id) ?? 0;
          return (
            <span
              key={a.id}
              className={clsx(
                'h-5 pl-1.5 pr-1 rounded hairline flex items-center gap-1.5 font-mono text-[10px]',
                ACCENT_BG[a.accent]
              )}
              title={`${a.name} — ${n} active item${n === 1 ? '' : 's'}`}
            >
              <span className="font-display italic text-[11px] leading-none">
                {a.glyph}
              </span>
              <span className="uppercase tracking-widest2 text-[9px]">{a.name}</span>
              <span className="px-1 h-3.5 flex items-center rounded bg-ink-900/60 text-fog-400 tabular-nums text-[9px]">
                {n}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function BoardCard({
  item,
  owner,
  nowRef,
}: {
  item: BoardItem;
  owner: BoardAgent | null;
  nowRef: number;
}) {
  const isBlocked = item.status === 'blocked';
  const isStale = item.status === 'stale';
  return (
    <div className="mx-1 mb-1 rounded hairline bg-ink-900/70 px-2 py-1.5 flex flex-col gap-1">
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className={clsx(
            'font-mono text-[11px] leading-none w-3 text-center shrink-0',
            KIND_TONE[item.kind]
          )}
          title={KIND_LABEL[item.kind]}
        >
          {KIND_GLYPH[item.kind]}
        </span>
        <span className="font-mono text-[10px] text-fog-600 tabular-nums shrink-0">
          {item.id}
        </span>
        {isBlocked && (
          <span className="font-mono text-[9px] uppercase tracking-widest2 text-amber shrink-0">
            blocked
          </span>
        )}
        {isStale && item.staleSinceSha && (
          <span
            className="font-mono text-[9px] text-amber tabular-nums shrink-0"
            title={`files moved: current head ${item.staleSinceSha}`}
          >
            ↯ {item.staleSinceSha}
          </span>
        )}
        <span className="ml-auto font-mono text-[9px] text-fog-700 tabular-nums shrink-0">
          {fmtAge(item.completedAtMs ?? item.createdAtMs, nowRef)}
        </span>
      </div>

      <div className="font-mono text-[11px] text-fog-100 leading-snug break-words">
        {item.content}
      </div>

      {(owner || (item.fileHashes && item.fileHashes.length > 0)) && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {owner ? (
            <span
              className={clsx(
                'h-4 px-1.5 rounded font-mono text-[10px] tabular-nums flex items-center',
                ACCENT_BG[owner.accent]
              )}
              title={`session ${owner.name} · ${owner.id}`}
            >
              {owner.name}
            </span>
          ) : (
            <span className="h-4 px-1.5 rounded font-mono text-[9px] uppercase tracking-widest2 text-fog-600 bg-ink-800">
              unclaimed
            </span>
          )}
          {item.fileHashes?.map((f) => (
            <span
              key={f.path}
              className="h-4 px-1 rounded hairline font-mono text-[9px] text-fog-500 tabular-nums flex items-center gap-1"
              title={`${f.path} @ ${f.sha}`}
            >
              <span className="text-fog-600 truncate max-w-[180px]">{f.path}</span>
              <span className="text-fog-700">@</span>
              <span className="text-fog-300">{f.sha}</span>
            </span>
          ))}
        </div>
      )}

      {item.note && (
        <div className="font-mono text-[9.5px] text-fog-600 italic leading-snug">
          {item.note}
        </div>
      )}
    </div>
  );
}
