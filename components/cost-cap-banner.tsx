'use client';

// Surfaces a 402 from the cost-cap gate (DESIGN.md §9). Sits above the
// composer strip so rejected prompts get an acknowledgeable state instead of
// silently failing in the console. The CTA bounces users to the routing
// modal where they can raise the cap (or decide to start a new run).

import clsx from 'clsx';

export interface CostCapBlock {
  swarmRunID: string;
  costTotal: number;
  costCap: number;
  message: string;
}

function fmtUSD(value: number): string {
  if (value >= 10) return `$${value.toFixed(2)}`;
  if (value >= 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

export function CostCapBanner({
  block,
  onOpenRouting,
  onDismiss,
}: {
  block: CostCapBlock;
  onOpenRouting: () => void;
  onDismiss: () => void;
}) {
  const overBy = Math.max(0, block.costTotal - block.costCap);
  return (
    <div
      role="alert"
      className={clsx(
        'hairline-t bg-molten/[0.08] border-t-molten/35',
        'px-4 h-7 flex items-center gap-3',
      )}
    >
      <span className="flex items-center gap-1.5 shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-molten animate-pulse" />
        <span className="font-mono text-[10px] uppercase tracking-widest2 text-molten">
          cost cap
        </span>
      </span>
      <span className="font-mono text-[11px] text-fog-200 tabular-nums shrink-0">
        {fmtUSD(block.costTotal)}
        <span className="text-fog-600 mx-1">/</span>
        {fmtUSD(block.costCap)}
        {overBy > 0 && (
          <span className="ml-1.5 text-molten">
            (+{fmtUSD(overBy)})
          </span>
        )}
      </span>
      <span className="font-mono text-[11px] text-fog-400 truncate min-w-0 flex-1">
        {block.message}
      </span>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onOpenRouting}
          className={clsx(
            'h-5 px-2 rounded hairline bg-ink-900 hover:bg-ink-800 transition',
            'border-molten/40 hover:border-molten/70',
            'font-mono text-[10px] uppercase tracking-widest2 text-molten',
          )}
        >
          raise cap
        </button>
        <button
          onClick={onDismiss}
          aria-label="dismiss cost-cap banner"
          className="h-5 w-5 rounded hover:bg-ink-800 transition flex items-center justify-center text-fog-600 hover:text-fog-200 font-mono text-[11px]"
        >
          ×
        </button>
      </div>
    </div>
  );
}
