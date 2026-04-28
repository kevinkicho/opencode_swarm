'use client';

// Compact chip on an agent row: "→ item B". Click jumps to the task-tool
// message that bound the todo. Multi-todo case shows a "+N" suffix; the
// Popover reveals the full list. Positioned inline between name and the
// attention badge so a single glance answers "what is this agent doing?".
//
// Lifted from agent-row.tsx 2026-04-28 — pure render driven by the
// todos prop; no state, no effects.

import clsx from 'clsx';
import type { Agent, TodoItem } from '@/lib/swarm-types';
import { Popover } from '../ui/popover';

export function ActiveTodoChip({
  todos,
  accent,
  onFocus,
}: {
  todos: TodoItem[];
  accent: Agent['accent'];
  onFocus: (messageId: string) => void;
}) {
  const primary = todos[0];
  const extra = todos.length - 1;
  const toneText: Record<Agent['accent'], string> = {
    molten: 'text-molten',
    mint: 'text-mint',
    iris: 'text-iris',
    amber: 'text-amber',
    fog: 'text-fog-300',
  };

  const jumpTo = (messageId?: string) => {
    if (messageId) onFocus(messageId);
  };

  const content = (close?: () => void) => (
    <div className="py-1 min-w-[220px]">
      <div className="px-2 pt-1 pb-1.5 flex items-center gap-2">
        <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-500">
          in progress
        </span>
        <span className="ml-auto font-mono text-[9.5px] tabular-nums text-fog-600">
          {todos.length}
        </span>
      </div>
      <ul className="hairline-t">
        {todos.map((t) => {
          const clickable = !!t.taskMessageId;
          return (
            <li key={t.id}>
              <button
                type="button"
                disabled={!clickable}
                onClick={() => {
                  jumpTo(t.taskMessageId);
                  close?.();
                }}
                className={clsx(
                  'w-full grid grid-cols-[28px_1fr] items-center gap-2 px-2 h-6 text-left border-b border-ink-800 last:border-b-0 transition',
                  clickable ? 'hover:bg-ink-800 cursor-pointer' : 'cursor-default'
                )}
              >
                <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-500">
                  {t.id}
                </span>
                <span className="text-[11px] text-fog-200 truncate leading-none">
                  {t.content}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <span onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <Popover side="right" align="start" width={280} content={content}>
        <span
          className={clsx(
            'shrink-0 inline-flex items-center gap-1 h-4 px-1 rounded-sm cursor-pointer',
            'bg-ink-900/60 hairline hover:border-molten/40 transition max-w-[110px]',
          )}
        >
          <span className={clsx('font-mono text-[9px] uppercase tracking-widest2', toneText[accent])}>
            →
          </span>
          <span className="font-mono text-[10px] text-fog-300 truncate min-w-0">
            {primary.content}
          </span>
          {extra > 0 && (
            <span className="font-mono text-[9.5px] tabular-nums text-fog-600 shrink-0">
              +{extra}
            </span>
          )}
        </span>
      </Popover>
    </span>
  );
}
