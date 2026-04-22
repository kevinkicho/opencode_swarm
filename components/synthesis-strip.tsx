'use client';

import clsx from 'clsx';
import { useMemo } from 'react';
import type { Agent, AgentMessage, SwarmPattern } from '@/lib/swarm-types';

// Map-reduce synthesis surface — single-output analogue of ReconcileStrip.
// Shown above the composer for runs with pattern='map-reduce' once any member
// has produced its scoped draft. Where reconcile surfaces N drafts and asks
// the human to pick one, synthesis surfaces the same N member pills plus a
// single merged output produced by the backend synthesis phase (see
// lib/server/map-reduce.ts::runMapReduceSynthesis).
//
// Detection heuristic. The synthesis post always starts with the literal
// string 'Map-reduce synthesis phase.' — matched against user-message bodies
// in the merged transcript. The first completed assistant text that follows
// that prompt is the synthesis output. If the prompt hasn't landed yet, we
// show "awaiting synthesis" (backend background task hasn't fired yet);
// prompt posted but no reply yet → "synthesizing…"; completed → "ready".
// Brittle on copy-paste string match, but the synthesis prompt never appears
// in organic chat and the prefix is stable in one place. A v2 improvement
// would tag the user post with a synthesis marker field when we own that
// wire format end to end.
//
// Rendering contract: returns null when conditions aren't met (wrong pattern,
// single-session, nothing to show yet), so callers can drop it unconditionally.
const SYNTHESIS_PREFIX = 'Map-reduce synthesis phase.';

type SynthesisState =
  | { status: 'pending'; message: null }
  | { status: 'in_progress'; message: null }
  | { status: 'ready'; message: AgentMessage };

export function SynthesisStrip({
  agents,
  messages,
  pattern,
  sessionCount,
  onFocus,
  focusedMsgId,
}: {
  agents: Agent[];
  messages: AgentMessage[];
  pattern: SwarmPattern | null;
  sessionCount: number;
  onFocus: (id: string) => void;
  focusedMsgId: string | null;
}) {
  // Per-member drafts: latest completed assistant text per non-human agent.
  // Same shape as ReconcileStrip — we want the strip to read as a familiar
  // sibling surface to users who already know council.
  const drafts = useMemo(() => {
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
  }, [agents, messages]);

  const synthesis: SynthesisState = useMemo(() => {
    let promptIdx = -1;
    for (let i = 0; i < messages.length; i += 1) {
      const m = messages[i];
      if (m.fromAgentId !== 'human') continue;
      if (m.part !== 'text') continue;
      if ((m.body ?? '').startsWith(SYNTHESIS_PREFIX)) {
        promptIdx = i;
        break;
      }
    }
    if (promptIdx === -1) return { status: 'pending', message: null };
    for (let i = promptIdx + 1; i < messages.length; i += 1) {
      const m = messages[i];
      if (m.fromAgentId === 'human') continue;
      if (m.part !== 'text') continue;
      if (m.status === 'complete') {
        return { status: 'ready', message: m };
      }
    }
    return { status: 'in_progress', message: null };
  }, [messages]);

  const draftsReady = drafts.filter((d) => d.draft !== null).length;

  if (pattern !== 'map-reduce' || sessionCount < 2) return null;
  // Show as soon as one member has drafted OR the synthesis phase has begun.
  // Before that the strip would be empty noise — the timeline is where the
  // user watches map phase progress.
  if (draftsReady === 0 && synthesis.status === 'pending') return null;

  const allMembersDrafted = drafts.length >= 2 && draftsReady === drafts.length;
  const statusLabel =
    synthesis.status === 'ready'
      ? 'synthesis ready'
      : synthesis.status === 'in_progress'
        ? 'synthesizing…'
        : allMembersDrafted
          ? 'awaiting synthesis'
          : `map ${draftsReady}/${drafts.length}`;

  const statusTone =
    synthesis.status === 'ready'
      ? 'text-mint'
      : synthesis.status === 'in_progress'
        ? 'text-mint/80'
        : 'text-fog-300';

  const synthesisFocused =
    synthesis.status === 'ready' && focusedMsgId === synthesis.message.id;

  return (
    <div className="hairline-t bg-mint/[0.05] backdrop-blur px-4 h-9 flex items-center gap-2 shrink-0">
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-mint" />
        <span className="font-mono text-[9px] uppercase tracking-widest2 text-mint">
          synthesis
        </span>
      </div>

      <span className="w-px h-3 bg-mint/20" />

      <span
        className={clsx(
          'font-mono text-[11px] uppercase tracking-widest2 shrink-0',
          statusTone,
        )}
      >
        {statusLabel}
      </span>

      <span className="w-px h-3 bg-ink-700" />

      <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto">
        {drafts.map(({ agent, draft }) => {
          const preview = draft
            ? (draft.body ?? draft.title ?? '').replace(/\s+/g, ' ').trim()
            : '';
          const short = preview.length > 56 ? preview.slice(0, 56) + '…' : preview;
          const isFocused = !!draft && focusedMsgId === draft.id;
          const disabled = !draft;
          return (
            <button
              key={agent.id}
              onClick={() => draft && onFocus(draft.id)}
              disabled={disabled}
              title={
                draft
                  ? preview || `${agent.name} — (empty draft)`
                  : `${agent.name} — still mapping`
              }
              className={clsx(
                'h-6 px-2 rounded hairline font-mono text-[10px] transition flex items-center gap-1.5 shrink-0 max-w-[240px]',
                disabled
                  ? 'bg-ink-800 border-ink-700 text-fog-700 cursor-wait'
                  : isFocused
                    ? 'bg-mint/20 border-mint/60 text-mint'
                    : 'bg-ink-800 border-mint/25 text-fog-300 hover:bg-mint/10 hover:text-mint',
              )}
            >
              <span className="uppercase tracking-widest2 text-[9px] shrink-0">
                {agent.name}
              </span>
              <span className="truncate text-fog-500">
                {disabled ? '…' : short || '—'}
              </span>
            </button>
          );
        })}
      </div>

      {synthesis.status === 'ready' && (
        <div className="shrink-0 flex items-center gap-1 pl-2 border-l border-ink-700">
          <button
            type="button"
            onClick={() => onFocus(synthesis.message.id)}
            title="jump to the unified synthesis output in the timeline"
            className={clsx(
              'h-6 px-2 rounded hairline font-mono text-[10px] uppercase tracking-widest2 transition flex items-center gap-1.5',
              synthesisFocused
                ? 'bg-mint/20 border-mint/60 text-mint'
                : 'bg-ink-800 border-mint/40 text-mint hover:bg-mint/15',
            )}
          >
            open synthesis →
          </button>
        </div>
      )}
    </div>
  );
}
