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

// Plan content frequently arrives with a leading bracket-tag from the
// blackboard planner (e.g. "[criterion] foo", "[files:src/x.ts] bar",
// "[synthesize] baz"). Earlier rendering shoved the bracket prefix
// directly into the row — it ate ~40% of the visible chars and added
// no signal beyond what a single-letter chip carries. We parse the
// tag here and render it as a 14px monogram chip, leaving the rest of
// the row for the actual content.
type KindChip = {
  letter: string;
  tone: string;
  tag: string;
  detail: string | null;
};

function parseKindPrefix(content: string): { chip: KindChip | null; rest: string } {
  const m = content.match(/^\[([a-z]+)(?::([^\]]+))?\]\s*(.*)$/i);
  if (!m) return { chip: null, rest: content };
  const [, rawKind, rawDetail, rest] = m;
  const detail = rawDetail || null;
  const kind = rawKind.toLowerCase();
  switch (kind) {
    case 'criterion':
      return {
        chip: { letter: 'C', tag: 'criterion', detail: 'judged by the auditor on each cadence', tone: 'bg-iris/15 text-iris' },
        rest,
      };
    case 'files':
      return {
        chip: { letter: 'F', tag: 'files', detail: detail ?? 'edits scoped to specific files', tone: 'bg-molten/15 text-molten' },
        rest,
      };
    case 'synthesize':
    case 'synth':
      return {
        chip: { letter: 'S', tag: 'synthesize', detail: 'combine findings into a synthesis turn', tone: 'bg-mint/15 text-mint' },
        rest,
      };
    case 'finding':
      return {
        chip: { letter: 'P', tag: 'finding', detail: 'finding posted to the board', tone: 'bg-amber/15 text-amber' },
        rest,
      };
    default:
      return {
        chip: { letter: kind.charAt(0).toUpperCase(), tag: kind, detail, tone: 'bg-fog-500/15 text-fog-400' },
        rest,
      };
  }
}

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
  const abandoned = items.filter((i) => i.status === 'abandoned').length;
  // Default to "active" — pending + in-progress + failed. Done /
  // abandoned items live on the board (or behind the toggle below).
  // Differentiates plan from board: plan answers "what's the agent
  // working on right now?", board answers "what's the full lifecycle
  // including stale + done?".
  const [showAll, setShowAll] = useState(false);
  const visible = showAll
    ? items
    : items.filter(
        (i) => i.status === 'pending' || i.status === 'in_progress' || i.status === 'failed',
      );
  const hiddenCount = items.length - visible.length;

  const body = (
    <ul className="flex-1 overflow-y-auto overflow-x-hidden py-1 list-none">
      {visible.length === 0 ? (
        <li className="px-3 py-3 font-mono text-micro uppercase tracking-widest2 text-fog-700">
          {items.length === 0 ? 'no plan items yet' : 'all items complete'}
        </li>
      ) : (
        visible.map((item) => (
          <PlanRow
            key={item.id}
            item={item}
            owner={item.ownerAgentId ? agentById.get(item.ownerAgentId) : undefined}
            onJump={onJump}
            focused={focusTodoId === item.id}
          />
        ))
      )}
      {hiddenCount > 0 && (
        // Inline toggle at the bottom of the active-only list — pulling
        // done/abandoned items into view is one click, not a tab swap.
        <li className="px-3 pt-1.5 pb-2">
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="font-mono text-micro uppercase tracking-widest2 text-fog-600 hover:text-fog-200 transition-colors cursor-pointer"
          >
            + {hiddenCount} {hiddenCount === 1 ? 'item' : 'items'} done · show
          </button>
        </li>
      )}
      {showAll && hiddenCount === 0 && abandoned > 0 && (
        <li className="px-3 pt-1.5 pb-2">
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className="font-mono text-micro uppercase tracking-widest2 text-fog-600 hover:text-fog-200 transition-colors cursor-pointer"
          >
            active only
          </button>
        </li>
      )}
      {showAll && hiddenCount === 0 && abandoned === 0 && completed > 0 && (
        <li className="px-3 pt-1.5 pb-2">
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className="font-mono text-micro uppercase tracking-widest2 text-fog-600 hover:text-fog-200 transition-colors cursor-pointer"
          >
            active only
          </button>
        </li>
      )}
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

  // Strip + classify the bracket prefix into a leading chip so the row
  // body shows the actual semantic content. Detail (e.g. file path)
  // lives on the chip's tooltip.
  const { chip, rest } = parseKindPrefix(item.content);

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
        className="w-full text-left pl-3 pr-2.5 py-1.5 flex items-start gap-2 relative transition hover:bg-ink-800/60 cursor-pointer"
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

        {/* Kind monogram — 14px chip with tooltip carrying the original
            bracket detail. Always reserve the slot (use a fog-toned dot
            placeholder) so content baselines line up across rows. */}
        {chip ? (
          <Tooltip
            content={
              <div className="space-y-0.5">
                <div className="font-mono text-[11px] text-fog-200">{chip.tag}</div>
                {chip.detail && (
                  <div className="font-mono text-[10px] text-fog-500 max-w-64 break-all">
                    {chip.detail}
                  </div>
                )}
              </div>
            }
            side="right"
          >
            <span
              className={clsx(
                'shrink-0 mt-[1px] w-3.5 h-3.5 grid place-items-center rounded-sm font-mono text-[9px] leading-none cursor-default',
                chip.tone,
              )}
            >
              {chip.letter}
            </span>
          </Tooltip>
        ) : (
          <span className="shrink-0 mt-[6px] w-1 h-1 rounded-full bg-fog-700" />
        )}

        <span
          className={clsx(
            'text-[12px] flex-1 min-w-0 leading-snug break-words',
            // Two-line clamp so the row carries genuinely scannable
            // content. Items rarely need more than 2 lines for a
            // glance; the full string is one click away in expand.
            'line-clamp-2',
            contentColor,
            item.status === 'completed' && 'line-through decoration-fog-700'
          )}
        >
          {rest || item.content}
        </span>

        {owner ? (
          <Tooltip content={owner.name} side="top">
            <span
              className={clsx(
                'shrink-0 mt-[1px] w-4 h-4 grid place-items-center rounded-sm font-mono text-[9.5px] leading-none cursor-default',
                accentBadge[owner.accent]
              )}
            >
              {owner.glyph}
            </span>
          </Tooltip>
        ) : (
          <Tooltip content="not yet delegated" side="top">
            <span className="shrink-0 mt-[1px] w-4 h-4 grid place-items-center rounded-sm font-mono text-[9.5px] leading-none text-fog-700 bg-ink-800 cursor-default">
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
