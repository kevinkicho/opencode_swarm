'use client';

import clsx from 'clsx';
import type { Agent, TodoItem, TodoStatus } from '@/lib/swarm-types';
import { Tooltip } from './ui/tooltip';

const statusGlyph: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  failed: '⨯',
  abandoned: '⤺',
};

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
  embedded = false,
}: {
  items: TodoItem[];
  agents: Agent[];
  onJump: (messageId: string) => void;
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
        <Tooltip
          side="bottom"
          align="end"
          wide
          content={
            <div className="space-y-1">
              <div className="font-mono text-[11px] text-fog-200">agent-owned state</div>
              <div className="font-mono text-[10.5px] text-fog-500">
                written by the orchestrator via <span className="text-fog-300">todowrite</span>. humans re-plan via the command palette, not by editing rows.
              </div>
            </div>
          }
        >
          <span className="ml-auto font-mono text-micro uppercase tracking-widest2 text-fog-700 cursor-help">
            read-only
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
}: {
  item: TodoItem;
  owner?: Agent;
  onJump: (messageId: string) => void;
}) {
  const clickable = !!item.taskMessageId;
  const tone = statusTone[item.status];

  return (
    <li className="relative">
      <button
        type="button"
        disabled={!clickable}
        onClick={() => item.taskMessageId && onJump(item.taskMessageId)}
        className={clsx(
          'w-full text-left pl-3 pr-2.5 h-6 flex items-center gap-2 relative transition',
          clickable ? 'hover:bg-ink-800/60 cursor-pointer' : 'cursor-default'
        )}
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
            'shrink-0 w-3 text-center font-mono text-[11px] leading-none',
            tone,
            item.status === 'in_progress' && 'animate-pulse'
          )}
          aria-label={statusLabel[item.status]}
        >
          {statusGlyph[item.status]}
        </span>

        <Tooltip
          side="right"
          wide
          content={
            <div className="space-y-1">
              <div className="font-mono text-[11px] text-fog-200 leading-snug">
                {item.content}
              </div>
              <div className="font-mono text-[10px] text-fog-500">
                <span className={tone}>{statusLabel[item.status]}</span>
                {owner && (
                  <>
                    <span className="text-fog-700"> · </span>
                    <span className="text-fog-400">{owner.name}</span>
                  </>
                )}
                <span className="text-fog-700"> · </span>
                <span className="uppercase tracking-widest2">{item.id}</span>
              </div>
              {item.note && (
                <div className="font-mono text-[10px] text-fog-500 leading-snug">
                  {item.note}
                </div>
              )}
              {clickable && (
                <div className="font-mono text-[10px] text-fog-600">
                  click to jump to delegation
                </div>
              )}
            </div>
          }
        >
          <span className="text-[12px] text-fog-200 truncate flex-1 min-w-0 cursor-default">
            {item.content}
          </span>
        </Tooltip>

        {owner ? (
          <Tooltip content={`${owner.name} — ${owner.role}`} side="top">
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
    </li>
  );
}
