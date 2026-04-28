'use client';

// MapRowEl + ReduceRowEl — per-session map row and the singleton
// reduce row for the map-reduce rail.
//
// Lifted from map-rail.tsx 2026-04-28. Both rows use the same dense
// h-5 grid layout but with different column shapes; tone palettes
// for status come along.

import clsx from 'clsx';
import { compactNum } from '../rails/_shared';
import type { MapRow, ReduceRow } from './helpers';

export const MAP_STATUS_TONE: Record<MapRow['status'], string> = {
  pending: 'text-fog-700',
  working: 'text-molten animate-pulse',
  idle: 'text-mint',
  errored: 'text-rust',
};

export const REDUCE_STATUS_TONE: Record<ReduceRow['status'], string> = {
  awaiting: 'text-fog-700',
  claimed: 'text-iris',
  running: 'text-molten animate-pulse',
  done: 'text-mint',
  stale: 'text-amber',
};

export function MapRowEl({
  row,
  onInspectSession,
}: {
  row: MapRow;
  onInspectSession?: (sessionID: string) => void;
}) {
  const clickable = !!(onInspectSession && row.sessionID);
  const onClick = clickable ? () => onInspectSession!(row.sessionID) : undefined;
  return (
    <li
      onClick={onClick}
      className={clsx(
        'h-5 px-3 grid items-center gap-1.5 text-[10.5px] font-mono transition',
        clickable
          ? 'cursor-pointer hover:bg-ink-800/60'
          : 'cursor-default hover:bg-ink-800/40',
      )}
      style={{
        // glyph 40 · scope flex · status 60 · output 48 · files 32 · tokens 48
        gridTemplateColumns: '40px minmax(0, 1fr) 60px 48px 32px 48px',
      }}
      title={
        (row.scopeFull || `slot s${row.slotIndex} · ${row.sessionID.slice(-8)}`) +
        (clickable ? ' · click to inspect session' : '')
      }
    >
      <span className="text-iris font-mono text-[10px] tabular-nums">
        s{row.slotIndex}
      </span>
      <span className="text-fog-300 truncate min-w-0">
        {row.scope || <span className="text-fog-700">no scope detected</span>}
      </span>
      <span
        className={clsx(
          'uppercase tracking-widest2 text-[9px] text-right',
          MAP_STATUS_TONE[row.status],
        )}
      >
        {row.status}
      </span>
      <span
        className={clsx(
          'tabular-nums text-right',
          row.outputLines > 0 ? 'text-fog-400' : 'text-fog-700',
        )}
      >
        {row.outputLines > 0 ? `${compactNum(row.outputLines)}L` : '—'}
      </span>
      <span
        className={clsx(
          'tabular-nums text-right',
          row.filesTouched > 0 ? 'text-fog-400' : 'text-fog-700',
        )}
      >
        {row.filesTouched > 0 ? row.filesTouched : '—'}
      </span>
      <span
        className={clsx(
          'tabular-nums text-right',
          row.tokens > 0 ? 'text-fog-400' : 'text-fog-700',
        )}
      >
        {row.tokens > 0 ? compactNum(row.tokens) : '—'}
      </span>
    </li>
  );
}

export function ReduceRowEl({
  row,
  ownerSessionID,
  onInspectSession,
}: {
  row: ReduceRow;
  ownerSessionID: string | null;
  onInspectSession?: (sessionID: string) => void;
}) {
  const idShort = row.itemID.length > 12 ? `${row.itemID.slice(0, 8)}…` : row.itemID;
  const clickable = !!(onInspectSession && ownerSessionID);
  const onClick = clickable
    ? () => onInspectSession!(ownerSessionID!)
    : undefined;
  return (
    <li
      onClick={onClick}
      className={clsx(
        'h-5 px-3 grid items-center gap-1.5 text-[10.5px] font-mono transition',
        clickable
          ? 'cursor-pointer hover:bg-ink-800/60'
          : 'cursor-default hover:bg-ink-800/40',
      )}
      style={{
        // glyph 16 · item 80 · status 80 · owner 32 · elapsed 48 · output 48
        gridTemplateColumns: '16px 80px 80px 32px 48px 48px',
      }}
      title={
        `synthesize ${row.itemID}` +
        (clickable ? ' · click to inspect synthesizer' : '')
      }
    >
      <span className="text-iris">⬢</span>
      <span className="font-mono text-[9px] text-fog-500 tabular-nums truncate">
        {idShort}
      </span>
      <span
        className={clsx(
          'uppercase tracking-widest2 text-[9px]',
          REDUCE_STATUS_TONE[row.status],
        )}
      >
        {row.status}
      </span>
      <span className="font-mono text-[10px] text-iris tabular-nums text-right">
        {row.ownerSlot !== null ? `s${row.ownerSlot}` : '—'}
      </span>
      <span
        className={clsx(
          'tabular-nums text-right',
          row.elapsedMinutes !== null ? 'text-fog-400' : 'text-fog-700',
        )}
      >
        {row.elapsedMinutes !== null
          ? row.elapsedMinutes < 10
            ? `${row.elapsedMinutes.toFixed(1)}m`
            : `${Math.round(row.elapsedMinutes)}m`
          : '—'}
      </span>
      <span
        className={clsx(
          'tabular-nums text-right',
          row.outputLines > 0 ? 'text-fog-400' : 'text-fog-700',
        )}
      >
        {row.outputLines > 0 ? `${compactNum(row.outputLines)}L` : '—'}
      </span>
    </li>
  );
}
