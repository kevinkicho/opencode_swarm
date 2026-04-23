'use client';

// Big-view blackboard kanban for the main area — sits alongside
// timeline/cards in the view toggle. The left-rail "board" tab gives a
// compact read-only glance; this view scales to the main pane so a
// multi-hour run with dozens of items stays scannable.
//
// Six columns keyed to lifecycle time: open → claimed → in-progress →
// done, with stale + blocked as dead-end outcomes. The data source is
// the same LiveBoard that the left rail consumes, passed in from page
// level (subscription survives tab switches).

import clsx from 'clsx';
import { useMemo } from 'react';
import type { LiveBoard, LiveTicker } from '@/lib/blackboard/live';
import { deriveBoardAgents } from '@/lib/blackboard/live';
import type {
  BoardAgent,
  BoardItem,
  BoardItemStatus,
} from '@/lib/blackboard/types';
import { Tooltip } from './ui/tooltip';

interface ColSpec {
  key: string;
  label: string;
  matches: BoardItemStatus[];
  tone: string;
  dot: string;
  tint: string;
}

const COLUMNS: ColSpec[] = [
  {
    key: 'in-progress',
    label: 'in-progress',
    matches: ['in-progress'],
    tone: 'text-mint',
    dot: 'bg-mint',
    tint: 'bg-mint/[0.03]',
  },
  {
    key: 'claimed',
    label: 'claimed',
    matches: ['claimed'],
    tone: 'text-iris',
    dot: 'bg-iris',
    tint: 'bg-iris/[0.03]',
  },
  {
    key: 'open',
    label: 'open',
    matches: ['open'],
    tone: 'text-fog-300',
    dot: 'bg-fog-500',
    tint: 'bg-transparent',
  },
  {
    key: 'stale',
    label: 'stale',
    matches: ['stale'],
    tone: 'text-amber',
    dot: 'bg-amber',
    tint: 'bg-amber/[0.04]',
  },
  {
    key: 'blocked',
    label: 'blocked',
    matches: ['blocked'],
    tone: 'text-amber',
    dot: 'bg-amber',
    tint: 'bg-amber/[0.04]',
  },
  {
    key: 'done',
    label: 'done',
    matches: ['done'],
    tone: 'text-fog-500',
    dot: 'bg-fog-600',
    tint: 'bg-transparent',
  },
];

const accentClass: Record<BoardAgent['accent'], string> = {
  molten: 'bg-molten/15 text-molten border-molten/30',
  mint: 'bg-mint/15 text-mint border-mint/30',
  iris: 'bg-iris/15 text-iris border-iris/30',
  amber: 'bg-amber/15 text-amber border-amber/30',
  fog: 'bg-fog-500/15 text-fog-300 border-fog-600/40',
};

function fmtAge(ms: number, now: number): string {
  const d = now - ms;
  if (d < 60_000) return `${Math.max(1, Math.round(d / 1000))}s`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`;
  return `${Math.round(d / 86_400_000)}d`;
}

export function BoardFullView({
  live,
  ticker,
}: {
  live: LiveBoard;
  ticker: LiveTicker;
}) {
  const items = live.items ?? [];
  const loading = live.items === null && !live.error;
  const agents = useMemo(() => deriveBoardAgents(items), [items]);
  const agentMap = useMemo(() => {
    const m = new Map<string, BoardAgent>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);
  const now = Date.now();

  if (loading) {
    return (
      <section className="flex-1 min-w-0 min-h-0 grid place-items-center bg-ink-900">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-700">
          loading board…
        </span>
      </section>
    );
  }
  if (live.error) {
    return (
      <section className="flex-1 min-w-0 min-h-0 grid place-items-center bg-ink-900">
        <div className="font-mono text-[11px] text-rust">{live.error}</div>
      </section>
    );
  }
  if (items.length === 0) {
    return (
      <section className="flex-1 min-w-0 min-h-0 grid place-items-center bg-ink-900">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-700">
          board empty — waiting for planner sweep
        </div>
      </section>
    );
  }

  return (
    <section className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col bg-ink-900">
      <div
        className="hairline-b"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(0, 1fr))`,
        }}
      >
        {COLUMNS.map((col) => {
          const count = items.filter((b) => col.matches.includes(b.status)).length;
          return (
            <div
              key={col.key}
              className={clsx(
                'h-8 px-3 flex items-center gap-2 hairline-r last:border-r-0',
                col.tint,
              )}
            >
              <span
                className={clsx(
                  'font-mono text-[10.5px] uppercase tracking-widest2',
                  col.tone,
                )}
              >
                {col.label}
              </span>
              <span className="font-mono text-[10px] text-fog-600 tabular-nums ml-auto">
                {count}
              </span>
            </div>
          );
        })}
      </div>

      <div
        className="flex-1 min-h-0 overflow-hidden"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(0, 1fr))`,
        }}
      >
        {COLUMNS.map((col) => {
          const colItems = items
            .filter((b) => col.matches.includes(b.status))
            .sort((a, b) => b.createdAtMs - a.createdAtMs);
          return (
            <div
              key={col.key}
              className={clsx(
                'hairline-r last:border-r-0 flex flex-col py-1 overflow-y-auto',
                col.tint,
              )}
            >
              {colItems.length === 0 && (
                <div className="px-3 h-7 flex items-center font-mono text-[10px] text-fog-700">
                  (none)
                </div>
              )}
              {colItems.map((item) => (
                <BoardCard
                  key={item.id}
                  item={item}
                  owner={item.ownerAgentId ? agentMap.get(item.ownerAgentId) ?? null : null}
                  now={now}
                />
              ))}
            </div>
          );
        })}
      </div>

      {/* Ticker footer — mirrors the one in the rail so a big-view user
          still sees coordinator state without toggling back. */}
      <div className="h-6 hairline-t px-3 flex items-center gap-2 bg-ink-850/70 shrink-0 font-mono text-micro uppercase tracking-widest2">
        <span className="text-fog-700">ticker</span>
        <span className="text-fog-400">
          {ticker.state.state === 'active'
            ? `running · idle ${ticker.state.consecutiveIdle ?? 0}/${ticker.state.idleThreshold ?? '?'}`
            : ticker.state.state === 'stopped'
              ? `stopped · ${ticker.state.stopReason ?? 'manual'}`
              : 'inactive'}
        </span>
        {ticker.state.state === 'active' && ticker.state.inFlight && (
          <span className="text-molten">· tick in flight</span>
        )}
      </div>
    </section>
  );
}

function BoardCard({
  item,
  owner,
  now,
}: {
  item: BoardItem;
  owner: BoardAgent | null;
  now: number;
}) {
  const age = fmtAge(item.createdAtMs, now);
  const dur =
    item.completedAtMs && item.status === 'done'
      ? `${Math.round((item.completedAtMs - item.createdAtMs) / 1000)}s`
      : null;

  return (
    <div className="px-3 py-1.5 hairline-b last:border-b-0">
      <div className="flex items-start gap-2">
        <span className="font-mono text-[11.5px] text-fog-100 leading-snug flex-1 min-w-0 break-words">
          {item.content}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-1 font-mono text-[9.5px] uppercase tracking-widest2 text-fog-700">
        {owner && (
          <Tooltip content={`session ${owner.name} · ${owner.id}`} side="top">
            <span
              className={clsx(
                'px-1 h-4 inline-flex items-center rounded-sm border cursor-default tabular-nums',
                accentClass[owner.accent],
              )}
            >
              {owner.name}
            </span>
          </Tooltip>
        )}
        <span className="tabular-nums">{item.id}</span>
        <span className="tabular-nums">{age}</span>
        {dur && <span className="text-fog-500 tabular-nums">·{dur}</span>}
        {item.staleSinceSha && (
          <span className="text-amber tabular-nums" title="drift detected">
            ↯{item.staleSinceSha.slice(0, 4)}
          </span>
        )}
      </div>
    </div>
  );
}
