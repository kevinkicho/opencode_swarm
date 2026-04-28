'use client';

// Pure-render sub-views for the swarm timeline.
//
// Two extracted components:
//   - LaneMeter — per-lane throughput (in/out rate or cumulative tokens
//     when idle) + cumulative tokens·cost row + a small color-dot strip
//     showing which part types / tool kinds are currently active. Pinned
//     to each lane header inside the sticky timeline header.
//   - PartLegend — popover trigger that shows per-part-type counts +
//     multi-select toggles to filter the timeline. Used by the timeline
//     toolbar.
//
// Both are pure renders driven by props — they don't reach into any
// timeline-internal state. Lifted from swarm-timeline.tsx 2026-04-28
// to shrink the parent module's render block by ~250 lines and let
// future iterations on either piece be done without scrolling past the
// other.

import clsx from 'clsx';
import type { PartType } from '@/lib/swarm-types';
import { partMeta, partHex, partOrder, toolMeta } from '@/lib/part-taxonomy';
import { compact } from '@/lib/format';
import { formatRate, type LaneThroughput } from '@/lib/playback-context';
import { Popover } from '../ui/popover';
import { Tooltip } from '../ui/tooltip';

export function LaneMeter({
  throughput,
  tokens,
  tokensIn,
  tokensOut,
  cost,
}: {
  throughput: LaneThroughput;
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}) {
  const hasOut = throughput.outRate > 0;
  const hasIn = throughput.inRate > 0;
  const anyActive = hasOut || hasIn;

  const uniqueColors = new Map<string, string>();
  for (const s of [...throughput.activeOut, ...throughput.activeIn]) {
    const key = s.toolName ?? `part:${s.part}`;
    const color = s.toolName ? toolMeta[s.toolName].hex : partHex[s.part];
    if (!uniqueColors.has(key)) uniqueColors.set(key, color);
  }
  const dots = Array.from(uniqueColors.values()).slice(0, 5);

  return (
    <>
      <div className="mt-1 flex items-center gap-1.5 h-3 font-mono text-[9.5px] tabular-nums">
        {/* IN first, OUT second (2026-04-24 — user requested swap; the
            ingest→produce flow reads more naturally in that order).
            When the throughput rate is zero (idle / dead lane), fall
            back to the cumulative tokens-in / tokens-out totals. The
            previous behavior — formatRate(0) → "—" — read visually
            as "no data exists" even when the lane had real history.
            Tooltip switches tone to match: live lanes get
            rate-per-second, idle lanes get cumulative breakdown. */}
        <Tooltip
          content={hasIn ? 'inbound part rate' : 'cumulative input tokens (idle)'}
          side="top"
        >
          <span
            className={clsx(
              'shrink-0 transition-colors cursor-help',
              hasIn ? 'text-fog-200' : tokensIn > 0 ? 'text-fog-500' : 'text-fog-800',
            )}
          >
            in {hasIn ? formatRate(throughput.inRate) : compact(tokensIn)}
          </span>
        </Tooltip>
        <Tooltip
          content={hasOut ? 'outbound part rate' : 'cumulative output tokens (idle)'}
          side="top"
        >
          <span
            className={clsx(
              'shrink-0 transition-colors cursor-help',
              hasOut ? 'text-fog-200' : tokensOut > 0 ? 'text-fog-500' : 'text-fog-800',
            )}
          >
            out {hasOut ? formatRate(throughput.outRate) : compact(tokensOut)}
          </span>
        </Tooltip>
        <div className="ml-auto flex items-center gap-[3px]">
          {dots.map((color, i) => (
            <span
              key={i}
              className="w-1 h-1 rounded-full animate-pulse"
              style={{ backgroundColor: color }}
            />
          ))}
          {!anyActive && <span className="w-1 h-1 rounded-full bg-ink-600" />}
        </div>
      </div>
      {/* Cumulative tokens + cost. Always rendered so a quiet lane
          still carries meaningful data (rates alone read as zeros
          when a session is between turns). Compact format: "12.4K
          tok · $0.42" fits within the typical lane width. */}
      <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[9.5px] tabular-nums text-fog-600">
        <Tooltip content="cumulative tokens this session" side="top">
          <span className="shrink-0 cursor-help">{compact(tokens)} tok</span>
        </Tooltip>
        <span className="text-fog-800">·</span>
        <Tooltip content="cumulative cost this session" side="top">
          <span className="shrink-0 cursor-help">${cost.toFixed(2)}</span>
        </Tooltip>
      </div>
    </>
  );
}

export function PartLegend({
  partFilter,
  onChange,
  counts,
}: {
  partFilter: Set<PartType>;
  onChange: (v: Set<PartType>) => void;
  counts: Map<PartType, number>;
}) {
  // Multi-select: empty Set = "all visible", otherwise = "isolate
  // these N part types". Click toggles each row in/out of the set.
  const active = partFilter.size > 0;
  // Popover (click-pin), not Tooltip: the rows inside are interactive —
  // click a label to toggle that part in the main view. Tooltip would
  // collapse the moment the mouse moved onto a row and the click would
  // never register. See the interactive_tooltip project memory.
  return (
    <Popover
      side="bottom"
      align="end"
      wide
      content={() => (
        <div className="space-y-2 min-w-[340px]">
          <div className="flex items-center gap-2">
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
              part types
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700">
              multi-select
            </span>
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className={clsx(
                'ml-auto font-mono text-micro uppercase tracking-wider transition cursor-pointer',
                !active ? 'text-molten' : 'text-fog-600 hover:text-fog-200',
              )}
            >
              show all
            </button>
          </div>

          {/* Grid: label | blurb | count. tabular-nums on the count column
              so digits align vertically across rows. All 12 part types are
              listed regardless of count — zero-count rows are dimmed but
              clickable so a user can pre-select a filter for parts they
              expect to arrive later in the run. */}
          <ul
            className="list-none"
            style={{
              display: 'grid',
              gridTemplateColumns: 'max-content 1fr max-content',
              columnGap: '10px',
              rowGap: '1px',
            }}
          >
            {partOrder.map((p) => {
              const selected = partFilter.has(p);
              const count = counts.get(p) ?? 0;
              const dim = count === 0 && !selected;
              return (
                <li key={p} className="contents">
                  <button
                    type="button"
                    onClick={() => {
                      const next = new Set(partFilter);
                      if (next.has(p)) next.delete(p);
                      else next.add(p);
                      onChange(next);
                      // Don't auto-close — multi-select implies the user
                      // may want to toggle several before dismissing.
                    }}
                    className={clsx(
                      'contents font-mono text-micro uppercase tracking-wider cursor-pointer group',
                      dim && 'opacity-40',
                    )}
                    aria-pressed={selected}
                    aria-label={`toggle ${partMeta[p].label}`}
                  >
                    <span
                      className={clsx(
                        'h-6 px-2 flex items-center rounded-l gap-1.5',
                        selected ? 'bg-ink-700' : 'group-hover:bg-ink-800',
                      )}
                      style={{ color: partHex[p] }}
                    >
                      <span
                        className={clsx(
                          'w-2.5 h-2.5 rounded-sm border shrink-0',
                          selected
                            ? 'border-molten bg-molten/40'
                            : 'border-fog-700',
                        )}
                        aria-hidden
                      />
                      {partMeta[p].label}
                    </span>
                    <span
                      className={clsx(
                        'h-6 flex items-center text-[10.5px] text-fog-500 normal-case truncate',
                        selected ? 'bg-ink-700' : 'group-hover:bg-ink-800',
                      )}
                    >
                      {partMeta[p].blurb}
                    </span>
                    <span
                      className={clsx(
                        'h-6 px-2 flex items-center justify-end text-[10.5px] text-fog-400 tabular-nums rounded-r',
                        selected ? 'bg-ink-700' : 'group-hover:bg-ink-800',
                      )}
                    >
                      {count}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="hairline-t pt-1 font-mono text-[10.5px] text-fog-600 opacity-40">
            click each label to toggle (multi-select); empty = show all
          </div>
        </div>
      )}
    >
      {/* Tooltip wrapper removed (#7.Q42 sweep): Popover's cloneElement
          ref-fwd doesn't work on Tooltip (function component, no
          forwardRef), warning fires on every render. The Popover's
          panel already explains the filter; the button-level hint
          moves to a `title` attr instead. */}
        <button
          type="button"
          title="part-type toggles · multi-choice show/hide for each opencode part (text, reasoning, tool, patch, …)"
          className={clsx(
            'flex items-center gap-1.5 h-6 px-2 rounded hairline transition cursor-pointer',
            active ? 'border-molten/30 bg-molten/5' : 'bg-ink-900 hover:border-ink-500',
          )}
        >
          <span
            className={clsx(
              'font-mono text-micro uppercase tracking-wider',
              active ? 'text-molten' : 'text-fog-400',
            )}
          >
            {active ? `parts · ${partFilter.size}` : 'parts'}
          </span>
          {active && (
            <span className="font-mono text-[9px] text-fog-600 tabular-nums">
              {Array.from(partFilter).reduce((sum, p) => sum + (counts.get(p) ?? 0), 0)}
            </span>
          )}
        </button>
    </Popover>
  );
}
