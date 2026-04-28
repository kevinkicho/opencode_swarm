'use client';

// v1.14 supplementary surfaces panel for the inspector drawer.
//
// Surfaces three opencode session-scoped surfaces that don't fit
// elsewhere in the inspector:
//   - /session/{id}/children : direct sub-sessions spawned via task tool
//   - /session/{id}/todo     : agent's own todowrite snapshot
//                              (cross-check vs blackboard plan)
//   - /session/{id}/summarize : manual compaction trigger
// Hidden when there's no opencode sessionID yet (ephemeral agents) or
// when the agent's workspace isn't known (mock fixtures).
//
// Lifted from agent-inspector.tsx 2026-04-28 — most self-contained
// of the inspector helpers (own queries via useLive*, own mutation
// state for the summarize button).

import clsx from 'clsx';
import { useState } from 'react';
import type { Agent } from '@/lib/swarm-types';
import { Tooltip } from '../ui/tooltip';
import {
  postSessionSummarizeBrowser,
  useLiveSessionChildren,
  useLiveSessionTodos,
} from '@/lib/opencode/live';

export function SessionInfoPanel({
  agent,
  workspace,
}: {
  agent: Agent;
  workspace: string;
}) {
  const sessionId = agent.sessionID ?? null;
  const directory = workspace || null;
  const childrenQ = useLiveSessionChildren(sessionId, directory);
  const todosQ = useLiveSessionTodos(sessionId, directory);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'ok' | 'err' | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  if (!sessionId || !directory) return null;

  const childrenCount = childrenQ.data?.length ?? 0;
  const todos = todosQ.data ?? [];
  const todoOpen = todos.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').length;
  const todoDone = todos.filter((t) => t.status === 'completed').length;

  const onSummarize = async () => {
    if (busy || !directory) return;
    setBusy(true);
    setDone(null);
    setErrMsg(null);
    try {
      // ModelRef.id is `<provider>/<modelID>` for tiered models, or just
      // a bare modelID for unprefixed BYOK. Split on the first slash.
      const slash = agent.model.id.indexOf('/');
      const providerID = slash === -1 ? 'opencode' : agent.model.id.slice(0, slash);
      const modelID = slash === -1 ? agent.model.id : agent.model.id.slice(slash + 1);
      await postSessionSummarizeBrowser(sessionId, directory, providerID, modelID);
      setDone('ok');
    } catch (e) {
      setDone('err');
      setErrMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md hairline bg-ink-800 overflow-hidden">
      <div className="px-3 h-8 hairline-b flex items-center gap-2">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          session info
        </span>
        <span className="ml-auto font-mono text-[9.5px] text-fog-700">
          opencode v1.14
        </span>
      </div>

      <dl className="px-3 py-2 grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 font-mono text-[11px]">
        <dt className="text-fog-600 uppercase tracking-widest2 text-[9.5px] self-center">
          children
        </dt>
        <dd className="text-fog-200 tabular-nums self-center">
          {childrenQ.loading
            ? '…'
            : childrenQ.error
              ? <span className="text-rust">err</span>
              : childrenCount === 0
                ? <span className="text-fog-600">none</span>
                : (
                    <span>
                      <span className="text-fog-100">{childrenCount}</span>{' '}
                      <span className="text-fog-600">sub-session{childrenCount === 1 ? '' : 's'}</span>
                    </span>
                  )}
        </dd>

        <dt className="text-fog-600 uppercase tracking-widest2 text-[9.5px] self-center">
          todos
        </dt>
        <dd className="text-fog-200 tabular-nums self-center">
          {todosQ.loading
            ? '…'
            : todosQ.error
              ? <span className="text-rust">err</span>
              : todos.length === 0
                ? <span className="text-fog-600">empty</span>
                : (
                    <Tooltip
                      side="top"
                      content={
                        <div className="space-y-0.5 max-w-72">
                          {todos.slice(0, 8).map((t, i) => (
                            // Index falls back when opencode returns todos
                            // with duplicate or empty ids (observed during
                            // todowrite mid-stream — partial state).
                            <div
                              key={`${t.id || ''}-${i}`}
                              className={clsx(
                                'font-mono text-[10px] truncate',
                                t.status === 'completed' && 'text-fog-600 line-through',
                                t.status === 'in_progress' && 'text-molten',
                                t.status === 'pending' && 'text-fog-200',
                                t.status === 'cancelled' && 'text-fog-700 line-through',
                              )}
                            >
                              {t.content}
                            </div>
                          ))}
                          {todos.length > 8 && (
                            <div className="font-mono text-[9.5px] text-fog-700">
                              +{todos.length - 8} more
                            </div>
                          )}
                        </div>
                      }
                    >
                      <span className="cursor-help underline decoration-dotted decoration-fog-700 underline-offset-[3px]">
                        <span className="text-mint">{todoDone}</span>
                        <span className="text-fog-700">/</span>
                        <span className="text-fog-100">{todos.length}</span>
                        {todoOpen > 0 && (
                          <span className="text-molten ml-1.5">
                            {todoOpen} open
                          </span>
                        )}
                      </span>
                    </Tooltip>
                  )}
        </dd>
      </dl>

      <div className="px-3 pb-3 pt-1 hairline-t flex items-center gap-2">
        <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-600 shrink-0">
          summarize
        </span>
        <Tooltip
          side="top"
          wide
          content={
            <div className="space-y-0.5">
              <div className="font-mono text-[11px] text-fog-200">
                manual context compaction
              </div>
              <div className="font-mono text-[10.5px] text-fog-600 max-w-72">
                opencode summarizes earlier turns into a synthetic part
                — runs the model named below. Use before context-cap to
                stretch a long-running session.
              </div>
            </div>
          }
        >
          <button
            onClick={onSummarize}
            disabled={busy}
            className={clsx(
              'h-5 px-1.5 rounded hairline font-mono text-[10px] uppercase tracking-widest2 transition shrink-0',
              done === 'ok'
                ? 'border-mint/40 bg-mint/10 text-mint'
                : done === 'err'
                  ? 'border-rust/40 bg-rust/10 text-rust'
                  : 'border-molten/30 bg-molten/10 text-molten hover:bg-molten/20',
              busy && 'opacity-60 cursor-wait',
            )}
          >
            {busy ? 'running…' : done === 'ok' ? 'queued' : done === 'err' ? 'failed' : 'compact'}
          </button>
        </Tooltip>
        <span className="ml-auto font-mono text-[9.5px] text-fog-700 truncate min-w-0">
          via {agent.model.label}
        </span>
      </div>

      {done === 'err' && errMsg && (
        <div className="hairline-t px-3 py-1.5 font-mono text-[10px] text-rust/90 truncate">
          {errMsg}
        </div>
      )}
    </div>
  );
}
