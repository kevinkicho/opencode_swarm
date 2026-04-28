// Inspector subcomponents — message panel, agent panel, file-heat panel,
// plus shared atoms (EmptyState, AgentPill, ToolIconInline, Stat).
//
// Extracted from inspector.tsx in #108. The parent component owns the
// state-shape decision (which panel to render based on focus); this
// file owns the panels themselves.

import clsx from 'clsx';
import { useState } from 'react';
import type { Agent, AgentMessage, ModelRef, ToolName } from '@/lib/swarm-types';
import type { FileHeat } from '@/lib/opencode/transform';
import { ProviderBadge } from '../provider-badge';
import { Popover } from '../ui/popover';
import { toolIcon } from '../icons';
import { Tooltip } from '../ui/tooltip';
import { compact } from '@/lib/format';
import { partMeta, partHex, toolMeta, hueClass } from '@/lib/part-taxonomy';
import { MarkdownBody } from '../ui/markdown-body';

export function EmptyState() {
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

// AgentInspector + ModelSwapRow + ModelPicker + BudgetPanel moved to
// ./agent-inspector.tsx. Re-exported below
// for back-compat with sub-components.tsx import sites.
export { AgentInspector } from './agent-inspector';

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
export function FileHeatInspector({
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
