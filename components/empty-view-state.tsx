'use client';

// EmptyViewState — rendered in the main viewport when the user clicks
// a tab whose gate is false for the active run's pattern. Replaces the
// previous behavior (filtered tab toolbar + null-render fallback) so
// every view tab is visible always — clicking a non-applicable tab
// shows what the view would do + when it would apply, plus a reference
// matrix so the user can scan all 10 views' availability at once.
//
// 2026-04-28 — added at user request to make the available views
// discoverable without requiring docs/CLAUDE.md or a per-pattern
// trial run.

import clsx from 'clsx';
import { VIEW_META, type RunView } from '@/lib/view-availability';
import { patternMeta, patternAccentText } from '@/lib/swarm-patterns';
import type { SwarmPattern } from '@/lib/swarm-types';
import { ViewAvailabilityMatrix } from './view-availability-matrix';

export function EmptyViewState({
  view,
  currentPattern,
}: {
  view: RunView;
  // Current run's pattern, or undefined if not on a run page.
  currentPattern?: SwarmPattern;
}) {
  const meta = VIEW_META[view];
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-[960px] mx-auto px-6 py-10 space-y-6">
        <div className="space-y-2">
          <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
            view · {view}
          </div>
          <h2 className="font-display italic text-[28px] text-fog-100 leading-tight">
            this view doesn't apply to the current run
          </h2>
          <p className="font-mono text-[12.5px] text-fog-400 leading-relaxed max-w-[680px]">
            {meta.description}
          </p>
        </div>

        <div className="rounded-md hairline bg-ink-900/40 p-4 space-y-3">
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600 shrink-0">
              available when running
            </span>
            {meta.availablePatterns.length === 0 ? (
              <span className="font-mono text-[11px] text-mint">
                any pattern (always available)
              </span>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                {meta.availablePatterns.map((p) => (
                  <span
                    key={p}
                    className={clsx(
                      'font-mono text-[10.5px] uppercase tracking-widest2 px-1.5 h-5 rounded-sm hairline inline-flex items-center',
                      patternAccentText[patternMeta[p].accent],
                    )}
                  >
                    {patternMeta[p].label}
                  </span>
                ))}
              </div>
            )}
          </div>

          {currentPattern && (
            <div className="flex items-baseline gap-3 hairline-t pt-3">
              <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600 shrink-0">
                current run pattern
              </span>
              <span
                className={clsx(
                  'font-mono text-[10.5px] uppercase tracking-widest2 px-1.5 h-5 rounded-sm hairline inline-flex items-center',
                  patternAccentText[patternMeta[currentPattern].accent],
                )}
              >
                {patternMeta[currentPattern].label}
              </span>
              <span className="font-mono text-[10.5px] text-fog-600 normal-case">
                — start a run with one of the patterns above to see this view populated.
              </span>
            </div>
          )}
        </div>

        <ViewAvailabilityMatrix
          highlightedPattern={currentPattern}
          highlightedView={view}
        />
      </div>
    </div>
  );
}
