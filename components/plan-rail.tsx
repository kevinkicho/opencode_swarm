'use client';

import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import type { Agent, TodoItem, TodoStatus } from '@/lib/swarm-types';
import { Tooltip } from './ui/tooltip';

// Status is communicated via (1) the accent-stripe opacity — full tone for
// in-progress, faded otherwise — (2) the content text color for terminal
// states, and (3) the explicit label revealed when the row is expanded.
// We dropped the leading ○◐●⨯⤺ glyph on 2026-04-22 — it was duplicating
// information the accent stripe already carried and narrowing the room
// for the content itself.

const statusTone: Record<TodoStatus, string> = {
  pending: 'text-fog-600',
  in_progress: 'text-molten',
  completed: 'text-mint',
  failed: 'text-rust',
  abandoned: 'text-fog-700',
};

const statusLabel: Record<TodoStatus, string> = {
  pending: 'pending',
  in_progress: 'in progress',
  completed: 'completed',
  failed: 'failed',
  abandoned: 'abandoned',
};

const contentTone: Record<TodoStatus, string> = {
  pending: 'text-fog-200',
  in_progress: 'text-fog-100',
  completed: 'text-fog-500',
  failed: 'text-rust/80',
  abandoned: 'text-fog-700',
};

const accentStripe: Record<Agent['accent'], string> = {
  molten: 'bg-molten',
  mint: 'bg-mint',
  iris: 'bg-iris',
  amber: 'bg-amber',
  fog: 'bg-fog-500',
};

const accentBadge: Record<Agent['accent'], string> = {
  molten: 'bg-molten/15 text-molten',
  mint: 'bg-mint/15 text-mint',
  iris: 'bg-iris/15 text-iris',
  amber: 'bg-amber/15 text-amber',
  fog: 'bg-fog-500/15 text-fog-400',
};

export function PlanRail({
  items,
  agents,
  onJump,
  focusTodoId = null,
  embedded = false,
}: {
  items: TodoItem[];
  agents: Agent[];
  onJump: (messageId: string) => void;
  // When a caller outside this component (e.g. a task card in the timeline)
  // wants the plan to reveal a specific item, it sets this prop. The row
  // scrolls into view and flashes briefly. Clear by setting back to null.
  focusTodoId?: string | null;
  embedded?: boolean;
}) {
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const completed = items.filter((i) => i.status === 'completed').length;

  const body = (
    <ul className="flex-1 overflow-y-auto py-1">
      {items.map((item) => (
        <PlanRow
          key={item.id}
          item={item}
          owner={item.ownerAgentId ? agentById.get(item.ownerAgentId) : undefined}
          onJump={onJump}
          focused={focusTodoId === item.id}
        />
      ))}
    </ul>
  );

  if (embedded) return body;

  return (
    <section className="relative flex flex-col min-w-0 shrink-0 max-h-[320px] hairline-b bg-ink-850">
      <div className="h-10 hairline-b px-4 flex items-center gap-2 bg-ink-850/80 backdrop-blur">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          plan
        </span>
        <Tooltip
          content={`${completed} of ${items.length} items completed`}
          side="bottom"
        >
          <span className="font-mono text-micro text-fog-700 cursor-default tabular-nums">
            {completed}/{items.length}
          </span>
        </Tooltip>
      </div>

      {body}
    </section>
  );
}

function PlanRow({
  item,
  owner,
  onJump,
  focused = false,
}: {
  item: TodoItem;
  owner?: Agent;
  onJump: (messageId: string) => void;
  focused?: boolean;
}) {
  const tone = statusTone[item.status];
  const contentColor = contentTone[item.status];
  const hasDelegation = !!item.taskMessageId;
  const rowRef = useRef<HTMLLIElement | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (focused && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focused]);

  return (
    <li
      ref={rowRef}
      className={clsx(
        'relative transition-colors',
        focused && 'bg-molten/15'
      )}
    >
      {/* Clickable row — toggles inline detail. Any action that needs to
          exit the plan rail (jump to delegation) lives inside the
          expanded section as an explicit button, not as an implicit
          click behavior. */}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="w-full text-left pl-3 pr-2.5 h-6 flex items-center gap-2 relative transition hover:bg-ink-800/60 cursor-pointer"
      >
        {owner && (
          <span
            className={clsx(
              'absolute left-0 top-0 bottom-0 w-[2px]',
              accentStripe[owner.accent],
              item.status !== 'in_progress' && 'opacity-40'
            )}
          />
        )}

        <span
          className={clsx(
            'text-[12px] truncate flex-1 min-w-0',
            contentColor,
            item.status === 'completed' && 'line-through decoration-fog-700'
          )}
        >
          {item.content}
        </span>

        {owner ? (
          <Tooltip content={owner.name} side="top">
            <span
              className={clsx(
                'shrink-0 w-4 h-4 grid place-items-center rounded-sm font-mono text-[9.5px] leading-none cursor-default',
                accentBadge[owner.accent]
              )}
            >
              {owner.glyph}
            </span>
          </Tooltip>
        ) : (
          <Tooltip content="not yet delegated" side="top">
            <span className="shrink-0 w-4 h-4 grid place-items-center rounded-sm font-mono text-[9.5px] leading-none text-fog-700 bg-ink-800 cursor-default">
              —
            </span>
          </Tooltip>
        )}
      </button>

      {expanded && (
        <div className="pl-3 pr-2.5 pb-2 pt-0.5 bg-ink-850/60 hairline-b space-y-1.5">
          {/* Full content — no truncate. */}
          <div className="font-mono text-[11px] text-fog-200 leading-snug whitespace-pre-wrap break-words">
            {item.content}
          </div>

          {/* Metadata row — status + owner + id. */}
          <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 flex items-center gap-2 flex-wrap">
            <span className={clsx('normal-case', tone)}>{statusLabel[item.status]}</span>
            {owner && (
              <>
                <span className="text-fog-700">·</span>
                <span className="text-fog-400 normal-case">{owner.name}</span>
              </>
            )}
            <span className="text-fog-700">·</span>
            <span className="text-fog-700">{item.id}</span>
          </div>

          {/* Worker-left annotation (blackboard coordinator writes these on
              stale / skipped / blocked transitions). */}
          {item.note && (
            <div className="font-mono text-[10.5px] text-fog-500 leading-snug">
              <span className="uppercase tracking-widest2 text-fog-700">note </span>
              {item.note}
            </div>
          )}

          {/* Jump to delegation — explicit action, replaces the old
              implicit click-to-jump behavior. Disabled when the todo
              isn't yet bound to a task-tool call. */}
          <div className="flex items-center gap-1 pt-0.5">
            <button
              type="button"
              disabled={!hasDelegation}
              onClick={(e) => {
                e.stopPropagation();
                if (item.taskMessageId) onJump(item.taskMessageId);
              }}
              className={clsx(
                'h-5 px-2 rounded-sm font-mono text-micro uppercase tracking-widest2 transition-colors',
                hasDelegation
                  ? 'bg-ink-700 hover:bg-molten/15 text-fog-300 hover:text-molten cursor-pointer'
                  : 'bg-ink-800 text-fog-700 cursor-default'
              )}
            >
              {hasDelegation ? '→ jump to delegation' : 'not yet delegated'}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
