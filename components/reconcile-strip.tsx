'use client';

import clsx from 'clsx';
import { useMemo, useRef, useState } from 'react';
import type { Agent, AgentMessage } from '@/lib/swarm-types';

// Council reconcile surface. Shown above the composer when every member of a
// multi-session run has finished at least one draft and no one is still
// thinking. Each member gets a click-to-focus pill that jumps the timeline to
// that member's latest assistant turn — matching 
// reconcile" framing without pinning an auto-judge role.
//
// Action contract (added 2026-04-21):
//   - `copy`      → pure client-side clipboard; no opencode involvement
//   - `forward`   → page wires this to fan a ratification message out to each
//                   council session so every agent knows which draft won
//   - `round 2`   → page wires this to fan a Round-2 revise prompt (with all
//                   drafts attached) out to each council session
// All three callbacks are optional. If omitted, the corresponding button is
// not rendered — so this component stays valid for callers that just want
// the read-only observation view.
//
// Rendering contract: returns null when conditions aren't met, so callers can
// drop the component into the layout unconditionally.
export function ReconcileStrip({
  agents,
  messages,
  isMultiSession,
  onFocus,
  focusedMsgId,
  onCopyDraft,
  onForwardDraft,
  onStartRoundTwo,
}: {
  agents: Agent[];
  messages: AgentMessage[];
  isMultiSession: boolean;
  onFocus: (id: string) => void;
  focusedMsgId: string | null;
  onCopyDraft?: (draft: AgentMessage, agent: Agent) => void | Promise<void>;
  onForwardDraft?: (draft: AgentMessage, agent: Agent) => void | Promise<void>;
  onStartRoundTwo?: (
    drafts: Array<{ agent: Agent; draft: AgentMessage }>,
  ) => void | Promise<void>;
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
    agents.every(
      (a) => a.id === 'human' || a.status === 'idle' || a.status === 'done',
    );

  // Resolved drafts (draft !== null) — narrow type for the handlers.
  const resolvedDrafts = useMemo(
    () =>
      drafts
        .filter((d): d is { agent: Agent; draft: AgentMessage } => d.draft !== null),
    [drafts],
  );

  const focusedDraft = useMemo(
    () =>
      focusedMsgId
        ? resolvedDrafts.find(({ draft }) => draft.id === focusedMsgId) ?? null
        : null,
    [resolvedDrafts, focusedMsgId],
  );

  const [copiedFlash, setCopiedFlash] = useState(false);
  const [forwardPending, setForwardPending] = useState(false);
  const [r2Pending, setR2Pending] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!ready) return null;

  const handleCopy = async () => {
    if (!focusedDraft || !onCopyDraft) return;
    try {
      await onCopyDraft(focusedDraft.draft, focusedDraft.agent);
      setCopiedFlash(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedFlash(false), 1500);
    } catch {
      // Page-level handler owns user-facing error surfacing; swallow here so
      // a failed copy doesn't leave the strip in a stuck pending state.
    }
  };

  const handleForward = async () => {
    if (!focusedDraft || !onForwardDraft || forwardPending) return;
    setForwardPending(true);
    try {
      await onForwardDraft(focusedDraft.draft, focusedDraft.agent);
    } finally {
      setForwardPending(false);
    }
  };

  const handleRoundTwo = async () => {
    if (!onStartRoundTwo || r2Pending || resolvedDrafts.length < 2) return;
    setR2Pending(true);
    try {
      await onStartRoundTwo(resolvedDrafts);
    } finally {
      setR2Pending(false);
    }
  };

  const hasAnyAction =
    onCopyDraft !== undefined ||
    onForwardDraft !== undefined ||
    onStartRoundTwo !== undefined;

  const actionDisabledTitle = focusedDraft
    ? undefined
    : 'click a draft pill to select it first';

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
        {resolvedDrafts.length} / {drafts.length} drafts
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
                  : 'bg-ink-800 border-iris/25 text-fog-300 hover:bg-iris/10 hover:text-iris',
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

      {hasAnyAction && (
        <div className="shrink-0 flex items-center gap-1 pl-2 border-l border-ink-700">
          {onCopyDraft && (
            <button
              type="button"
              onClick={handleCopy}
              disabled={!focusedDraft}
              title={actionDisabledTitle ?? 'copy focused draft body to clipboard'}
              className={clsx(
                'h-6 px-2 rounded hairline font-mono text-[10px] uppercase tracking-widest2 transition flex items-center gap-1.5',
                !focusedDraft
                  ? 'bg-ink-800 border-ink-700 text-fog-700 cursor-not-allowed'
                  : copiedFlash
                    ? 'bg-mint/15 border-mint/50 text-mint'
                    : 'bg-ink-800 border-fog-500/25 text-fog-300 hover:bg-fog-500/10 hover:text-fog-100',
              )}
            >
              {copiedFlash ? 'copied ✓' : 'copy'}
            </button>
          )}

          {onForwardDraft && (
            <button
              type="button"
              onClick={handleForward}
              disabled={!focusedDraft || forwardPending}
              title={
                actionDisabledTitle ??
                'ratify this draft — send it back to every council session as the human reply'
              }
              className={clsx(
                'h-6 px-2 rounded hairline font-mono text-[10px] uppercase tracking-widest2 transition flex items-center gap-1.5',
                !focusedDraft
                  ? 'bg-ink-800 border-ink-700 text-fog-700 cursor-not-allowed'
                  : forwardPending
                    ? 'bg-iris/15 border-iris/50 text-iris cursor-wait'
                    : 'bg-ink-800 border-iris/25 text-iris hover:bg-iris/15 hover:text-iris',
              )}
            >
              {forwardPending ? 'forwarding…' : 'forward →'}
            </button>
          )}

          {onStartRoundTwo && (
            <button
              type="button"
              onClick={handleRoundTwo}
              disabled={r2Pending || resolvedDrafts.length < 2}
              title="reveal all drafts to every member and ask for a revised response"
              className={clsx(
                'h-6 px-2 rounded hairline font-mono text-[10px] uppercase tracking-widest2 transition flex items-center gap-1.5',
                r2Pending
                  ? 'bg-amber/15 border-amber/50 text-amber cursor-wait'
                  : 'bg-ink-800 border-amber/25 text-amber hover:bg-amber/15 hover:text-amber',
              )}
            >
              {r2Pending ? 'fanning…' : '↻ round 2'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
