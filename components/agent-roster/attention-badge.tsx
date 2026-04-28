'use client';

// Attention badge that appears on the right of an agent row when
// the agent has at least one error / pending permission / retry.
// The badge itself is just a 4-tall chip (glyph + count) tinted by
// the highest-severity item. Click opens a Popover with the full list
// — clicking a row jumps the timeline to that message.
//
// Lifted from agent-row.tsx 2026-04-28 — pulls AttentionKind + kindTone
// from ./_shared so the badge stays consistent with the table-level
// AttentionTable in the parent.

import clsx from 'clsx';
import type { AgentMessage } from '@/lib/swarm-types';
import { Popover } from '../ui/popover';
import { Tooltip } from '../ui/tooltip';
import { type Attention } from '@/lib/agent-status';
import { kindTone, type AttentionKind } from './_shared';

export function AttentionBadge({
  attention,
  onFocus,
}: {
  attention: Attention;
  onFocus: (id: string) => void;
}) {
  const total = attention.pending.length + attention.errors.length + attention.retries.length;
  if (total === 0) return null;

  const severity: AttentionKind =
    attention.errors.length > 0
      ? 'error'
      : attention.pending.length > 0
        ? 'pending'
        : 'retry';

  const tone =
    severity === 'error'
      ? { dot: 'bg-rust', ring: 'ring-rust/40', text: 'text-rust' }
      : severity === 'pending'
        ? { dot: 'bg-amber', ring: 'ring-amber/40', text: 'text-amber' }
        : { dot: 'bg-iris', ring: 'ring-iris/40', text: 'text-iris' };

  const rows: Array<{ msg: AgentMessage; kind: AttentionKind }> = [
    ...attention.errors.map((m) => ({ msg: m, kind: 'error' as const })),
    ...attention.pending.map((m) => ({ msg: m, kind: 'pending' as const })),
    ...attention.retries.map((m) => ({ msg: m, kind: 'retry' as const })),
  ];

  // Severity glyph clarifies what the badge means at a glance — earlier
  // shape showed just a digit (e.g. lone "1") which read as a generic
  // counter. Now: ⚠ for errors, ⏳ for pending, ↻ for retry — paired with
  // the tone color and the count.
  const glyph =
    severity === 'error' ? '!' : severity === 'pending' ? '?' : '↻';

  return (
    <span onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <Popover
        side="right"
        align="start"
        width={280}
        content={(close) => (
          <AttentionTable
            rows={rows}
            onPick={(id) => {
              onFocus(id);
              close();
            }}
          />
        )}
      >
        <Tooltip
          content={
            severity === 'error'
              ? `${total} item${total === 1 ? '' : 's'} need attention (errors)`
              : severity === 'pending'
                ? `${total} permission ${total === 1 ? 'request' : 'requests'} pending`
                : `${total} retry${total === 1 ? '' : ' attempts'} in progress`
          }
          side="top"
        >
          <span
            className={clsx(
              'shrink-0 inline-flex items-center gap-0.5 h-4 px-1 rounded-sm cursor-pointer',
              'hairline hover:ring-1 transition',
              tone.ring,
              tone.text,
            )}
          >
            <span className="font-mono text-[10px] leading-none">{glyph}</span>
            <span className="font-mono text-[9.5px] tabular-nums leading-none">
              {total}
            </span>
          </span>
        </Tooltip>
      </Popover>
    </span>
  );
}

function AttentionTable({
  rows,
  onPick,
}: {
  rows: Array<{ msg: AgentMessage; kind: AttentionKind }>;
  onPick: (msgId: string) => void;
}) {
  return (
    <div className="py-1">
      <div className="px-2 pt-1 pb-1.5 flex items-center gap-2">
        <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-500">
          needs attention
        </span>
        <span className="ml-auto font-mono text-[9.5px] tabular-nums text-fog-600">
          {rows.length}
        </span>
      </div>
      <ul className="hairline-t">
        {rows.map(({ msg, kind }) => {
          const tone = kindTone[kind];
          return (
            <li key={msg.id}>
              <button
                onClick={() => onPick(msg.id)}
                className="w-full grid grid-cols-[36px_1fr_auto] items-center gap-2 px-2 h-6 hover:bg-ink-800 transition text-left border-b border-ink-800 last:border-b-0"
              >
                <span
                  className={clsx(
                    'font-mono text-[9px] uppercase tracking-widest2',
                    tone.text,
                  )}
                >
                  {tone.label}
                </span>
                <span className="text-[11px] text-fog-200 truncate leading-none">
                  {msg.title}
                </span>
                <span className="font-mono text-[9.5px] tabular-nums text-fog-600">
                  {msg.timestamp}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
