'use client';

import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { Modal } from './ui/modal';
import { Tooltip } from './ui/tooltip';
import { defaultBounds, useRoutingBounds, type RoutingBounds } from '@/lib/routing-bounds-context';
import {
  BudgetBar,
  CeilingRow,
  DispatchStack,
  ObservationTooltip,
  initialDispatch,
  providerFill,
} from './routing-modal/sub-views';

// 2026-04-28 decomposition: the 3 visual sub-components, the dispatch
// fixture, and the eyebrow tooltip moved to routing-modal/sub-views.tsx
// so this file is just the modal scaffolding + state machinery.

export function RoutingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { bounds, save, reset } = useRoutingBounds();

  // Draft state — single object hydrated from committed bounds on each
  // open-transition so edits don't leak across cancels. Replaces the
  // pre-W5.16 wasOpenRef + 6-pair setter dance with a single useState +
  // a one-shot useEffect on `open`. Save writes draft back to the
  // context; reset writes defaults directly to the context.
  const [draft, setDraft] = useState<RoutingBounds>(bounds);
  useEffect(() => {
    // Re-hydrate on every open-transition (closed → open). The effect
    // doesn't fire on close-transitions because nothing reads draft
    // when the modal is closed; React garbage-collects whichever
    // value was sitting there.
    if (open) setDraft(bounds);
  }, [open, bounds]);
  const setField = <K extends keyof RoutingBounds>(key: K, value: RoutingBounds[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const { costCap, tokenCap, minutesCap, zenCeiling, goCeiling, ollamaCeiling } = draft;
  const setCostCap = (v: number) => setField('costCap', v);
  const setTokenCap = (v: number) => setField('tokenCap', v);
  const setMinutesCap = (v: number) => setField('minutesCap', v);
  const setZenCeiling = (v: number) => setField('zenCeiling', v);
  const setGoCeiling = (v: number) => setField('goCeiling', v);
  const setOllamaCeiling = (v: number) => setField('ollamaCeiling', v);

  const dirty =
    costCap !== bounds.costCap ||
    tokenCap !== bounds.tokenCap ||
    minutesCap !== bounds.minutesCap ||
    zenCeiling !== bounds.zenCeiling ||
    goCeiling !== bounds.goCeiling ||
    ollamaCeiling !== bounds.ollamaCeiling;

  const handleSave = () => {
    save(draft);
    onClose();
  };

  const handleReset = () => {
    reset();
    setDraft(defaultBounds);
  };

  const dispatch = initialDispatch;

  const costUsed = dispatch.reduce((a, d) => a + d.cost, 0);
  const callsTotal = dispatch.reduce((a, d) => a + d.calls, 0);
  const tokensUsed = 74_312;
  const minutesUsed = 7.4;

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="observation"
      eyebrowHint={<ObservationTooltip />}
      title="run dispatch"
      width="max-w-2xl"
    >
      <div className="space-y-4">
        <div className="rounded-md hairline bg-ink-900/50 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
              run budget
            </span>
            <span className="ml-auto font-mono text-[10.5px] text-fog-700">
              bounds · not assignments
            </span>
          </div>
          <BudgetBar
            label="spend"
            used={costUsed}
            cap={costCap}
            onChangeCap={setCostCap}
            format={(v) => `$${v.toFixed(2)}`}
            step={0.25}
            min={0.5}
            max={20}
          />
          <BudgetBar
            label="tokens"
            used={tokensUsed}
            cap={tokenCap}
            onChangeCap={setTokenCap}
            format={(v) => `${Math.round(v / 1000)}k`}
            step={10_000}
            min={10_000}
            max={500_000}
          />
          <BudgetBar
            label="wallclock"
            used={minutesUsed}
            cap={minutesCap}
            onChangeCap={setMinutesCap}
            format={(v) => `${v}m`}
            step={1}
            min={1}
            max={60}
          />
        </div>

        <div className="rounded-md hairline bg-ink-900/50 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
              observed dispatch
            </span>
            <span className="font-mono text-[10.5px] text-fog-700 tabular-nums">
              {callsTotal} calls · ${costUsed.toFixed(2)}
            </span>
            <span className="ml-auto font-mono text-[10.5px] text-fog-700">
              agents self-selected · not assigned
            </span>
          </div>
          <DispatchStack dispatch={dispatch} />
          <ul className="hairline-t pt-1 grid grid-cols-2 gap-x-4">
            {dispatch.map((d) => (
              <li
                key={d.model}
                className="flex items-center gap-2 h-5 font-mono text-[10.5px]"
              >
                <span
                  className={clsx(
                    'w-1.5 h-1.5 rounded-full shrink-0',
                    providerFill[d.provider]
                  )}
                />
                <span className="text-fog-300">{d.model}</span>
                <span className="text-fog-700 tabular-nums">· {d.calls}</span>
                <span className="ml-auto tabular-nums text-fog-400">
                  ${d.cost.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-md hairline bg-ink-900/50 p-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
              provider ceilings
            </span>
            <Tooltip
              side="top"
              wide
              content={
                <div className="space-y-1">
                  <div className="font-mono text-[11px] text-fog-200">soft bounds</div>
                  <div className="font-mono text-[10.5px] text-fog-500">
                    max fraction of run spend that can flow to each provider tier. agents prefer cheapest available; ceilings prevent runaway on premium. never assigns a specific agent to a specific provider.
                  </div>
                </div>
              }
            >
              <span className="ml-auto font-mono text-[10.5px] text-fog-700 cursor-help underline decoration-dotted decoration-fog-800 underline-offset-[3px]">
                what is this?
              </span>
            </Tooltip>
          </div>
          <CeilingRow
            label="zen"
            hint="premium tier"
            value={zenCeiling}
            onChange={setZenCeiling}
            accent="molten"
          />
          <CeilingRow
            label="go"
            hint="budget tier"
            value={goCeiling}
            onChange={setGoCeiling}
            accent="mint"
          />
          <CeilingRow
            label="ollama"
            hint="subscription tier"
            value={ollamaCeiling}
            onChange={setOllamaCeiling}
            accent="iris"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleReset}
            className="h-8 px-3 rounded font-mono text-micro uppercase tracking-wider bg-ink-900 hairline text-fog-400 hover:border-ink-500 transition"
          >
            reset defaults
          </button>
          <span className="font-mono text-micro text-fog-700">
            {dirty ? 'unsaved changes · apply to next dispatch' : 'bounds apply to next dispatch'}
          </span>
          <button
            onClick={handleSave}
            className={clsx(
              'ml-auto h-8 px-4 rounded font-mono text-micro uppercase tracking-wider transition border',
              dirty
                ? 'bg-molten/15 hover:bg-molten/25 text-molten border-molten/30'
                : 'bg-ink-900 text-fog-500 border-ink-700 hover:text-fog-300'
            )}
          >
            save
          </button>
        </div>
      </div>
    </Modal>
  );
}
