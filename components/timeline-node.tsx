'use client';

import clsx from 'clsx';
import { useState, useEffect } from 'react';
import type { TimelineNode, NodeStatus } from '@/lib/types';
import { compact } from '@/lib/format';
import { DiffView } from './diff-view';
import {
  IconUser,
  IconThinking,
  IconAgent,
  IconDecision,
  IconMilestone,
  IconChevronDown,
  IconBranch,
  toolIcon,
} from './icons';

const kindMeta: Record<
  string,
  { label: string; accent: string; bg: string; border: string; IconCmp: any }
> = {
  user: { label: 'user', accent: 'text-fog-200', bg: 'bg-ink-700', border: 'border-ink-500', IconCmp: IconUser },
  thinking: { label: 'thinking', accent: 'text-iris', bg: 'bg-iris/5', border: 'border-iris/20', IconCmp: IconThinking },
  agent: { label: 'agent', accent: 'text-iris', bg: 'bg-iris/5', border: 'border-iris/25', IconCmp: IconAgent },
  decision: { label: 'decision', accent: 'text-molten', bg: 'bg-molten/5', border: 'border-molten/25', IconCmp: IconDecision },
  milestone: { label: 'done', accent: 'text-mint', bg: 'bg-mint/5', border: 'border-mint/25', IconCmp: IconMilestone },
};

const toolAccent: Record<string, string> = {
  read: 'text-fog-300',
  edit: 'text-molten',
  write: 'text-molten',
  bash: 'text-mint',
  grep: 'text-fog-300',
  glob: 'text-fog-300',
  webfetch: 'text-fog-300',
};

function StatusMarker({ status }: { status: NodeStatus }) {
  if (status === 'running') {
    return (
      <span className="relative flex w-3 h-3 items-center justify-center">
        <span className="absolute inset-0 rounded-full bg-molten animate-pulse-ring" />
        <span className="w-1.5 h-1.5 rounded-full bg-molten" />
      </span>
    );
  }
  const color: Record<string, string> = {
    complete: 'bg-mint',
    error: 'bg-rust',
    abandoned: 'bg-ink-400',
    pending: 'bg-fog-700',
  };
  return (
    <span className="relative flex w-3 h-3 items-center justify-center">
      <span
        className={clsx(
          'w-[7px] h-[7px] rounded-full',
          color[status],
          status === 'abandoned' && 'opacity-40'
        )}
      />
      {status === 'complete' && (
        <span className="absolute inset-0 rounded-full ring-1 ring-mint/20" />
      )}
    </span>
  );
}

export function TimelineNodeCard({
  node,
  focused,
  onFocus,
  nested,
}: {
  node: TimelineNode;
  focused: boolean;
  onFocus: (id: string) => void;
  nested?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (focused) setOpen(true);
  }, [focused]);

  const isTool = node.kind === 'tool';
  const meta = isTool
    ? {
        label: node.toolKind ?? 'tool',
        accent: toolAccent[node.toolKind ?? ''] ?? 'text-fog-300',
        IconCmp: toolIcon(node.toolKind),
        border: 'border-ink-600',
        bg: 'bg-ink-800',
      }
    : kindMeta[node.kind];

  const Icon = meta.IconCmp;

  const hasExpandable =
    node.diff || node.bashOutput || node.thinking || node.branch;

  return (
    <div
      className={clsx(
        'relative flex gap-3 pl-6 pr-1 py-2 group animate-fade-up',
        nested && 'pl-10'
      )}
    >
      {/* trunk line for this row */}
      <div
        className={clsx(
          'absolute top-0 bottom-0 w-px',
          nested ? 'left-[26px] bg-iris/15' : 'left-[9px] bg-ink-600'
        )}
      />

      {/* status marker on trunk */}
      <div
        className={clsx(
          'absolute top-[18px] z-10 -translate-x-1/2',
          nested ? 'left-[26px]' : 'left-[9px]'
        )}
      >
        <StatusMarker status={node.status} />
      </div>

      {/* horizontal tick from trunk to card */}
      <div
        className={clsx(
          'absolute top-[22px] h-px',
          nested
            ? 'left-[26px] w-3 bg-iris/20'
            : 'left-[9px] w-3 bg-ink-600'
        )}
      />

      <div className="flex-1 min-w-0">
        <button
          onClick={() => {
            onFocus(node.id);
            if (hasExpandable) setOpen(!open);
          }}
          className={clsx(
            'w-full text-left rounded-md transition overflow-hidden',
            'hairline bg-ink-800 hover:border-ink-500',
            focused && 'border-molten/40 shadow-glow-molten',
            node.status === 'running' && 'border-molten/30',
            node.status === 'abandoned' && 'opacity-50 hover:opacity-80',
            node.kind === 'decision' && 'border-molten/25 bg-molten/5',
            node.kind === 'milestone' && 'border-mint/30 bg-mint/5',
            node.kind === 'agent' && 'border-iris/25 bg-iris/5',
            node.kind === 'thinking' && 'border-iris/15 bg-iris/[0.03]'
          )}
        >
          <div className="flex items-start gap-2.5 px-3 py-2">
            <div
              className={clsx(
                'shrink-0 w-6 h-6 rounded grid place-items-center',
                meta.bg,
                'border',
                meta.border,
                meta.accent
              )}
            >
              <Icon size={12} />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={clsx(
                    'font-mono text-micro uppercase tracking-widest2',
                    meta.accent
                  )}
                >
                  {meta.label}
                </span>

                {node.kind === 'tool' && (
                  <span className="font-mono text-[12px] text-fog-100">{node.title}</span>
                )}
                {node.kind !== 'tool' && (
                  <span className="text-[13px] text-fog-100 leading-tight">
                    {node.title}
                  </span>
                )}

                {node.subtitle && node.kind === 'tool' && (
                  <span className="font-mono text-[11.5px] text-fog-400 truncate min-w-0">
                    {node.subtitle}
                  </span>
                )}

                <span className="ml-auto flex items-center gap-2 shrink-0">
                  {node.duration && (
                    <span className="font-mono text-micro text-fog-700">{node.duration}</span>
                  )}
                  {node.tokens && (
                    <span className="font-mono text-micro text-fog-700">
                      {compact(node.tokens)}
                    </span>
                  )}
                  <span className="font-display italic text-[13px] text-fog-600">
                    {node.timestamp}
                  </span>
                </span>
              </div>

              {node.subtitle && node.kind !== 'tool' && (
                <div className="mt-0.5 text-[12px] text-fog-400">{node.subtitle}</div>
              )}

              {node.preview && !open && (
                <div
                  className={clsx(
                    'mt-1 text-[11.5px]',
                    node.kind === 'agent' && 'text-iris/90',
                    node.kind === 'decision' && 'text-molten/90',
                    node.kind === 'milestone' && 'text-mint/90',
                    node.status === 'error' && 'text-rust',
                    !['agent', 'decision', 'milestone'].includes(node.kind) &&
                      node.status !== 'error' &&
                      'text-fog-500'
                  )}
                >
                  {node.preview}
                </div>
              )}
            </div>
          </div>

          {open && hasExpandable && (
            <div className="px-3 pb-3 pt-0 space-y-2.5 animate-fade-up">
              {node.thinking && (
                <div className="rounded bg-ink-900/60 hairline p-3">
                  <div className="font-mono text-micro uppercase tracking-widest2 text-iris/70 mb-1.5">
                    reasoning
                  </div>
                  <p className="font-display italic text-[13.5px] leading-relaxed text-fog-300">
                    {node.thinking}
                  </p>
                </div>
              )}

              {node.diff && <DiffView diff={node.diff} />}

              {node.bashOutput && (
                <div className="rounded bg-ink-900 hairline overflow-hidden">
                  {node.bashCommand && (
                    <div className="flex items-center gap-2 px-3 h-7 hairline-b bg-ink-850/60">
                      <span className="text-mint font-mono text-micro">$</span>
                      <span className="font-mono text-2xs text-fog-200">
                        {node.bashCommand}
                      </span>
                      <span
                        className={clsx(
                          'ml-auto font-mono text-micro uppercase tracking-widest2',
                          node.status === 'error' ? 'text-rust' : 'text-mint'
                        )}
                      >
                        {node.status === 'error' ? 'exit 1' : 'exit 0'}
                      </span>
                    </div>
                  )}
                  <pre className="font-mono text-[11.5px] leading-[1.6] text-fog-300 p-3 whitespace-pre-wrap code-scroll overflow-x-auto">
                    {node.bashOutput}
                  </pre>
                </div>
              )}

              {node.branch && (
                <BranchPanel branch={node.branch} />
              )}
            </div>
          )}
        </button>
      </div>
    </div>
  );
}

function BranchPanel({
  branch,
}: {
  branch: NonNullable<TimelineNode['branch']>;
}) {
  return (
    <div className="rounded bg-ink-900/60 hairline p-3 space-y-3">
      <div className="flex items-center gap-2">
        <IconBranch size={13} className="text-molten" />
        <span className="font-mono text-micro uppercase tracking-widest2 text-molten">
          two approaches considered
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded bg-mint/5 border border-mint/20 p-2.5">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-mint" />
            <span className="font-mono text-micro uppercase tracking-widest2 text-mint">
              chosen
            </span>
          </div>
          <p className="text-[12px] text-fog-200 leading-snug">{branch.chosenLabel}</p>
        </div>

        <div className="rounded bg-ink-800/60 border border-ink-600 p-2.5 opacity-75">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-ink-400" />
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
              abandoned
            </span>
          </div>
          <p className="text-[12px] text-fog-400 line-through decoration-ink-500 decoration-1 leading-snug">
            {branch.abandonedLabel}
          </p>
          <p className="mt-1.5 text-[11.5px] text-fog-500 leading-snug">
            <span className="font-mono text-micro text-fog-700 uppercase tracking-wider">
              why -
            </span>{' '}
            {branch.abandonedReason}
          </p>
        </div>
      </div>
    </div>
  );
}
