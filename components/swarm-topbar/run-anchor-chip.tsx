// RunAnchorChip — the always-visible chip that anchors the topbar to
// the current swarm run. Click pins a Popover with the full run detail
// (pattern, sessions, created-at, source, directive, caps).
//
// Extracted from swarm-topbar.tsx in #108 because it's the single
// largest piece of the topbar's UI (~220 lines of Popover content).

import clsx from 'clsx';
import type { SwarmRunMeta, SwarmRunStatus } from '@/lib/swarm-run-types';
import { IconCopy } from '../icons';
import { Popover } from '../ui/popover';
import { patternMeta, patternAccentText } from '@/lib/swarm-patterns';
import { STATUS_VISUAL } from '../swarm-runs-picker';
import { fmtAbsTs } from './chips';

export function RunAnchorChip({
  meta,
  status,
  stale = false,
}: {
  meta: SwarmRunMeta;
  status: SwarmRunStatus | null;
  // When true, the backend has been unreachable long enough that any
  // status we show is a React cache from before the disconnect. We
  // don't blank it (history is still useful) but we fade it so the
  // user can tell at a glance "this is yesterday's news."
  stale?: boolean;
}) {
  const directive = meta.directive?.trim() ?? '';
  const costCap = meta.bounds?.costCap;
  const minutesCap = meta.bounds?.minutesCap;
  const hasBounds = costCap != null || minutesCap != null;
  const visual = status ? STATUS_VISUAL[status] : null;
  // Directive moved to the popover only (2026-04-24); collapsed-chip
  // teaser was deemed redundant with the run-title text directly to
  // the chip's left. The full directive renders inside the popover
  // body below.

  return (
    <Popover
      side="bottom"
      align="start"
      content={() => (
        <div className="w-[420px]">
          <div className="px-3 h-7 hairline-b flex items-center gap-2">
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
              run anchor
            </span>
            {visual && (
              <span className="flex items-center gap-1 shrink-0">
                <span className={clsx('w-1.5 h-1.5 rounded-full', visual.dot)} />
                <span
                  className={clsx(
                    'font-mono text-[9.5px] uppercase tracking-widest2',
                    visual.tone
                  )}
                >
                  {visual.label}
                </span>
              </span>
            )}
             <span
               className="ml-auto font-mono text-[10px] text-fog-600 tabular-nums truncate max-w-[220px] flex items-center gap-1.5"
               title={meta.swarmRunID}
             >
               {meta.swarmRunID}
               <button
                 onClick={(e) => {
                   e.stopPropagation();
                   navigator.clipboard.writeText(meta.swarmRunID);
                 }}
                 className="p-0.5 rounded hover:bg-ink-700 transition-colors text-fog-600 hover:text-fog-300"
                 title="copy run id"
               >
                 <IconCopy size={10} />
               </button>
             </span>

          </div>
          <div className="px-3 py-2 hairline-b grid grid-cols-[78px_1fr] gap-y-1.5 gap-x-3 items-baseline">
            <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
              pattern
            </span>
            {meta.pattern === 'blackboard' ? (
              <a
                href={`/board-preview?swarmRun=${meta.swarmRunID}`}
                className={clsx(
                  'font-mono text-[11px] hover:opacity-80 flex items-center gap-1 group w-fit',
                  patternAccentText[patternMeta[meta.pattern].accent],
                )}
                title="open board view"
              >
                {meta.pattern}
                <span className="text-fog-600 group-hover:text-fog-300 transition">→ board</span>
              </a>
            ) : (
              <span
                className={clsx(
                  'font-mono text-[11px]',
                  patternAccentText[patternMeta[meta.pattern].accent],
                )}
              >
                {meta.pattern}
              </span>
            )}
            <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
              sessions
            </span>
            {meta.sessionIDs.length > 1 ? (
              <span className="flex flex-wrap items-center gap-1">
                <span className="font-mono text-[11px] text-fog-300 tabular-nums mr-1">
                  {meta.sessionIDs.length}×
                </span>
                {meta.sessionIDs.map((sid) => (
                  <span
                    key={sid}
                    className="font-mono text-[10px] text-fog-400 tabular-nums px-1 h-4 flex items-center rounded bg-ink-800/60 hairline"
                    title={sid}
                  >
                    {sid.slice(-8)}
                  </span>
                ))}
              </span>
            ) : (
              <span className="font-mono text-[11px] text-fog-300 tabular-nums">
                {meta.sessionIDs.length}
              </span>
            )}
            <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
              created
            </span>
            <span className="font-mono text-[11px] text-fog-200 tabular-nums">
              {fmtAbsTs(meta.createdAt)}
            </span>
            {meta.source && (
              <>
                <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
                  source
                </span>
                <a
                  href={meta.source}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[11px] text-mint/90 hover:text-mint truncate"
                  title={meta.source}
                >
                  {meta.source}
                </a>
              </>
            )}
          </div>
          {directive && (
            <div className="px-3 py-2 hairline-b">
              <div className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600 mb-1">
                directive
              </div>
              <div className="font-mono text-[11px] text-fog-200 whitespace-pre-wrap leading-relaxed max-h-[168px] overflow-y-auto">
                {directive}
              </div>
            </div>
          )}
          <div className="px-3 py-2 grid grid-cols-[78px_1fr] gap-y-1.5 gap-x-3 items-baseline">
            <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
              cost cap
            </span>
            <span
              className={clsx(
                'font-mono text-[11px] tabular-nums',
                costCap != null ? 'text-molten' : 'text-fog-700'
              )}
            >
              {costCap != null ? `$${costCap.toFixed(2)}` : 'unbounded'}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
              time cap
            </span>
            <span
              className={clsx(
                'font-mono text-[11px] tabular-nums',
                minutesCap != null ? 'text-amber' : 'text-fog-700'
              )}
            >
              {minutesCap != null ? `${minutesCap}m` : 'unbounded'}
            </span>
          </div>
        </div>
      )}
    >
      <button
        className={clsx(
          'fluent-btn gap-1.5 shrink-0 transition-opacity',
          stale && 'opacity-50 grayscale',
        )}
        title={
          stale
            ? 'backend unreachable — status shown is pre-disconnect cache'
            : `${visual?.label ?? 'unknown'} · click for run details`
        }
      >
        {/* Run-anchor chip is now status-only (2026-04-24): dot +
            status label (live / stale / error / done / queued / etc.).
            The directive teaser was demoted to the click-pin Popover —
            it's the authoritative surface for full directive text +
            pattern + caps + run-id. The chip's job is just "is this
            run still going?" at a glance. */}
        <span
          className={clsx(
            'w-1.5 h-1.5 rounded-full shrink-0',
            visual && !stale ? visual.dot : 'bg-fog-700',
          )}
          aria-label={visual ? `status: ${visual.label}` : 'status: unknown'}
        />
        <span
          className={clsx(
            'font-mono text-micro uppercase tracking-widest2 shrink-0',
            visual?.tone ?? 'text-fog-500',
          )}
        >
          {visual?.label ?? 'unknown'}
        </span>
        {hasBounds && (
          <span className="flex items-center gap-1 shrink-0 pl-1 border-l border-ink-700">
            {costCap != null && (
              <span className="font-mono text-[9.5px] text-fog-500 tabular-nums">
                ${costCap.toFixed(costCap < 10 ? 2 : 0)}
              </span>
            )}
            {minutesCap != null && (
              <span className="font-mono text-[9.5px] text-fog-500 tabular-nums">
                {minutesCap}m
              </span>
            )}
          </span>
        )}
      </button>
    </Popover>
  );
}
