'use client';

//
// Per-agent inspector panel + its 3 helpers (ModelSwapRow / ModelPicker /
// BudgetPanel). Lifted from sub-components.tsx so the main file isn't
// 800 LOC. AgentInspector is the largest sub-tree in the inspector
// drawer — model swap UI + budget burn-down + recent activity stream
// — and pulling it out gives the main file room to focus on the
// message + file-heat panels.
//
// v1.14 additions: SessionInfoPanel surfaces /session/{id}/children +
// /session/{id}/todo + a manual /session/{id}/summarize action so the
// inspector matches what the daemon now exposes.

import clsx from 'clsx';
import { useState } from 'react';
import type { Agent, AgentMessage, ModelRef, Provider } from '@/lib/swarm-types';
import { ProviderBadge } from '../provider-badge';
import { Popover } from '../ui/popover';
import { Tooltip } from '../ui/tooltip';
import { compact } from '@/lib/format';
import { partHex, toolMeta } from '@/lib/part-taxonomy';
import {
  postSessionSummarizeBrowser,
  useLiveSessionChildren,
  useLiveSessionTodos,
  useOpencodeProviders,
} from '@/lib/opencode/live';

export function AgentInspector({
  agent,
  messages,
  onFocus,
  workspace,
}: {
  agent: Agent;
  messages: AgentMessage[];
  onFocus: (id: string) => void;
  workspace: string;
}) {
  const agentMsgs = messages.filter(
    (m) => m.fromAgentId === agent.id || m.toAgentIds.includes(agent.id)
  );
  return (
    <div className="space-y-3 animate-fade-up">
      <div className="border border-ink-600 bg-ink-800 relative">
        <span
          className={clsx(
            'absolute left-0 right-0 top-0 h-[2px]',
            agent.accent === 'molten' && 'bg-molten',
            agent.accent === 'mint' && 'bg-mint',
            agent.accent === 'iris' && 'bg-iris',
            agent.accent === 'amber' && 'bg-amber',
            agent.accent === 'fog' && 'bg-fog-500'
          )}
        />
        <div className="px-3 pt-3 pb-3">
          <div className="flex items-center gap-2">
            <span
              className={clsx(
                'font-mono text-[11px] uppercase tracking-widest2 shrink-0',
                agent.accent === 'molten' && 'text-molten',
                agent.accent === 'mint' && 'text-mint',
                agent.accent === 'iris' && 'text-iris',
                agent.accent === 'amber' && 'text-amber',
                agent.accent === 'fog' && 'text-fog-400'
              )}
            >
              {agent.glyph}
            </span>
            <span className="text-[15px] text-fog-100">{agent.name}</span>
          </div>

          <div className="mt-3">
            <ModelSwapRow agent={agent} />
          </div>

          {agent.focus && (
            <div className="mt-3 text-[12px] text-fog-300 leading-relaxed">
              <span className="font-mono text-micro uppercase tracking-wider text-fog-700 mr-1.5">
                focus
              </span>
              {agent.focus}
            </div>
          )}
        </div>
      </div>

      <BudgetPanel agent={agent} />

      <SessionInfoPanel agent={agent} workspace={workspace} />

      <div className="rounded-md hairline bg-ink-800 overflow-hidden">
        <div className="px-3 h-8 hairline-b flex items-center">
          <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
            recent activity
          </span>
          <span className="ml-auto font-mono text-micro text-fog-700">
            {agentMsgs.length}
          </span>
        </div>
        <ul className="max-h-64 overflow-y-auto">
          {agentMsgs.slice(-8).reverse().map((m) => {
            const label = m.toolName ?? m.part;
            const color = m.toolName
              ? toolMeta[m.toolName].hex
              : partHex[m.part];
            return (
              <li key={m.id}>
                <button
                  onClick={() => onFocus(m.id)}
                  className="w-full h-8 grid grid-cols-[8px_64px_1fr_40px] items-center gap-2 px-3 hover:bg-ink-750 transition text-left border-b border-ink-700 last:border-b-0"
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span
                    className="font-mono text-micro uppercase tracking-widest2 truncate"
                    style={{ color }}
                  >
                    {label}
                  </span>
                  <span className="text-[12px] text-fog-300 truncate">{m.title}</span>
                  <span className="font-mono text-[10.5px] text-fog-600 tabular-nums text-right">
                    {m.timestamp}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/*
        Per-agent "control" panel was removed in April 2026 — the four buttons
        (pause, branch-here, nudge-retry, terminate) were unwired. Per
        DESIGN.md §9, reintroduce wired. Real paths:
          pause / terminate → session.abort (soft cancel; current turn only)
          branch-here       → session.revert + session.create children
          nudge-retry       → session.prompt("retry the last action")
        "pause" vs "terminate" may fold into one button once we ship — they
        both map to the same opencode call today.
      */}
    </div>
  );
}

function ModelSwapRow({ agent }: { agent: Agent }) {
  const [model, setModel] = useState<ModelRef>(agent.model);
  const swapped = model.id !== agent.model.id;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 font-mono text-micro uppercase tracking-widest2">
        <span className="text-fog-600">model</span>
        {swapped && (
          <span className="text-molten normal-case tracking-normal">
            · hot-swap pending apply
          </span>
        )}
      </div>
      <Popover
        side="bottom"
        align="start"
        width={320}
        content={(close) => (
          <ModelPicker
            current={model}
            onPick={(m) => {
              setModel(m);
              close();
            }}
          />
        )}
      >
        <button
          className={clsx(
            'w-full flex items-center gap-2 px-2 py-1.5 rounded hairline bg-ink-900 transition text-left',
            swapped
              ? 'border-molten/50 hover:border-molten'
              : 'border-ink-600 hover:border-fog-500/50',
          )}
        >
          <ProviderBadge provider={model.provider} size="sm" />
          <span className="font-mono text-[11.5px] text-fog-100 truncate flex-1">
            {model.label}
          </span>
          {model.pricing && (
            <span className="font-mono text-[9.5px] text-fog-600 tabular-nums shrink-0">
              ${model.pricing.input}/${model.pricing.output}
            </span>
          )}
          <span className="font-mono text-[9px] text-fog-600 shrink-0">▾</span>
        </button>
      </Popover>
      {swapped && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => setModel(agent.model)}
            className="font-mono text-[10px] uppercase tracking-wider text-fog-600 hover:text-fog-300 transition"
          >
            revert
          </button>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="font-mono text-[10px] text-fog-600">
              swap mid-session?
            </span>
            <button
              className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-molten/15 border border-molten/40 text-molten hover:bg-molten/25 transition"
            >
              apply
            </button>
          </span>
        </div>
      )}
      <div className="font-mono text-[9.5px] text-fog-700 leading-snug">
        hot-swap updates subsequent turns — in-flight calls continue on the prior model
      </div>
    </div>
  );
}

function ModelPicker({
  current,
  onPick,
}: {
  current: ModelRef;
  onPick: (m: ModelRef) => void;
}) {
  // Live catalog from opencode's /config/providers (via /api/swarm/
  // providers). Replaces the static modelCatalog.filter() approach so
  // adding a provider in opencode.json shows up here without a code edit.
  const { byTier, source } = useOpencodeProviders();
  const groups: Array<{ provider: Provider; label: string; hint: string }> = [
    { provider: 'zen', label: 'opencode zen', hint: 'premium routing, metered per token' },
    { provider: 'ollama', label: 'ollama max', hint: 'subscription bundle, $100/mo cap' },
    { provider: 'go', label: 'opencode go', hint: 'shared go-tier quota' },
    { provider: 'byok', label: 'bring your own key', hint: 'direct provider keys' },
  ];
  return (
    <div className="p-1 max-h-[360px] overflow-y-auto">
      {source === 'fallback' && (
        <div className="px-2 py-1 mb-1 font-mono text-[9.5px] uppercase tracking-widest2 text-amber/70 hairline-b">
          static catalog · opencode unreachable
        </div>
      )}
      {groups.map((g) => {
        const rows = byTier(g.provider);
        if (rows.length === 0) return null;
        return (
          <div key={g.provider} className="mb-1">
            <div className="px-2 pt-1.5 pb-0.5 flex items-center gap-2">
              <ProviderBadge provider={g.provider} size="sm" />
              <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-500">
                {g.label}
              </span>
            </div>
            <div className="px-2 pb-1 font-mono text-[9.5px] text-fog-700">{g.hint}</div>
            <ul className="space-y-0.5">
              {rows.map((m) => {
                const active = m.id === current.id;
                return (
                  <li key={m.id}>
                    <button
                      onClick={() => onPick(m)}
                      className={clsx(
                        'w-full px-2 py-1.5 rounded flex items-center gap-2 text-left transition',
                        active ? 'bg-ink-700' : 'hover:bg-ink-800',
                      )}
                    >
                      <span className="font-mono text-[11px] text-fog-100 truncate flex-1">
                        {m.label}
                      </span>
                      {m.limitTag && (
                        <span className="font-mono text-[9px] uppercase tracking-wider text-mint/80 shrink-0">
                          {m.limitTag}
                        </span>
                      )}
                      {m.pricing && (
                        <span className="font-mono text-[10px] text-fog-600 tabular-nums shrink-0">
                          ${m.pricing.input}/${m.pricing.output}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// v1.14 supplementary surfaces panel. Surfaces three opencode session-
// scoped surfaces that don't fit elsewhere in the inspector:
//   - /session/{id}/children : direct sub-sessions spawned via task tool
//   - /session/{id}/todo     : agent's own todowrite snapshot
//                              (cross-check vs blackboard plan)
//   - /session/{id}/summarize : manual compaction trigger
// Hidden when there's no opencode sessionID yet (ephemeral agents) or
// when the agent's workspace isn't known (mock fixtures).
function SessionInfoPanel({
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

function BudgetPanel({ agent }: { agent: Agent }) {
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
