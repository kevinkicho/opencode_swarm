'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useMemo } from 'react';
import {
  MOCK_AGENTS,
  MOCK_BOARD,
  type BoardAgent,
  type BoardItem,
  type BoardItemKind,
  type BoardItemStatus,
} from '@/lib/blackboard-mock';

// Standalone prototype for the blackboard preset's board view. See
// SWARM_PATTERNS.md §1 ("first real implementation target"). Zero backend
// wiring: the page reads from MOCK_BOARD so the layout can settle before we
// commit to SQLite vs per-run JSON for the store (§7.6 open). Live board data
// would arrive from /api/swarm/run/<id>/board once the coordinator ships.
//
// Layout choice: a 5-column pipeline (open → claimed → active → stale →
// done). A Kanban-ish read but the column ordering encodes time, not
// priority — "stale" sits between active and done because its resolution is
// replan-then-reclaim, which is closer to "undone" than to either active or
// archived.
//
// Not a real route in the sense of "users discover this" — it's linked from
// this file and reachable at /board-preview. Delete when the real view lands.

const COLUMNS: {
  key: 'open' | 'claimed' | 'active' | 'stale' | 'done';
  label: string;
  matches: BoardItemStatus[];
  tone: string;       // accent text for header
  dot: string;        // dot color for header marker
  tint: string;       // column bg wash
}[] = [
  { key: 'open',    label: 'open',        matches: ['open'],                   tone: 'text-fog-300',  dot: 'bg-fog-500', tint: 'bg-ink-900/40' },
  { key: 'claimed', label: 'claimed',     matches: ['claimed'],                tone: 'text-iris',     dot: 'bg-iris',    tint: 'bg-iris/[0.04]' },
  { key: 'active',  label: 'in-progress', matches: ['in-progress', 'blocked'], tone: 'text-mint',     dot: 'bg-mint',    tint: 'bg-mint/[0.04]' },
  { key: 'stale',   label: 'stale',       matches: ['stale'],                  tone: 'text-amber',    dot: 'bg-amber',   tint: 'bg-amber/[0.04]' },
  { key: 'done',    label: 'done',        matches: ['done'],                   tone: 'text-fog-500',  dot: 'bg-fog-600', tint: 'bg-ink-900/20' },
];

const KIND_GLYPH: Record<BoardItemKind, string> = {
  claim:    '◎',
  question: '?',
  todo:     '·',
  finding:  '✓',
};

const KIND_LABEL: Record<BoardItemKind, string> = {
  claim:    'claim',
  question: 'question',
  todo:     'todo',
  finding:  'finding',
};

const KIND_TONE: Record<BoardItemKind, string> = {
  claim:    'text-iris',
  question: 'text-amber',
  todo:     'text-fog-400',
  finding:  'text-mint',
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

export default function BoardPreviewPage() {
  const agentMap = useMemo(() => {
    const m = new Map<string, BoardAgent>();
    MOCK_AGENTS.forEach((a) => m.set(a.id, a));
    return m;
  }, []);

  const counts = useMemo(() => {
    const out: Record<BoardItemStatus, number> = {
      open: 0, claimed: 0, 'in-progress': 0, blocked: 0, stale: 0, done: 0,
    };
    MOCK_BOARD.forEach((it) => { out[it.status] += 1; });
    return out;
  }, []);

  const perAgentLoad = useMemo(() => {
    const load = new Map<string, number>();
    MOCK_BOARD.forEach((it) => {
      if (!it.ownerAgentId) return;
      if (it.status === 'done') return;
      load.set(it.ownerAgentId, (load.get(it.ownerAgentId) ?? 0) + 1);
    });
    return load;
  }, []);

  // One reference "now" so every age column renders the same snapshot. Using
  // the mock's implicit anchor (the newest createdAtMs from MOCK_BOARD).
  const nowRef = useMemo(
    () => Math.max(...MOCK_BOARD.map((b) => b.completedAtMs ?? b.createdAtMs)) + 60_000,
    []
  );

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
        <span className="font-mono text-micro uppercase tracking-widest2 text-amber/80">
          preview
        </span>
        <span className="font-mono text-[10px] text-fog-600 ml-2">
          mock data · no backend yet
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-widest2 text-fog-600 tabular-nums flex items-center gap-3">
          <span>{MOCK_BOARD.length} items</span>
          <span className="w-px h-3 bg-ink-700" />
          <span>{MOCK_AGENTS.length} agents</span>
          <span className="w-px h-3 bg-ink-700" />
          <span className="text-fog-500">{counts.open} open</span>
          <span className="text-iris">{counts.claimed} claimed</span>
          <span className="text-mint">{counts['in-progress'] + counts.blocked} active</span>
          <span className="text-amber">{counts.stale} stale</span>
          <span className="text-fog-500">{counts.done} done</span>
        </span>
      </header>

      <AgentsRow agents={MOCK_AGENTS} load={perAgentLoad} />

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
              {MOCK_BOARD.filter((b) => col.matches.includes(b.status)).length}
            </span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-5 gap-0 min-h-[calc(100vh-12rem)]">
        {COLUMNS.map((col) => {
          const items = MOCK_BOARD
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
              {items.length === 0 && (
                <div className="px-3 h-8 flex items-center font-mono text-[10px] text-fog-700">
                  (none)
                </div>
              )}
              {items.map((item) => (
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
                'h-4 px-1.5 rounded font-mono text-[9px] uppercase tracking-widest2 flex items-center gap-1',
                ACCENT_BG[owner.accent]
              )}
            >
              <span className="font-display italic text-[10px] leading-none normal-case">
                {owner.glyph}
              </span>
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
