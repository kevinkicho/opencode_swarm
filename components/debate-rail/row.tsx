'use client';

// Per-round row in the debate rail.
//
// Renders: round number, up to 4 generator cells (line count + diff
// signal), judge verdict chip + WINNER target arrow + brief body text,
// row status. Lifted from debate-rail.tsx 2026-04-28.

import clsx from 'clsx';
import { compactNum } from '../rails/_shared';
import type { RoundRow } from './helpers';

const VERDICT_TONE: Record<RoundRow['judge']['verdict'], string> = {
  winner: 'text-mint',
  merge: 'text-iris',
  revise: 'text-amber',
  pending: 'text-fog-700',
  unknown: 'text-fog-500',
};

const VERDICT_LABEL: Record<RoundRow['judge']['verdict'], string> = {
  winner: 'WINNER',
  merge: 'MERGE',
  revise: 'REVISE',
  pending: '—',
  unknown: '?',
};

const STATUS_TONE: Record<RoundRow['status'], string> = {
  pending: 'text-fog-700',
  deliberating: 'text-iris animate-pulse',
  done: 'text-fog-500',
};

export function DebateRowEl({
  row,
  isFinal,
}: {
  row: RoundRow;
  isFinal: boolean;
}) {
  // Cap visible generator columns at 4 for layout; collapse extras into
  // a "+N more" chip.
  const visibleGens = row.generators.slice(0, 4);
  const overflowGens = row.generators.length - visibleGens.length;

  // grid: round 24 · gen × visibleN (~64px each) · judge flex · status 56
  const gridCols = `24px repeat(${visibleGens.length}, 64px)${overflowGens > 0 ? ' 32px' : ''} minmax(0, 1fr) 56px`;

  return (
    <li
      className={clsx(
        'h-6 px-3 grid items-center gap-1.5 text-[10.5px] font-mono cursor-default hover:bg-ink-800/40 transition',
        isFinal && 'bg-mint/[0.06]',
      )}
      style={{ gridTemplateColumns: gridCols }}
      title={row.judge.text ?? undefined}
    >
      <span className="text-fog-400 tabular-nums">R{row.round}</span>
      {visibleGens.map((cell, gi) => (
        <span
          key={gi}
          className={clsx(
            'tabular-nums text-[9px]',
            cell.status === 'pending'
              ? 'text-fog-800'
              : cell.status === 'errored'
                ? 'text-rust'
                : cell.status === 'drafting'
                  ? 'text-fog-300 animate-pulse'
                  : 'text-fog-400',
          )}
          title={
            cell.diff
              ? `R${row.round} draft from generator ${gi + 1} · ${cell.lines}L · ${cell.diff} vs prior round`
              : cell.lines !== null
                ? `R${row.round} draft from generator ${gi + 1} · ${cell.lines}L`
                : 'pending'
          }
        >
          {cell.lines !== null ? `${compactNum(cell.lines)}L` : '—'}
          {cell.diff && cell.diff !== 'no change' && (
            <span className="ml-1 text-fog-700 text-[8px]">{cell.diff}</span>
          )}
        </span>
      ))}
      {overflowGens > 0 && (
        <span
          className="font-mono text-[9px] text-fog-700 text-center"
          title={`+${overflowGens} more generator${overflowGens === 1 ? '' : 's'}`}
        >
          +{overflowGens}
        </span>
      )}
      <span className="truncate min-w-0 flex items-center gap-1.5">
        <span
          className={clsx(
            'uppercase tracking-widest2 text-[9px] shrink-0',
            VERDICT_TONE[row.judge.verdict],
          )}
        >
          {VERDICT_LABEL[row.judge.verdict]}
          {row.judge.target !== null && (
            <span className="ml-1 text-fog-500 normal-case tracking-normal">
              → g{row.judge.target + 1}
            </span>
          )}
        </span>
        {row.judge.text && (
          <span className="text-fog-500 truncate text-[9.5px] min-w-0">
            {row.judge.text}
          </span>
        )}
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
