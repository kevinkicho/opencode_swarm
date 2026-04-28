'use client';

// Per-agent budget burn-down panel for the inspector drawer.
//
// Editable token budget (inline-edit + step buttons) wired against an
// effective % spent meter, plus 3-up tabular footer (cost · sent ·
// recv). The "apply cap" button is currently a no-op stub; the
// actionable wire-up lands when opencode grows session-level cap APIs.
//
// Lifted from agent-inspector.tsx 2026-04-28 — pure render driven by
// `agent` prop. Local useState for the in-flight edit + budget delta;
// committing the budget remains client-only until the apply path
// exists.

import clsx from 'clsx';
import { useState } from 'react';
import type { Agent } from '@/lib/swarm-types';
import { Tooltip } from '../ui/tooltip';
import { compact } from '@/lib/format';

export function BudgetPanel({ agent }: { agent: Agent }) {
  const [budget, setBudget] = useState<number>(agent.tokensBudget);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(String(agent.tokensBudget));
  const dirty = budget !== agent.tokensBudget;
  const effectivePct = Math.min(100, Math.round((agent.tokensUsed / budget) * 100));
  const barTone = effectivePct > 80 ? 'bg-rust' : effectivePct > 60 ? 'bg-amber' : 'bg-molten';

  const commit = () => {
    const parsed = Number(draft.replace(/[,_\s]/g, ''));
    if (Number.isFinite(parsed) && parsed > 0) setBudget(Math.round(parsed));
    else setDraft(String(budget));
    setEditing(false);
  };

  const bump = (delta: number) => setBudget((b) => Math.max(1000, b + delta));

  return (
    <div className="rounded-md hairline bg-ink-800 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          budget burn
        </span>
        {dirty && (
          <span className="font-mono text-micro uppercase tracking-wider text-molten normal-case">
            · edited
          </span>
        )}
        <span className="ml-auto font-mono text-2xs text-fog-200 tabular-nums">
          {compact(agent.tokensUsed)} /{' '}
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') {
                  setDraft(String(budget));
                  setEditing(false);
                }
              }}
              className="inline-block w-16 bg-ink-900 hairline px-1 py-0 font-mono text-2xs text-fog-100 tabular-nums focus:outline-none focus:border-molten/50"
            />
          ) : (
            <button
              onClick={() => {
                setDraft(String(budget));
                setEditing(true);
              }}
              className="text-fog-200 hover:text-molten transition border-b border-dashed border-fog-700 hover:border-molten/60"
            >
              {compact(budget)}
            </button>
          )}
        </span>
      </div>

      <div className="relative h-[4px] rounded-full bg-ink-900 overflow-hidden">
        <div
          className={clsx('absolute top-0 left-0 bottom-0 transition-[width]', barTone)}
          style={{ width: `${effectivePct}%` }}
        />
      </div>

      <div className="flex items-center gap-1">
        {[10_000, 25_000, 50_000].map((delta) => (
          <button
            key={delta}
            onClick={() => bump(delta)}
            className="h-5 px-1.5 rounded bg-ink-900 hairline font-mono text-[9.5px] uppercase tracking-wider text-fog-500 hover:border-molten/40 hover:text-molten transition"
          >
            +{compact(delta)}
          </button>
        ))}
        <button
          onClick={() => bump(-10_000)}
          className="h-5 px-1.5 rounded bg-ink-900 hairline font-mono text-[9.5px] uppercase tracking-wider text-fog-500 hover:border-rust/40 hover:text-rust transition"
        >
          −10k
        </button>
        <span className="ml-auto font-mono text-[9.5px] text-fog-600 tabular-nums">
          {effectivePct}% spent
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 font-mono text-micro tabular-nums pt-1">
        <Tooltip content="dollars spent by this agent so far" side="top">
          <span className="text-fog-200 cursor-help">${agent.costUsed.toFixed(2)}</span>
        </Tooltip>
        <Tooltip content="messages this agent has sent" side="top">
          <span className="text-fog-500 cursor-help">sent {agent.messagesSent}</span>
        </Tooltip>
        <Tooltip content="messages this agent has received" side="top">
          <span className="text-fog-500 cursor-help">recv {agent.messagesRecv}</span>
        </Tooltip>
      </div>

      {dirty && (
        <div className="flex items-center gap-2 pt-1 hairline-t">
          <button
            onClick={() => {
              setBudget(agent.tokensBudget);
              setDraft(String(agent.tokensBudget));
            }}
            className="font-mono text-[10px] uppercase tracking-wider text-fog-600 hover:text-fog-300 transition"
          >
            revert
          </button>
          <button className="ml-auto font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-molten/15 border border-molten/40 text-molten hover:bg-molten/25 transition">
            apply cap
          </button>
        </div>
      )}
    </div>
  );
}
