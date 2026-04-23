'use client';

// Big-view blackboard accordion for the main area — sits alongside
// timeline/cards in the view toggle. Six collapsible sections, one per
// status, stacked vertically so a dozen in-progress items doesn't
// compete for space with 200 done items. Active work (in-progress,
// claimed, open) expanded by default; outcomes (stale, blocked, done)
// start collapsed so the eye lands on what's live.

import clsx from 'clsx';
import { useMemo, useState } from 'react';
import type { LiveBoard, LiveTicker } from '@/lib/blackboard/live';
import { deriveBoardAgents } from '@/lib/blackboard/live';
import type {
  BoardAgent,
  BoardItem,
  BoardItemStatus,
} from '@/lib/blackboard/types';
import { Tooltip } from './ui/tooltip';

interface SectionSpec {
  key: BoardItemStatus;
  label: string;
  tone: string;
  dot: string;
  tint: string;
  // Whether the section starts expanded. Active work is worth seeing;
  // outcomes are worth counting — so done/stale/blocked start collapsed.
  defaultExpanded: boolean;
}

const SECTIONS: SectionSpec[] = [
  { key: 'in-progress', label: 'in-progress', tone: 'text-mint',    dot: 'bg-mint',      tint: 'bg-mint/[0.04]',   defaultExpanded: true  },
  { key: 'claimed',     label: 'claimed',     tone: 'text-iris',    dot: 'bg-iris',      tint: 'bg-iris/[0.04]',   defaultExpanded: true  },
  { key: 'open',        label: 'open',        tone: 'text-fog-300', dot: 'bg-fog-500',   tint: 'bg-transparent',   defaultExpanded: true  },
  { key: 'stale',       label: 'stale',       tone: 'text-amber',   dot: 'bg-amber',     tint: 'bg-amber/[0.04]',  defaultExpanded: false },
  { key: 'blocked',     label: 'blocked',     tone: 'text-amber',   dot: 'bg-amber',     tint: 'bg-amber/[0.04]',  defaultExpanded: false },
  { key: 'done',        label: 'done',        tone: 'text-fog-500', dot: 'bg-fog-600',   tint: 'bg-transparent',   defaultExpanded: false },
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

  // Expanded state per section. Keyed by status so toggling persists
  // across re-renders (items list mutates frequently via SSE).
  const [expanded, setExpanded] = useState<Record<BoardItemStatus, boolean>>(() => {
    const out = {} as Record<BoardItemStatus, boolean>;
    for (const s of SECTIONS) out[s.key] = s.defaultExpanded;
    return out;
  });

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
      <div className="flex-1 min-h-0 overflow-y-auto">
        {SECTIONS.map((sec) => {
          const sectionItems = items
            .filter((b) => b.status === sec.key)
            .sort((a, b) => b.createdAtMs - a.createdAtMs);
          const isExpanded = expanded[sec.key];
          return (
            <div key={sec.key} className={clsx('hairline-b', sec.tint)}>
              <button
                type="button"
                onClick={() =>
                  setExpanded((prev) => ({ ...prev, [sec.key]: !prev[sec.key] }))
                }
                className="w-full h-8 px-3 flex items-center gap-2 hover:bg-ink-800/40 transition cursor-pointer"
              >
                <span
                  className={clsx(
                    'text-[10px] text-fog-600 leading-none transition-transform',
                    isExpanded && 'rotate-90',
                  )}
                  aria-hidden
                >
                  ▸
                </span>
                <span className={clsx('w-1.5 h-1.5 rounded-full', sec.dot)} />
                <span
                  className={clsx(
                    'font-mono text-[10.5px] uppercase tracking-widest2',
                    sec.tone,
                  )}
                >
                  {sec.label}
                </span>
                <span className="font-mono text-[10px] text-fog-600 tabular-nums">
                  {sectionItems.length}
                </span>
              </button>
              {isExpanded && (
                <ul className="list-none pb-1">
                  {sectionItems.length === 0 ? (
                    <li className="px-7 h-6 flex items-center font-mono text-[10px] text-fog-700">
                      (none)
                    </li>
                  ) : (
                    sectionItems.map((item) => (
                      <BoardCard
                        key={item.id}
                        item={item}
                        owner={item.ownerAgentId ? agentMap.get(item.ownerAgentId) ?? null : null}
                        now={now}
                      />
                    ))
                  )}
                </ul>
              )}
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

  // Strip `[retry:N] ` / `[final ...] ` prefix out of the note so the
  // card shows the reason prominently while keeping the retry count
  // visible as its own small pill.
  let retryTag: string | null = null;
  let noteBody = item.note ?? '';
  const m = /^\[(retry:\d+|final[^\]]*)\]\s*(.*)$/.exec(noteBody);
  if (m) {
    retryTag = m[1];
    noteBody = m[2];
  }

  return (
    <li className="pl-7 pr-3 py-1 hairline-b last:border-b-0">
      <div className="font-mono text-[11.5px] text-fog-100 leading-snug break-words">
        {item.content}
      </div>
      <div className="flex items-center gap-2 mt-0.5 font-mono text-[9.5px] uppercase tracking-widest2 text-fog-700">
        {owner && (
          <Tooltip content={owner.name} side="top">
            <span
              className={clsx(
                'px-1 h-4 inline-flex items-center rounded-sm border cursor-default',
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
        {retryTag && (
          <span className="px-1 h-4 inline-flex items-center rounded-sm border border-amber/30 bg-amber/10 text-amber normal-case">
            {retryTag}
          </span>
        )}
        {item.staleSinceSha && (
          <span className="text-amber tabular-nums" title="drift detected">
            ↯{item.staleSinceSha.slice(0, 4)}
          </span>
        )}
      </div>
      {noteBody && (
        <div className="font-mono text-[10px] text-fog-500 italic mt-0.5 pl-0 leading-snug">
          {noteBody}
        </div>
      )}
    </li>
  );
}
