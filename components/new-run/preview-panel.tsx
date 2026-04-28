'use client';

// Right-column preview panel for the new-run modal.
//
// Read-only summary of the in-flight form state — source / workspace /
// pattern / team / bounds / branches / start, plus the team lineup and
// "what this writes" footer. When the user hasn't entered a directive
// yet, also surfaces the substrate-inference block (likely focus,
// hotspots, open work) so they can see what the swarm will infer
// without having to write prose.
//
// Extracted from new-run-modal.tsx 2026-04-28 — pure render, no own
// state. Lifted because the panel is ~165 lines of read-only display
// markup that the modal body doesn't need to re-read every time the
// form shape evolves; isolating it shrinks the modal's render block by
// ~17%.

import clsx from 'clsx';
import { Tooltip } from '../ui/tooltip';
import { patternMeta, patternAccentText } from '@/lib/swarm-patterns';
import { familyMeta } from '@/lib/zen-catalog';
import type { ProviderModel } from '@/app/api/swarm/providers/route';
import type { SwarmPattern } from '@/lib/swarm-types';
import type { BranchStrategy, StartMode } from './helpers';
import { inferred } from './helpers';
import { LabelRow, InferBlock } from './sub-components';

export interface PreviewPanelProps {
  sourceValue: string;
  cloneTarget: string;
  pattern: SwarmPattern;
  totalAgents: number;
  unbounded: boolean;
  costCap: number;
  minutesCap: number;
  branchStrategy: BranchStrategy;
  branchName: string;
  startMode: StartMode;
  teamRows: Array<{ model: ProviderModel; count: number }>;
  hasDirective: boolean;
}

export function PreviewPanel({
  sourceValue,
  cloneTarget,
  pattern,
  totalAgents,
  unbounded,
  costCap,
  minutesCap,
  branchStrategy,
  branchName,
  startMode,
  teamRows,
  hasDirective,
}: PreviewPanelProps) {
  return (
    <aside className="min-w-0 flex flex-col gap-3">
      <div>
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 mb-2">
          preview
        </div>
        <div className="relative rounded-md hairline bg-ink-900/60 overflow-hidden border border-molten/30">
          <div className="h-[3px] w-full bg-molten/70" />
          <div className="p-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-molten" />
              <span
                className={clsx(
                  'text-[13px] truncate flex-1 min-w-0 font-mono',
                  sourceValue.trim() ? 'text-fog-100' : 'text-fog-700 italic'
                )}
              >
                {sourceValue.trim() || 'source not set'}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
                github
              </span>
            </div>

            <div className="pt-1 hairline-t">
              <LabelRow label="workspace">
                <span
                  className={clsx(
                    'font-mono text-[10.5px] truncate max-w-[200px]',
                    cloneTarget ? 'text-mint' : 'text-fog-700 italic'
                  )}
                  title={cloneTarget || undefined}
                >
                  {cloneTarget || 'unset'}
                </span>
              </LabelRow>
              <LabelRow label="pattern">
                <span
                  className={clsx(
                    'font-mono text-[11px]',
                    patternAccentText[patternMeta[pattern].accent]
                  )}
                >
                  {patternMeta[pattern].label}
                </span>
              </LabelRow>
              <LabelRow label="team">
                <span className="font-mono text-[11px] text-fog-200 tabular-nums">
                  {totalAgents || '—'}
                </span>
                {totalAgents > 0 && (
                  <span className="font-mono text-[10px] text-fog-600">
                    agents
                  </span>
                )}
              </LabelRow>
              <LabelRow label="bounds">
                <span
                  className={clsx(
                    'font-mono text-[11px] tabular-nums',
                    unbounded ? 'text-amber/80' : 'text-fog-200'
                  )}
                >
                  {unbounded ? 'unbounded' : `$${costCap.toFixed(2)} · ${minutesCap}m`}
                </span>
              </LabelRow>
              <LabelRow label="branches">
                <span
                  className={clsx(
                    'font-mono text-[11px]',
                    branchStrategy === 'push-same-branch' && 'text-molten',
                    branchStrategy === 'push-new-branch' && 'text-amber',
                    branchStrategy === 'local-only' && 'text-mint'
                  )}
                >
                  {branchStrategy === 'push-same-branch'
                    ? 'same branch'
                    : branchStrategy === 'push-new-branch'
                      ? `new · ${branchName || 'unnamed'}`
                      : 'local only'}
                </span>
              </LabelRow>
              <LabelRow label="start">
                <span
                  className={clsx(
                    'font-mono text-[11px]',
                    startMode === 'live' && 'text-molten',
                    startMode === 'dry-run' && 'text-amber',
                    startMode === 'spectator' && 'text-mint'
                  )}
                >
                  {startMode}
                </span>
              </LabelRow>
            </div>

            {teamRows.length > 0 && (
              <div className="pt-1 hairline-t">
                <div className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-600 mb-1">
                  lineup
                </div>
                <ul className="space-y-0.5 max-h-[140px] overflow-y-auto">
                  {teamRows.map(({ model, count }) => (
                    <li
                      key={model.id}
                      className="flex items-center gap-2 h-4 font-mono text-[10.5px]"
                    >
                      <span className={clsx('w-1 h-1 rounded-full', familyMeta[model.vendor].color.replace('text-', 'bg-'))} />
                      <span className="text-fog-300 truncate flex-1 min-w-0">
                        {model.label}
                      </span>
                      <span className="text-fog-500 tabular-nums shrink-0">
                        ×{count}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>

      {!hasDirective && sourceValue.trim() && (
        <div className="rounded-md hairline bg-ink-900/40 overflow-hidden">
          <div className="px-3 h-6 hairline-b bg-ink-900/70 flex items-center gap-2">
            <span className="w-1 h-1 rounded-full bg-amber" />
            <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-amber/70">
              substrate inference
            </span>
            <Tooltip
              side="top"
              wide
              content={
                <div className="font-mono text-[10.5px] text-fog-500 leading-snug">
                  without a directive, the swarm reads README, recent commits, open issues
                  and PR titles, and proposes its own focus. you can still intervene via
                  composer once the run is live.
                </div>
              }
            >
              <span className="ml-auto font-mono text-[9.5px] uppercase tracking-widest2 text-fog-700 cursor-help underline decoration-dotted decoration-fog-800 underline-offset-[3px]">
                how?
              </span>
            </Tooltip>
          </div>
          <div className="p-3 space-y-2">
            <InferBlock title="likely focus" items={inferred.focus} />
            <InferBlock title="hotspots" items={inferred.hotspots} mono />
            <InferBlock title="open work" items={inferred.openWork} mono />
          </div>
        </div>
      )}

      <div className="rounded-md hairline bg-ink-900/40 p-3 space-y-1.5">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          what this writes
        </div>
        <div className="text-[11px] text-fog-400 leading-snug">
          wires: <span className="text-mint">workspace</span> → opencode session (
          <span className="text-fog-600">POST /session?directory=</span>),{' '}
          <span className="text-mint">directive</span> → first prompt. aspirational:{' '}
          <span className="text-amber/80">source · pattern · team · bounds · branch · start mode</span>
          {' '}— UI-only until opencode grows matching endpoints.
        </div>
      </div>
    </aside>
  );
}
