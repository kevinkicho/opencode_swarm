'use client';

//
// Ticker-state chip + its 3 helpers. Lifted from board-rail.tsx so the
// main file stays focused on the BoardRail layout + BoardRailRow
// rendering. The chip is the auto-ticker observability surface — it's
// purely informational (no controls), so isolating it makes the
// dependency footprint of the row file lighter.

import clsx from 'clsx';
import { useState } from 'react';

import type { LiveTicker, TickerState } from '@/lib/blackboard/live';
import { Tooltip } from '../ui/tooltip';

export function TickerChip({ ticker }: { ticker: LiveTicker }) {
  const { state } = ticker;

  if (state.state === 'none') {
    return (
      <div
        className="h-6 hairline-t px-3 flex items-center gap-2 shrink-0 bg-ink-900/30"
        title={ticker.error ?? 'no ticker has run for this run yet'}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-fog-700 shrink-0" />
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          ticker
        </span>
        <span className="font-mono text-[10px] text-fog-700 ml-auto">none</span>
      </div>
    );
  }

  if (state.state === 'active') {
    const { consecutiveIdle, idleThreshold, inFlight } = state;
    const idleRatio = idleThreshold > 0 ? consecutiveIdle / idleThreshold : 0;
    const idleTone =
      consecutiveIdle === 0
        ? 'text-mint'
        : idleRatio >= 0.66
          ? 'text-amber'
          : 'text-fog-400';
    return (
      <div
        className="h-6 hairline-t px-3 flex items-center gap-2 shrink-0 bg-ink-900/30"
        title={ticker.error ?? tickerActiveTitle(state)}
      >
        <span
          className={clsx(
            'w-1.5 h-1.5 rounded-full shrink-0 bg-mint',
            inFlight && 'animate-pulse',
          )}
        />
        <span className="font-mono text-micro uppercase tracking-widest2 text-mint">
          ticker
        </span>
        <span className={clsx('font-mono text-[10px] tabular-nums ml-auto', idleTone)}>
          {inFlight
            ? 'tick…'
            : consecutiveIdle > 0
              ? `idle ${consecutiveIdle}/${idleThreshold}`
              : 'running'}
        </span>
      </div>
    );
  }

  // #65 Phase A — show the granular cap reason (wall-clock / commits /
  // todos) instead of falling through to a generic "manual" label that
  // hides why the ticker actually stopped. Cap reasons fire only when
  // the run hit a configured ceiling, so surfacing which one helps the
  // operator decide whether to bump the cap or accept the stop.
  const reasonLabel = state.stopReason ?? 'manual';
  return (
    <div
      className="h-6 hairline-t px-3 flex items-center gap-2 shrink-0 bg-ink-900/30"
      title={ticker.error ?? tickerStoppedTitle(state)}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-amber/70 shrink-0" />
      <span className="font-mono text-micro uppercase tracking-widest2 text-amber">
        ticker
      </span>
      <span className="font-mono text-[10px] text-fog-500 truncate">
        stopped · {reasonLabel}
      </span>
      <button
        type="button"
        onClick={() => void ticker.start()}
        disabled={ticker.busy}
        className="ml-auto font-mono text-micro uppercase tracking-widest2 text-iris hover:text-iris/80 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {ticker.busy ? '…' : 'restart'}
      </button>
    </div>
  );
}

function tickerActiveTitle(s: Extract<TickerState, { state: 'active' }>): string {
  const parts = [`started ${formatAgo(s.startedAtMs)} ago`];
  if (s.lastRanAtMs) parts.push(`last tick ${formatAgo(s.lastRanAtMs)} ago`);
  if (s.lastOutcome) parts.push(`last outcome: ${s.lastOutcome.status}`);
  parts.push(`interval ${Math.round(s.intervalMs / 1000)}s`);
  return parts.join(' · ');
}

function tickerStoppedTitle(s: Extract<TickerState, { state: 'stopped' }>): string {
  const parts = [`started ${formatAgo(s.startedAtMs)} ago`];
  if (s.stoppedAtMs) parts.push(`stopped ${formatAgo(s.stoppedAtMs)} ago`);
  parts.push(`reason: ${s.stopReason ?? 'manual'}`);
  if (s.lastOutcome) parts.push(`last outcome: ${s.lastOutcome.status}`);
  return parts.join(' · ');
}

function formatAgo(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}
