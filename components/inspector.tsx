'use client';

import clsx from 'clsx';
import { useState } from 'react';
import type { Agent, AgentMessage, ModelRef, ToolName } from '@/lib/swarm-types';
import type { FileHeat } from '@/lib/opencode/transform';
import { ProviderBadge } from './provider-badge';
import { Popover } from './ui/popover';
import { toolIcon } from './icons';
import { Tooltip } from './ui/tooltip';
import { compact } from '@/lib/format';
import { partMeta, partHex, toolMeta, hueClass } from '@/lib/part-taxonomy';
import { modelCatalog } from '@/lib/model-catalog';

export function Inspector({
  agents,
  messages,
  focusedMessageId,
  selectedAgentId,
  selectedFileHeat,
  workspace,
  onFocus,
  embedded,
}: {
  agents: Agent[];
  messages: AgentMessage[];
  focusedMessageId: string | null;
  selectedAgentId: string | null;
  // Selected row on the heat rail — opens the file-inspector panel.
  // Takes priority only when no message / agent is focused (so a mid-run
  // timeline click doesn't get stomped by a lingering heat selection).
  selectedFileHeat: FileHeat | null;
  // Workspace root for stripping the prefix from displayed paths. Same
  // source as the heat rail uses.
  workspace: string;
  onFocus: (id: string) => void;
  embedded?: boolean;
}) {
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const msg = messages.find((m) => m.id === focusedMessageId);
  const selectedAgent = selectedAgentId ? agentMap.get(selectedAgentId) : undefined;

  const body = (
    <div className={clsx('space-y-3', embedded ? 'p-4' : 'p-3')}>
      {msg ? (
        <MessageInspector msg={msg} agents={agentMap} messages={messages} onFocus={onFocus} />
      ) : selectedAgent ? (
        <AgentInspector agent={selectedAgent} messages={messages} onFocus={onFocus} />
      ) : selectedFileHeat ? (
        <FileHeatInspector
          heat={selectedFileHeat}
          workspace={workspace}
          agents={agents}
        />
      ) : (
        <EmptyState />
      )}
    </div>
  );

  if (embedded) return body;

  return (
    <aside className="w-[340px] shrink-0 hairline-l bg-ink-850 flex flex-col min-h-0">
      <div className="h-10 hairline-b px-4 flex items-center gap-3 bg-ink-850/80 backdrop-blur">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          inspector
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">{body}</div>
    </aside>
  );
}

function EmptyState() {
  return (
    <div className="rounded-md hairline bg-ink-800/40 p-4 text-center">
      <div className="font-display italic text-[18px] text-fog-500 leading-tight">
        nothing selected
      </div>
      <div className="mt-2 font-mono text-micro text-fog-700 leading-relaxed opacity-20">
        click a message arrow or agent lane to inspect<br/>
        handoff tool calls tokens cost
      </div>
    </div>
  );
}

function MessageInspector({
  msg,
  agents,
  messages,
  onFocus,
}: {
  msg: AgentMessage;
  agents: Map<string, Agent>;
  messages: AgentMessage[];
  onFocus: (id: string) => void;
}) {
  const from = msg.fromAgentId === 'human' ? null : agents.get(msg.fromAgentId) ?? null;
  const toAgents = msg.toAgentIds.map((id) => (id === 'human' ? null : agents.get(id) ?? null));
  const relates = msg.relatesTo ? messages.find((m) => m.id === msg.relatesTo) : null;

  const partInfo = partMeta[msg.part];
  const toolInfo = msg.toolName ? toolMeta[msg.toolName] : null;
  const headerLabel = toolInfo?.label ?? partInfo.label;
  const headerHex = toolInfo?.hex ?? partHex[msg.part];

  return (
    <div className="space-y-3 animate-fade-up">
      <div className="rounded-md hairline bg-ink-800 p-3">
        <div className="flex items-center gap-2 mb-2">
          <span
            className="font-mono text-micro uppercase tracking-widest2"
            style={{ color: headerHex }}
          >
            {headerLabel}
          </span>
          {toolInfo && (
            <span className="font-mono text-micro uppercase tracking-wider text-fog-600">
              {partInfo.label}
            </span>
          )}
          <span className="ml-auto font-display italic text-[13px] text-fog-500">
            {msg.timestamp}
          </span>
        </div>
        <h3 className="text-[14px] text-fog-100 leading-snug">{msg.title}</h3>
        {msg.body && (
          <p className="mt-2 text-[12.5px] text-fog-300 leading-relaxed">{msg.body}</p>
        )}
        <div className="mt-2 font-mono text-micro text-fog-600">{partInfo.blurb}</div>
      </div>

      <div className="rounded-md hairline bg-ink-800 overflow-hidden">
        <div className="px-3 h-8 flex items-center hairline-b">
          <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
            route
          </span>
        </div>

        <div className="p-3 space-y-2.5">
          <AgentPill agent={from} direction="from" />
          <div className="flex items-center gap-2">
            <span className="flex-1 h-px bg-gradient-to-r from-transparent via-fog-700 to-transparent" />
            <span className="font-mono text-micro uppercase tracking-wider text-fog-600">
              via {headerLabel}
            </span>
            <span className="flex-1 h-px bg-gradient-to-r from-transparent via-fog-700 to-transparent" />
          </div>
          {toAgents.map((a, i) => (
            <AgentPill key={a?.id ?? `to-${i}`} agent={a} direction="to" />
          ))}
        </div>
      </div>

      {msg.permission && (
        <PermissionPanel permission={msg.permission} />
      )}

      {msg.toolName && (
        <ToolPanel
          toolName={msg.toolName}
          state={msg.toolState}
          subtitle={msg.toolSubtitle}
          preview={msg.toolPreview}
        />
      )}

      <div className="rounded-md hairline bg-ink-800 p-3 grid grid-cols-2 gap-y-2 gap-x-3">
        <Stat label="tokens" value={compact(msg.tokens)} />
        <Stat label="cost" value={msg.cost != null ? `$${msg.cost.toFixed(3)}` : '-'} />
        <Stat label="duration" value={msg.duration ?? '-'} />
        <Stat label="status" value={msg.status} statusTone={msg.status} />
      </div>

      {relates && (
        <button
          onClick={() => onFocus(relates.id)}
          className="w-full rounded-md hairline bg-ink-800/40 p-3 text-left hover:bg-ink-800 transition"
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
              in reply to
            </span>
            <span className="ml-auto font-display italic text-[12.5px] text-fog-500">
              {relates.timestamp}
            </span>
          </div>
          <div className="text-[12.5px] text-fog-200 truncate">{relates.title}</div>
        </button>
      )}

      {/*
        Per-message "intervene" panel was removed in April 2026 — the four
        buttons (branch-from-here, pause-sender, reroute-to-haiku, drop-&-redo)
        were unwired. Per DESIGN.md §9, palette and inspector placeholders are
        reintroduced wired, not as stubs. Real paths when we build them:
          branch-from-here → session.revert({ messageID }) + session.children
          pause-sender     → session.abort on sender's sessionID
          reroute-to-haiku → no direct mapping (opencode auto-picks models)
          drop-&-redo      → session.revert to parent + re-prompt
      */}
    </div>
  );
}

function PermissionPanel({
  permission,
}: {
  permission: NonNullable<AgentMessage['permission']>;
}) {
  const tone =
    permission.state === 'asked'
      ? hueClass.amber
      : permission.state === 'approved'
        ? hueClass.mint
        : hueClass.rust;
  return (
    <div className={clsx('rounded-md border p-3 space-y-1', tone.border, tone.bg)}>
      <div className="flex items-center gap-2">
        <span className={clsx('font-mono text-micro uppercase tracking-widest2', tone.text)}>
          permission.{permission.state}
        </span>
        <span className="ml-auto font-mono text-micro text-fog-600">
          tool {permission.tool}
        </span>
      </div>
      <div className="font-mono text-[11px] text-fog-500">
        {permission.state === 'asked'
          ? 'waiting for operator approval before this tool runs'
          : permission.state === 'approved'
            ? 'operator approved the call, tool proceeded'
            : 'operator denied the call, tool did not run'}
      </div>
    </div>
  );
}

function ToolPanel({
  toolName,
  state,
  subtitle,
  preview,
}: {
  toolName: ToolName;
  state?: AgentMessage['toolState'];
  subtitle?: string;
  preview?: string;
}) {
  const meta = toolMeta[toolName];
  return (
    <div className="rounded-md hairline bg-ink-800 p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <ToolIconInline kind={toolName} />
        <span
          className="font-mono text-micro uppercase tracking-widest2"
          style={{ color: meta.hex }}
        >
          {meta.label}
        </span>
        {state && (
          <span className="ml-auto font-mono text-micro uppercase tracking-wider text-fog-600">
            {state}
          </span>
        )}
      </div>
      <div className="font-mono text-[10.5px] text-fog-600 mb-1.5">{meta.blurb}</div>
      {subtitle && (
        <div className="font-mono text-[12px] text-fog-200 break-all">{subtitle}</div>
      )}
      {preview && (
        <div className="mt-1 font-mono text-[11.5px] text-fog-500">{preview}</div>
      )}
    </div>
  );
}

function AgentInspector({
  agent,
  messages,
  onFocus,
}: {
  agent: Agent;
  messages: AgentMessage[];
  onFocus: (id: string) => void;
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
  const groups: Array<{ provider: 'zen' | 'go' | 'byok'; label: string; hint: string }> = [
    { provider: 'zen', label: 'opencode zen', hint: 'premium routing, metered per token' },
    { provider: 'go', label: 'opencode go', hint: 'shared go-tier quota' },
    { provider: 'byok', label: 'bring your own key', hint: 'direct provider keys' },
  ];
  return (
    <div className="p-1 max-h-[360px] overflow-y-auto">
      {groups.map((g) => {
        const rows = modelCatalog.filter((m) => m.provider === g.provider);
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

function AgentPill({ agent, direction }: { agent: Agent | null; direction: 'from' | 'to' }) {
  if (!agent) {
    return (
      <div className="relative border border-ink-600 bg-ink-700 px-2.5 py-1.5 pl-3">
        <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-fog-500" />
        <div className="text-[12.5px] text-fog-100">human operator</div>
        <div className="font-mono text-micro uppercase tracking-wider text-fog-600">
          {direction}
        </div>
      </div>
    );
  }
  return (
    <div className="relative border border-ink-600 bg-ink-700/60 px-2.5 py-1.5 pl-3">
      <span
        className={clsx(
          'absolute left-0 top-0 bottom-0 w-[2px]',
          agent.accent === 'molten' && 'bg-molten',
          agent.accent === 'mint' && 'bg-mint',
          agent.accent === 'iris' && 'bg-iris',
          agent.accent === 'amber' && 'bg-amber',
          agent.accent === 'fog' && 'bg-fog-500'
        )}
      />
      <div className="text-[12.5px] text-fog-100 truncate">
        {agent.name}
        {agent.focus && (
          <span className="ml-1.5 font-mono text-[10.5px] text-fog-500">
            {agent.focus}
          </span>
        )}
      </div>
      <div className="mt-0.5">
        <ProviderBadge provider={agent.model.provider} label={agent.model.label} size="sm" clickable />
      </div>
    </div>
  );
}

function ToolIconInline({ kind }: { kind: string }) {
  const Icon = toolIcon(kind);
  return (
    <span className="w-5 h-5 rounded grid place-items-center bg-ink-900 hairline text-fog-300">
      <Icon size={11} />
    </span>
  );
}

function Stat({
  label,
  value,
  statusTone,
}: {
  label: string;
  value: string;
  statusTone?: string;
}) {
  const tone =
    statusTone === 'error'
      ? 'text-rust'
      : statusTone === 'complete'
        ? 'text-mint'
        : statusTone === 'running'
          ? 'text-molten'
          : 'text-fog-100';
  return (
    <div>
      <div className="font-mono text-micro uppercase tracking-widest2 text-fog-700">{label}</div>
      <div className={clsx('font-mono text-[12.5px] tabular-nums mt-0.5', tone)}>{value}</div>
    </div>
  );
}

// Selection from the heat rail (stigmergy v0) — a file, not a message
// or agent. Shows what the swarm did to this file: how many times it
// was edited, which agents touched it, when, and the full workspace-
// absolute path. No "jump to" affordance yet — patches aren't
// individually addressable in the timeline, so there's nowhere to jump.
function FileHeatInspector({
  heat,
  workspace,
  agents,
}: {
  heat: FileHeat;
  workspace: string;
  agents: Agent[];
}) {
  // Reverse sessionID → agent map (see heat-rail for the same pattern).
  const agentBySession = new Map<string, Agent>();
  for (const a of agents) if (a.sessionID) agentBySession.set(a.sessionID, a);
  const np = heat.path.replace(/\\/g, '/').replace(/\/+$/, '');
  const nw = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
  const relPath = nw && np.startsWith(nw + '/') ? np.slice(nw.length + 1) : np;
  const lastSlash = relPath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? relPath.slice(0, lastSlash + 1) : '';
  const base = lastSlash >= 0 ? relPath.slice(lastSlash + 1) : relPath;

  const touchers = heat.sessionIDs
    .map((sid) => agentBySession.get(sid))
    .filter((a): a is Agent => !!a);

  const lastTouchedAgo = (() => {
    const diff = Date.now() - heat.lastTouchedMs;
    if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))} seconds ago`;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)} minutes ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} hours ago`;
    return `${Math.round(diff / 86_400_000)} days ago`;
  })();

  return (
    <div className="space-y-3">
      {/* Eyebrow — what this panel is showing. Matches the pattern used
          by the other inspector bodies. */}
      <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
        file · heat
      </div>

      {/* Path — basename prominent, dir dim. Wraps across lines so long
          paths don't force horizontal scroll inside the drawer. */}
      <div className="font-mono text-[13px] leading-snug break-all">
        {dir && <span className="text-fog-700">{dir}</span>}
        <span className="text-fog-100">{base}</span>
      </div>

      {/* Stats row — edit count, distinct sessions, last touched. */}
      <div className="grid grid-cols-2 gap-2">
        <Stat label="edits" value={String(heat.editCount)} statusTone={undefined} />
        <Stat
          label="sessions"
          value={`${heat.distinctSessions}`}
          statusTone={undefined}
        />
      </div>

      {/* Last touched with absolute timestamp on hover. */}
      <div>
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-700">
          last touched
        </div>
        <Tooltip content={new Date(heat.lastTouchedMs).toISOString()} side="top">
          <div className="font-mono text-[12px] text-fog-300 mt-0.5 cursor-default">
            {lastTouchedAgo}
          </div>
        </Tooltip>
      </div>

      {/* Agents that touched this file. Badges match the roster accent. */}
      {touchers.length > 0 && (
        <div>
          <div className="font-mono text-micro uppercase tracking-widest2 text-fog-700 mb-1">
            touched by
          </div>
          <ul className="flex flex-col gap-1">
            {touchers.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-2 font-mono text-[11.5px]"
              >
                <span
                  className={clsx(
                    'w-3 h-3 rounded-sm font-mono text-[8.5px] leading-none grid place-items-center',
                    'bg-' + a.accent + '/15 text-' + a.accent,
                  )}
                >
                  {a.glyph}
                </span>
                <span className="text-fog-200">{a.name}</span>
                <span className="text-fog-700">·</span>
                <span className="text-fog-500">{a.model.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Absolute path — the full workspace-prefixed string, dim so it
          reads as reference. */}
      <div className="pt-1 hairline-t">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-700 mb-1">
          absolute
        </div>
        <div className="font-mono text-[10.5px] text-fog-600 break-all leading-snug">
          {heat.path}
        </div>
      </div>
    </div>
  );
}
