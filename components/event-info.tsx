'use client';

import clsx from 'clsx';
import type { Agent, AgentMessage } from '@/lib/swarm-types';
import { partMeta, partHex, toolMeta } from '@/lib/part-taxonomy';
import { Tooltip } from './ui/tooltip';
import { compact } from '@/lib/format';

const partDescription: Record<string, string> = {
  text: 'model text output or human prompt',
  reasoning: 'internal model thought (not shared across lanes)',
  tool: 'tool call + result',
  file: 'file attached or referenced',
  agent: 'reference to a sub-agent',
  subtask: 'delegated sub-work returning to parent',
  'step-start': 'checkpoint boundary (begin)',
  'step-finish': 'checkpoint boundary (end)',
  snapshot: 'captured working-tree state',
  patch: 'code change / diff',
  retry: 'retry marker',
  compaction: 'context was compacted',
};

const statusHue: Record<string, { text: string; dot: string }> = {
  complete: { text: 'text-mint', dot: 'bg-mint' },
  running: { text: 'text-molten', dot: 'bg-molten' },
  error: { text: 'text-rust', dot: 'bg-rust' },
  pending: { text: 'text-amber', dot: 'bg-amber' },
  abandoned: { text: 'text-fog-600', dot: 'bg-fog-700' },
};

export function EventInfo({
  msg,
  fromName,
  toNames,
  allMessages,
  agentMap,
  onNavigate,
}: {
  msg: AgentMessage;
  fromName: string;
  toNames: string[];
  allMessages: AgentMessage[];
  agentMap: Map<string, Agent>;
  onNavigate: (id: string) => void;
}) {
  const partHue = partHex[msg.part];
  const toolHue = msg.toolName ? toolMeta[msg.toolName].hex : null;
  const accent = toolHue ?? partHue;

  const parent = msg.relatesTo ? allMessages.find((m) => m.id === msg.relatesTo) : null;
  const children = allMessages.filter((m) => m.relatesTo === msg.id);
  const sibling = msg.threadId
    ? allMessages.filter(
        (m) => m.threadId === msg.threadId && m.id !== msg.id && m.id !== msg.relatesTo,
      )
    : [];

  const go = (id: string) => {
    onNavigate(id);
  };

  const isEdit = msg.toolName === 'edit' || msg.toolName === 'write' || msg.part === 'patch';
  const diffCounts = isEdit ? parseDiffCounts(msg.toolPreview) : null;

  return (
    <div className="w-[380px] max-h-[520px] overflow-y-auto code-scroll">
      <div
        className="relative px-3 py-2 hairline-b"
        style={{ boxShadow: `inset 0 2px 0 ${accent}` }}
      >
        <div className="flex items-center gap-1.5">
          <span
            className="font-mono text-[10px] uppercase tracking-widest2"
            style={{ color: partHue }}
          >
            {partMeta[msg.part].label}
          </span>
          {msg.toolName && (
            <span
              className="font-mono text-[10px] uppercase tracking-widest2 px-1 rounded border"
              style={{
                color: toolHue ?? '#888',
                borderColor: `${toolHue}55`,
                backgroundColor: `${toolHue}10`,
              }}
            >
              {msg.toolName}
            </span>
          )}
          {msg.permission && (
            <span
              className={clsx(
                'font-mono text-[10px] uppercase tracking-widest2 px-1 rounded border',
                msg.permission.state === 'asked' && 'text-amber border-amber/40 bg-amber/5',
                msg.permission.state === 'approved' && 'text-mint border-mint/40 bg-mint/5',
                msg.permission.state === 'denied' && 'text-rust border-rust/40 bg-rust/5',
              )}
            >
              permission {msg.permission.state}
            </span>
          )}
          <StatusPill status={msg.status} />
          <span className="ml-auto font-mono text-[10px] text-fog-600 tabular-nums">
            {msg.timestamp}
          </span>
        </div>
        <div className="mt-1 text-[12.5px] text-fog-100 leading-snug">{msg.title}</div>
        <div className="font-mono text-[9.5px] text-fog-700 mt-0.5 leading-snug">
          {partDescription[msg.part] ?? ''}
        </div>
      </div>

      <div className="px-3 py-1.5 hairline-b font-mono text-[10.5px] flex items-center gap-1.5 flex-wrap">
        <span className="text-fog-600 uppercase tracking-wider text-[9px]">from</span>
        <AgentChip name={fromName} />
        <span className="text-fog-700">into</span>
        {toNames.map((n, i) => (
          <AgentChip key={i} name={n} />
        ))}
      </div>

      {msg.body && (
        <div className="px-3 py-2 hairline-b">
          <div className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600 mb-1">
            body
          </div>
          <div className="text-[11.5px] text-fog-200 leading-snug whitespace-pre-wrap">
            {msg.body}
          </div>
        </div>
      )}

      {msg.toolName && <ToolPanel msg={msg} />}

      {isEdit && diffCounts && (
        <DiffPreview
          file={msg.toolSubtitle ?? 'unknown'}
          additions={diffCounts.add}
          deletions={diffCounts.del}
          summary={diffCounts.summary}
        />
      )}

      {(parent || children.length > 0 || sibling.length > 0) && (
        <div className="px-3 py-2 hairline-b">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600">
              reply chain
            </span>
            {msg.threadId && (
              <span className="font-mono text-[9px] text-fog-700">thread {msg.threadId}</span>
            )}
          </div>
          {parent && (
            <ChainGroup label="replies to">
              <ChainRow msg={parent} agentMap={agentMap} onClick={() => go(parent.id)} />
            </ChainGroup>
          )}
          {children.length > 0 && (
            <ChainGroup label="replied by">
              {children.map((c) => (
                <ChainRow key={c.id} msg={c} agentMap={agentMap} onClick={() => go(c.id)} />
              ))}
            </ChainGroup>
          )}
          {sibling.length > 0 && (
            <ChainGroup label="same thread">
              {sibling.slice(0, 3).map((s) => (
                <ChainRow
                  key={s.id}
                  msg={s}
                  agentMap={agentMap}
                  onClick={() => go(s.id)}
                  muted
                />
              ))}
            </ChainGroup>
          )}
        </div>
      )}

      <div className="px-3 py-1.5 grid grid-cols-[auto_auto_auto_1fr_auto] items-center gap-3 font-mono text-[10px] tabular-nums">
        {msg.tokens != null ? (
          <Tooltip content="tokens consumed on this call" side="top">
            <span className="text-fog-300 cursor-help">{compact(msg.tokens)}</span>
          </Tooltip>
        ) : (
          <span className="text-fog-800">-</span>
        )}
        {msg.cost != null ? (
          <Tooltip content="provider cost in usd" side="top">
            <span className="text-fog-300 cursor-help">${msg.cost.toFixed(3)}</span>
          </Tooltip>
        ) : (
          <span className="text-fog-800">-</span>
        )}
        {msg.duration ? (
          <Tooltip content="wall-clock duration" side="top">
            <span className="text-fog-300 cursor-help">{msg.duration}</span>
          </Tooltip>
        ) : (
          <span className="text-fog-800">-</span>
        )}
        <span />
        <Tooltip content="message id for deep link" side="top" align="end">
          <span className="text-fog-800 cursor-help">{msg.id}</span>
        </Tooltip>
      </div>
    </div>
  );
}

function ToolPanel({ msg }: { msg: AgentMessage }) {
  if (!msg.toolName) return null;
  const m = toolMeta[msg.toolName];
  const isBash = msg.toolName === 'bash';
  const isFetch = msg.toolName === 'webfetch';
  const isTask = msg.toolName === 'task';

  return (
    <div className="hairline-b">
      <div
        className="px-3 py-1.5 flex items-center gap-2 hairline-b"
        style={{ boxShadow: `inset 2px 0 0 ${m.hex}` }}
      >
        <span
          className="font-mono text-[10px] uppercase tracking-widest2"
          style={{ color: m.hex }}
        >
          {m.label}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-wider text-fog-700">
          {isBash
            ? 'shell exec'
            : isFetch
              ? 'http fetch'
              : isTask
                ? 'delegate to sub-agent'
                : 'tool call'}
        </span>
        {msg.toolState && (
          <span className="ml-auto font-mono text-[9px] uppercase tracking-widest2 text-fog-600">
            {msg.toolState}
          </span>
        )}
      </div>
      {msg.toolSubtitle && (
        <div className="px-3 py-1.5 hairline-b">
          <div className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600 mb-0.5">
            {isBash ? 'cmd' : isFetch ? 'url' : isTask ? 'invocation' : 'target'}
          </div>
          <pre className="font-mono text-[11px] text-fog-200 whitespace-pre-wrap break-all leading-snug">
            {msg.toolSubtitle}
          </pre>
        </div>
      )}
      {msg.toolPreview && (
        <div className="px-3 py-1.5">
          <div className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600 mb-0.5">
            {isBash ? 'stdout' : 'response'}
          </div>
          <pre
            className={clsx(
              'font-mono text-[11px] whitespace-pre-wrap break-words leading-snug',
              msg.status === 'error' ? 'text-rust' : 'text-fog-300',
            )}
          >
            {msg.toolPreview}
          </pre>
        </div>
      )}
    </div>
  );
}

function DiffPreview({
  file,
  additions,
  deletions,
  summary,
}: {
  file: string;
  additions: number;
  deletions: number;
  summary: string;
}) {
  const total = additions + deletions;
  const addPct = total === 0 ? 0 : (additions / total) * 100;
  return (
    <div className="hairline-b bg-ink-900/30">
      <div className="px-3 py-1.5 flex items-center gap-2 hairline-b">
        <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600">
          diff preview
        </span>
        <span className="font-mono text-[10.5px] text-fog-300 truncate flex-1 min-w-0">
          {file}
        </span>
        <span className="font-mono text-[10px] text-mint tabular-nums">+{additions}</span>
        <span className="font-mono text-[10px] text-rust tabular-nums">-{deletions}</span>
      </div>
      <div className="px-3 py-1.5">
        <div className="relative h-1 bg-ink-900 rounded-full overflow-hidden flex">
          <div className="h-full bg-mint/70" style={{ width: `${addPct}%` }} />
          <div className="h-full bg-rust/70" style={{ width: `${100 - addPct}%` }} />
        </div>
        {summary && (
          <div className="mt-1.5 text-[11px] text-fog-400 leading-snug">{summary}</div>
        )}
      </div>
    </div>
  );
}

function ChainGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5 last:mb-0">
      <div className="font-mono text-[8.5px] uppercase tracking-widest2 text-fog-700 mb-0.5 pl-[14px]">
        {label}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function ChainRow({
  msg,
  agentMap,
  onClick,
  muted,
}: {
  msg: AgentMessage;
  agentMap: Map<string, Agent>;
  onClick: () => void;
  muted?: boolean;
}) {
  const fromName =
    msg.fromAgentId === 'human' ? 'human' : agentMap.get(msg.fromAgentId)?.name ?? msg.fromAgentId;
  const color = msg.toolName ? toolMeta[msg.toolName].hex : partHex[msg.part];
  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full h-6 grid grid-cols-[8px_54px_1fr_64px_40px] items-center gap-2 text-left px-2 rounded hairline bg-ink-800/60 hover:border-fog-400/40 hover:bg-ink-800 transition',
        muted && 'opacity-60 hover:opacity-100',
      )}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
      <span className="font-mono text-[9.5px] uppercase tracking-wider text-fog-500 truncate">
        {msg.toolName ?? msg.part}
      </span>
      <span className="text-[11px] text-fog-200 truncate text-left" dir="ltr">
        {msg.title}
      </span>
      <span className="font-mono text-[9.5px] text-fog-600 truncate text-right">{fromName}</span>
      <span className="font-mono text-[9.5px] text-fog-700 tabular-nums text-right">
        {msg.timestamp}
      </span>
    </button>
  );
}

function AgentChip({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center h-[18px] px-1.5 rounded border border-ink-600 bg-ink-800 font-mono text-[10px] text-fog-200">
      {name}
    </span>
  );
}

function StatusPill({ status }: { status: AgentMessage['status'] }) {
  const hue = statusHue[status] ?? statusHue.complete;
  return (
    <Tooltip content={`delivery ${status}`} side="top">
      <span
        className={clsx(
          'inline-flex items-center gap-1 h-4 px-1 rounded font-mono text-[9px] uppercase tracking-widest2 cursor-help',
          hue.text,
        )}
      >
        <span className={clsx('w-1 h-1 rounded-full', hue.dot)} />
        {status}
      </span>
    </Tooltip>
  );
}

function parseDiffCounts(preview?: string): { add: number; del: number; summary: string } | null {
  if (!preview) return null;
  const m = preview.match(/\+?\s*(\d+)\s*[-]\s*(\d+)\s*(.*)$/);
  if (!m) return null;
  return {
    add: parseInt(m[1], 10),
    del: parseInt(m[2], 10),
    summary: m[3].trim(),
  };
}
