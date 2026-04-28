// MessageInspector + its private helpers (PermissionPanel, ToolPanel,
// AgentPill, ToolIconInline, Stat).
//
// Lifted from inspector/sub-components.tsx 2026-04-28. The message
// panel is the load-bearing inspector body — header chip + body markdown
// + route (from/via/to pills) + optional permission + optional tool
// detail + a 4-stat grid + relates-to back-reference.

import clsx from 'clsx';
import type { Agent, AgentMessage, ToolName } from '@/lib/swarm-types';
import { Tooltip } from '../ui/tooltip';
import { toolIcon } from '../icons';
import { compact } from '@/lib/format';
import { partMeta, partHex, toolMeta, hueClass } from '@/lib/part-taxonomy';
import { MarkdownBody } from '../ui/markdown-body';

export function MessageInspector({
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
          <div className="mt-2">
            <MarkdownBody text={msg.body} tone="fog-300" />
          </div>
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
          {/*
            Internal-only parts (reasoning, step-start, step-finish) have
            no real recipient — they're the model's own thinking + opencode's
            turn bookkeeping. Showing "TO: human operator" was misleading
            (the user reads it as "agent talking to human" when it's
            actually agent talking to itself). Hide the recipient pills
            for these part kinds; keep them for text / tool / patch / agent
            / subtask where the recipient is meaningful.
          */}
          {msg.part !== 'reasoning' &&
            msg.part !== 'step-start' &&
            msg.part !== 'step-finish' &&
            toAgents.map((a, i) => (
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
      <div className="font-mono text-micro uppercase tracking-wider text-fog-600">
        {direction}
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
