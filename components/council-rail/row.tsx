'use client';

// Per-round row in the council rail.
//
// One row per round; each round shows up to 4 member columns
// (drafts measured in line count) + a stance chip per member +
// a council-wide convergence chip + the round status. Lifted
// from council-rail.tsx 2026-04-28 — pulls jaccard/tokenization
// helpers from sibling jaccard.ts.

import clsx from 'clsx';
import { compactNum } from '../rails/_shared';
import {
  STANCE_GLYPH,
  STANCE_TONE,
  convergenceLabel,
  convergenceTone,
  stanceBucket,
  type RoundRow,
} from './jaccard';

const STATUS_TONE: Record<RoundRow['status'], string> = {
  pending: 'text-fog-700',
  'in-progress': 'text-molten animate-pulse',
  done: 'text-fog-500',
};

const CONV_TEXT: Record<'mint' | 'amber' | 'rust' | 'fog', string> = {
  mint: 'text-mint',
  amber: 'text-amber',
  rust: 'text-rust',
  fog: 'text-fog-700',
};

export function CouncilRowEl({
  row,
  memberCount,
}: {
  row: RoundRow;
  memberCount: number;
}) {
  // Cap visible member columns at 4. Common council sizes are 3-5; a
  // 5-member run collapses to "+1" rather than pushing the convergence
  // chip off the visible area.
  const visible = row.members.slice(0, 4);
  const overflow = row.members.length - visible.length;
  const gridCols = `24px repeat(${visible.length}, 64px)${overflow > 0 ? ' 28px' : ''} 48px 64px`;
  const convTone = convergenceTone(row.convergence);

  return (
    <li
      className="h-6 px-3 grid items-center gap-1.5 text-[10.5px] font-mono cursor-default hover:bg-ink-800/40 transition"
      style={{ gridTemplateColumns: gridCols }}
      title={
        row.convergence !== null
          ? `R${row.round} · ${memberCount} members · convergence ${(row.convergence * 100).toFixed(0)}% (mean pairwise token-jaccard)`
          : `R${row.round} · waiting for drafts`
      }
    >
      <span className="text-fog-400 tabular-nums">R{row.round}</span>
      {visible.map((m, mi) => {
        const stance = stanceBucket(m.selfJaccard);
        const jaccardPct =
          m.selfJaccard !== null ? `${Math.round(m.selfJaccard * 100)}%` : null;
        const stanceTitle =
          stance && jaccardPct
            ? ` · stance: ${stance} (${jaccardPct} same as R${row.round - 1})`
            : '';
        return (
          <span
            key={mi}
            className={clsx(
              'tabular-nums text-[9.5px]',
              m.status === 'pending'
                ? 'text-fog-800'
                : m.status === 'drafting'
                  ? 'text-fog-300 animate-pulse'
                  : m.status === 'errored'
                    ? 'text-rust'
                    : 'text-fog-400',
            )}
            title={
              m.diffVsPrior
                ? `member ${mi + 1} · ${m.lines}L · ${m.diffVsPrior} vs R${row.round - 1}${stanceTitle}`
                : m.lines > 0
                  ? `member ${mi + 1} · ${m.lines}L${stanceTitle}`
                  : 'pending'
            }
          >
            {m.lines > 0 ? `${compactNum(m.lines)}L` : '—'}
            {stance && (
              <span className={clsx('ml-1 text-[8px]', STANCE_TONE[stance])}>
                {STANCE_GLYPH[stance]}
              </span>
            )}
          </span>
        );
      })}
      {overflow > 0 && (
        <span
          className="font-mono text-[9px] text-fog-700 text-center"
          title={`+${overflow} more member${overflow === 1 ? '' : 's'}`}
        >
          +{overflow}
        </span>
      )}
      <span
        className={clsx(
          'uppercase tracking-widest2 text-[9px] text-right',
          CONV_TEXT[convTone],
        )}
        title={
          row.convergence !== null
            ? `${(row.convergence * 100).toFixed(0)}% pairwise jaccard across ${row.members.filter((m) => m.status === 'completed').length} completed drafts`
            : 'need ≥2 completed drafts to compute'
        }
      >
        {convergenceLabel(row.convergence)}
      </span>
      <span
        className={clsx(
          'uppercase tracking-widest2 text-[9px] text-right',
          STATUS_TONE[row.status],
        )}
      >
        {row.status}
      </span>
    </li>
  );
}
