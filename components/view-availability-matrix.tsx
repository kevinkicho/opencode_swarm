'use client';

// Reference matrix: 7 patterns × 10 views grid showing where each view
// is data-bound. Used inside EmptyViewState (when the user clicks a
// not-applicable tab) to teach the rule "view X shows up when running
// pattern Y" without making them go hunt for documentation.
//
// 2026-04-28 — added at user request after the per-pattern audit
// documented the gating policy. The user wanted to "familiarize myself
// of these views' existence as I work with various swarm modes" — the
// matrix surfaces all of them at once + highlights the current run's
// row + the current view's column.

import clsx from 'clsx';
import {
  ALL_PATTERNS,
  RUN_VIEW_KEYS,
  VIEW_META,
  type RunView,
} from '@/lib/view-availability';
import { patternMeta, patternAccentText } from '@/lib/swarm-patterns';
import type { SwarmPattern } from '@/lib/swarm-types';

export function ViewAvailabilityMatrix({
  highlightedPattern,
  highlightedView,
}: {
  // Current run's pattern (highlighted row). Optional — when off a
  // run page the matrix renders without a row pin.
  highlightedPattern?: SwarmPattern;
  // Current view selection (highlighted column).
  highlightedView?: RunView;
}) {
  return (
    <div className="rounded-md hairline bg-ink-900/40 overflow-hidden">
      <div className="hairline-b px-3 h-7 flex items-center bg-ink-900/60">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
          views by pattern
        </span>
        <span className="ml-auto font-mono text-[10px] text-fog-700">
          ✓ = data-bound for that pattern
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full font-mono text-[10.5px] tabular-nums">
          <thead>
            <tr className="hairline-b">
              <th className="text-left py-1.5 px-3 font-normal text-fog-600 uppercase tracking-widest2 text-[9.5px]">
                pattern
              </th>
              {RUN_VIEW_KEYS.map((v) => (
                <th
                  key={v}
                  className={clsx(
                    'text-center py-1.5 px-2 font-normal uppercase tracking-widest2 text-[9.5px]',
                    v === highlightedView ? 'text-molten' : 'text-fog-600',
                  )}
                >
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ALL_PATTERNS.map((p) => {
              const isCurrentPattern = p === highlightedPattern;
              return (
                <tr
                  key={p}
                  className={clsx(
                    'hairline-b last:border-b-0 transition-colors',
                    isCurrentPattern ? 'bg-iris/[0.06]' : 'hover:bg-ink-800/40',
                  )}
                >
                  <td
                    className={clsx(
                      'py-1.5 px-3 text-left',
                      isCurrentPattern
                        ? patternAccentText[patternMeta[p].accent]
                        : 'text-fog-300',
                    )}
                  >
                    {p}
                    {isCurrentPattern && (
                      <span className="ml-1.5 text-[9px] text-iris uppercase tracking-widest2">
                        ← current
                      </span>
                    )}
                  </td>
                  {RUN_VIEW_KEYS.map((v) => {
                    // Use a synthetic context — pattern set + a fake
                    // boardSwarmRunID for board-pattern rows so the
                    // gate predicate returns the same answer it does
                    // at runtime.
                    const fakeBoardId =
                      VIEW_META.board.enabled({ pattern: p, boardSwarmRunID: 'x' }) &&
                      VIEW_META.board.availablePatterns.includes(p)
                        ? 'x'
                        : null;
                    const enabled = VIEW_META[v].enabled({
                      pattern: p,
                      boardSwarmRunID: fakeBoardId,
                    });
                    const isCurrentCol = v === highlightedView;
                    return (
                      <td
                        key={v}
                        className={clsx(
                          'text-center py-1.5 px-2',
                          isCurrentCol && 'bg-molten/[0.06]',
                          enabled ? 'text-mint/80' : 'text-fog-800',
                        )}
                      >
                        {enabled ? '✓' : '·'}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
