'use client';

import clsx from 'clsx';
import { useCallback, useRef, useState } from 'react';

import type { BoardItem, BoardItemStatus } from '@/lib/blackboard/types';

type StatusAction = {
  label: string;
  from: BoardItemStatus | BoardItemStatus[];
  to: BoardItemStatus;
  tone: string;
  needsInput?: boolean;
};

const ACTIONS: Record<BoardItemStatus, StatusAction[]> = {
  'open': [{ label: 'claim', from: 'open', to: 'claimed', tone: 'text-iris hover:bg-iris/10' }],
  'claimed': [{ label: 'start', from: 'claimed', to: 'in-progress', tone: 'text-molten hover:bg-molten/10' }],
  'in-progress': [{ label: 'done', from: 'in-progress', to: 'done', tone: 'text-mint hover:bg-mint/10' }],
  'done': [{ label: 'reopen', from: 'done', to: 'open', tone: 'text-fog-400 hover:bg-fog-500/10' }],
  'stale': [{ label: 'reopen', from: 'stale', to: 'open', tone: 'text-fog-400 hover:bg-fog-500/10' }],
  'blocked': [{ label: 'unblock', from: 'blocked', to: 'open', tone: 'text-amber hover:bg-amber/10' }],
};

const QUESTION_ACTIONS: Record<BoardItemStatus, StatusAction[]> = {
  'open': [{ label: 'answer', from: 'open', to: 'done', tone: 'text-amber hover:bg-amber/10', needsInput: true }],
  'claimed': [{ label: 'answer', from: 'claimed', to: 'done', tone: 'text-amber hover:bg-amber/10', needsInput: true }],
  'in-progress': [{ label: 'answer', from: 'in-progress', to: 'done', tone: 'text-mint hover:bg-mint/10', needsInput: true }],
  'done': [{ label: 'reopen', from: 'done', to: 'open', tone: 'text-fog-400 hover:bg-fog-500/10' }],
  'stale': [{ label: 'reopen', from: 'stale', to: 'open', tone: 'text-fog-400 hover:bg-fog-500/10' }],
  'blocked': [{ label: 'unblock', from: 'blocked', to: 'open', tone: 'text-amber hover:bg-amber/10' }],
};

export function BoardStatusActions({
  item,
  swarmRunID,
}: {
  item: BoardItem;
  swarmRunID: string;
}) {
  const actions = (item.kind === 'question' ? QUESTION_ACTIONS : ACTIONS)[item.status];
  const [transitioning, setTransitioning] = useState(false);
  const [answering, setAnswering] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const fire = useCallback(async (action: StatusAction, content?: string) => {
    setTransitioning(true);
    try {
      if (content !== undefined) {
        await fetch(
          `/api/swarm/run/${encodeURIComponent(swarmRunID)}/board/items/${encodeURIComponent(item.id)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content }),
          },
        );
      }
      await fetch(
        `/api/swarm/run/${encodeURIComponent(swarmRunID)}/board/items/${encodeURIComponent(item.id)}/transition`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from: action.from, to: action.to }),
        },
      );
    } catch { console.warn('board status transition failed'); }
    setTransitioning(false);
    setAnswering(false);
  }, [item.id, swarmRunID]);

  if (answering) {
    return (
      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          placeholder="type answer…"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && inputRef.current?.value.trim()) {
              const a = actions.find((x) => x.needsInput);
              if (a) fire(a, inputRef.current.value.trim());
            }
            if (e.key === 'Escape') setAnswering(false);
          }}
          className="h-4 px-1 rounded-sm bg-ink-800 border border-amber/40 text-fog-100 font-mono text-[10px] outline-none focus:border-amber w-32"
        />
        <button
          type="button"
          disabled={transitioning}
          onClick={() => {
            const v = inputRef.current?.value.trim();
            if (!v) return;
            const a = actions.find((x) => x.needsInput);
            if (a) fire(a, v);
          }}
          className="h-4 px-1.5 rounded-sm font-mono text-[9px] uppercase tracking-widest2 text-mint bg-mint/10 border border-mint/30 hover:bg-mint/20 transition-colors cursor-pointer disabled:opacity-40"
        >
          ok
        </button>
        <button
          type="button"
          onClick={() => setAnswering(false)}
          className="h-4 px-1.5 rounded-sm font-mono text-[9px] uppercase tracking-widest2 text-fog-500 hover:text-fog-300 transition-colors cursor-pointer"
        >
          cancel
        </button>
      </div>
    );
  }

  if (!actions.length) return null;

  return (
    <div className="flex items-center gap-1">
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          disabled={transitioning}
          onClick={(e) => {
            e.stopPropagation();
            if (a.needsInput) {
              setAnswering(true);
              return;
            }
            fire(a);
          }}
          className={clsx(
            'h-4 px-1.5 rounded-sm font-mono text-[9px] uppercase tracking-widest2 transition-colors cursor-pointer disabled:opacity-40',
            a.tone,
          )}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}