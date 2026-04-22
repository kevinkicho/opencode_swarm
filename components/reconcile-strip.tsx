'use client';

import clsx from 'clsx';
import { useMemo } from 'react';
import type { Agent, AgentMessage } from '@/lib/swarm-types';

// Council reconcile surface. Shown above the composer when every member of a
// multi-session run has finished at least one draft and no one is still
// thinking. Each member gets a click-to-focus pill that jumps the timeline to
// that member's latest assistant turn — matching SWARM_PATTERNS.md §4's "human
// reconcile" framing without taking imperative action on the user's behalf.
// v1 is pure observation + selection: no "accept this draft" destructive move,
// no automated vote. Humans pick by reading the drafts in the timeline; the
// strip just makes "N/N ready" visible and the drafts one click away.
//
// Rendering contract: returns null when conditions aren't met, so callers can
// drop the component into the layout unconditionally.
export function ReconcileStrip({
  agents,
  messages,
  isMultiSession,
  onFocus,
  focusedMsgId,
}: {
  agents: Agent[];
  messages: AgentMessage[];
  isMultiSession: boolean;
  onFocus: (id: string) => void;
  focusedMsgId: string | null;
}) {
  // For each non-human agent, find its latest assistant text message. Users
  // only care about the *last* draft — earlier turns are context, not the
  // reconcile candidate. part === 'text' filters out tool/reasoning chatter
  // so the preview reads like a reply, not a trace fragment.
  const drafts = useMemo(() => {
    if (!isMultiSession) return [];
    const byAgent = new Map<string, AgentMessage>();
    for (const m of messages) {
      if (m.fromAgentId === 'human') continue;
      if (m.part !== 'text') continue;
      if (m.status !== 'complete') continue;
      byAgent.set(m.fromAgentId, m);
    }
    return agents
      .filter((a) => a.id !== 'human')
      .map((a) => ({ agent: a, draft: byAgent.get(a.id) ?? null }));
  }, [agents, messages, isMultiSession]);

  // Reconcile is only meaningful once every member has a draft AND the run
  // has quieted. If anyone is still working / thinking / waiting, the strip
  // would race with in-flight turns and offer a stale pick. Let the run
  // settle first.
  const ready =
    drafts.length >= 2 &&
    drafts.every((d) => d.draft !== null) &&
    agents.every((a) => a.id === 'human' || a.status === 'idle' || a.status === 'done');

  if (!ready) return null;

  return (
    <div className="hairline-t bg-iris/[0.05] backdrop-blur px-4 h-9 flex items-center gap-2 shrink-0">
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-iris" />
        <span className="font-mono text-[9px] uppercase tracking-widest2 text-iris">
          reconcile
        </span>
      </div>

      <span className="w-px h-3 bg-iris/20" />

      <span className="font-mono text-[11px] uppercase tracking-widest2 text-fog-200 shrink-0">
        {drafts.length} / {drafts.length} drafts
      </span>

      <span className="w-px h-3 bg-ink-700" />

      <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto">
        {drafts.map(({ agent, draft }) => {
          if (!draft) return null;
          const preview = (draft.body ?? draft.title ?? '').replace(/\s+/g, ' ').trim();
          const short = preview.length > 64 ? preview.slice(0, 64) + '…' : preview;
          const isFocused = focusedMsgId === draft.id;
          return (
            <button
              key={agent.id}
              onClick={() => onFocus(draft.id)}
              title={preview || `${agent.name} — (empty draft)`}
              className={clsx(
                'h-6 px-2 rounded hairline font-mono text-[10px] transition flex items-center gap-1.5 shrink-0 max-w-[280px]',
                isFocused
                  ? 'bg-iris/20 border-iris/60 text-iris'
                  : 'bg-ink-800 border-iris/25 text-fog-300 hover:bg-iris/10 hover:text-iris'
              )}
            >
              <span className="uppercase tracking-widest2 text-[9px] shrink-0">
                {agent.name}
              </span>
              <span className="truncate text-fog-500">
                {short || '—'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
