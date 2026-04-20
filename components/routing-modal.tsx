'use client';

import clsx from 'clsx';
import { useState } from 'react';
import { Modal } from './ui/modal';
import { Tooltip } from './ui/tooltip';

interface DispatchSlice {
  provider: 'zen' | 'go';
  model: string;
  calls: number;
  cost: number;
  share: number;
}

interface ObservedShape {
  agentId: string;
  agentName: string;
  accent: 'molten' | 'mint' | 'iris' | 'amber' | 'fog';
  shape: string;
  breakdown: string;
}

const initialDispatch: DispatchSlice[] = [
  { provider: 'zen', model: 'opus-4.7', calls: 6, cost: 1.42, share: 0.34 },
  { provider: 'zen', model: 'sonnet-4.6', calls: 11, cost: 0.89, share: 0.22 },
  { provider: 'zen', model: 'haiku-4.5', calls: 18, cost: 0.24, share: 0.06 },
  { provider: 'go', model: 'glm-5.1', calls: 14, cost: 0.52, share: 0.13 },
  { provider: 'go', model: 'qwen3.6', calls: 22, cost: 0.31, share: 0.08 },
  { provider: 'go', model: 'kimi k2.5', calls: 31, cost: 0.68, share: 0.17 },
];

const initialShapes: ObservedShape[] = [
  {
    agentId: 'ag_orch',
    agentName: 'orch-a',
    accent: 'molten',
    shape: 'coordinator-shaped',
    breakdown: '12 delegations · 3 patches · 0 reads',
  },
  {
    agentId: 'ag_arch',
    agentName: 'arch-a',
    accent: 'iris',
    shape: 'planner-shaped',
    breakdown: '6 delegations · 1 patch · 8 reads',
  },
  {
    agentId: 'ag_coder',
    agentName: 'coder-a',
    accent: 'mint',
    shape: 'implementer-shaped',
    breakdown: '0 delegations · 14 patches · 22 reads',
  },
  {
    agentId: 'ag_review',
    agentName: 'review-a',
    accent: 'fog',
    shape: 'verifier-shaped',
    breakdown: '0 delegations · 2 patches · 18 reads',
  },
  {
    agentId: 'ag_research',
    agentName: 'research-a',
    accent: 'amber',
    shape: 'investigator-shaped',
    breakdown: '1 delegation · 0 patches · 31 searches',
  },
];

const accentStripe: Record<ObservedShape['accent'], string> = {
  molten: 'bg-molten',
  mint: 'bg-mint',
  iris: 'bg-iris',
  amber: 'bg-amber',
  fog: 'bg-fog-500',
};

const accentText: Record<ObservedShape['accent'], string> = {
  molten: 'text-molten',
  mint: 'text-mint',
  iris: 'text-iris',
  amber: 'text-amber',
  fog: 'text-fog-300',
};

const providerFill: Record<'zen' | 'go', string> = {
  zen: 'bg-molten',
  go: 'bg-mint',
};

export function RoutingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [costCap, setCostCap] = useState(5.0);
  const [tokenCap, setTokenCap] = useState(200_000);
  const [minutesCap, setMinutesCap] = useState(15);
  const [zenCeiling, setZenCeiling] = useState(60);
  const [goCeiling, setGoCeiling] = useState(100);

  const dispatch = initialDispatch;
  const shapes = initialShapes;

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
        </div>

        <div className="rounded-md hairline bg-ink-900/50 overflow-hidden">
          <div className="px-3 h-8 hairline-b flex items-center gap-2">
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
              observed shapes
            </span>
            <Tooltip
              side="top"
              wide
              content={
                <div className="space-y-1">
                  <div className="font-mono text-[11px] text-fog-200">
                    derived, not declared
                  </div>
                  <div className="font-mono text-[10.5px] text-fog-500">
                    shapes come from what each agent actually did this run — tool mix, delegation count, patch count. they describe behavior; they never bind it. to shift an agent's shape, influence its seed prompt at spawn, not its label here.
                  </div>
                </div>
              }
            >
              <span className="ml-auto font-mono text-[10.5px] text-fog-700 cursor-help underline decoration-dotted decoration-fog-800 underline-offset-[3px]">
                why read-only?
              </span>
            </Tooltip>
          </div>
          <ul>
            {shapes.map((s) => (
              <li
                key={s.agentId}
                className="px-3 h-9 hairline-b last:border-b-0 flex items-center gap-3"
              >
                <span className={clsx('w-[3px] h-5 shrink-0', accentStripe[s.accent])} />
                <div className="w-20 font-mono text-[11px] text-fog-200 truncate">
                  {s.agentName}
                </div>
                <div className={clsx('font-mono text-[11px]', accentText[s.accent])}>
                  {s.shape}
                </div>
                <div className="ml-auto font-mono text-[10.5px] text-fog-600 tabular-nums">
                  {s.breakdown}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center gap-2">
          <button className="h-8 px-3 rounded font-mono text-micro uppercase tracking-wider bg-ink-900 hairline text-fog-400 hover:border-ink-500 transition">
            reset defaults
          </button>
          <span className="font-mono text-micro text-fog-700">
            bounds apply to next dispatch · shapes refresh from behavior
          </span>
          <button
            onClick={onClose}
            className="ml-auto h-8 px-4 rounded font-mono text-micro uppercase tracking-wider bg-molten/15 hover:bg-molten/25 text-molten border border-molten/30 transition"
          >
            save
          </button>
        </div>
      </div>
    </Modal>
  );
}

function BudgetBar({
  label,
  used,
  cap,
  onChangeCap,
  format,
  step,
  min,
  max,
}: {
  label: string;
  used: number;
  cap: number;
  onChangeCap: (v: number) => void;
  format: (v: number) => string;
  step: number;
  min: number;
  max: number;
}) {
  const pct = Math.min(100, (used / cap) * 100);
  return (
    <div className="grid grid-cols-[70px_1fr_120px_80px] items-center gap-2">
      <span className="font-mono text-[10.5px] uppercase tracking-widest2 text-fog-600">
        {label}
      </span>
      <div className="h-2 rounded-full bg-ink-900 overflow-hidden">
        <div
          className={clsx(
            'h-full transition-all',
            pct > 80 ? 'bg-rust' : pct > 60 ? 'bg-amber' : 'bg-mint/70'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-[10.5px] tabular-nums text-fog-300 text-right">
        {format(used)} / {format(cap)}
      </span>
      <input
        type="range"
        value={cap}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChangeCap(Number(e.target.value))}
        className="accent-molten cursor-pointer"
        aria-label={`${label} cap`}
      />
    </div>
  );
}

function DispatchStack({ dispatch }: { dispatch: DispatchSlice[] }) {
  return (
    <div className="h-3 rounded-sm overflow-hidden flex hairline bg-ink-900">
      {dispatch.map((d) => (
        <Tooltip
          key={d.model}
          side="top"
          content={
            <div className="font-mono text-[10.5px]">
              <span className="text-fog-200">{d.model}</span>
              <span className="text-fog-500">
                {' '}· {d.calls} calls · ${d.cost.toFixed(2)}
              </span>
            </div>
          }
        >
          <div
            className={clsx(
              'h-full cursor-help transition hover:brightness-125',
              providerFill[d.provider],
              d.provider === 'zen' ? 'opacity-100' : 'opacity-80'
            )}
            style={{ width: `${d.share * 100}%` }}
          />
        </Tooltip>
      ))}
    </div>
  );
}

function CeilingRow({
  label,
  hint,
  value,
  onChange,
  accent,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
  accent: 'molten' | 'mint';
}) {
  return (
    <div className="grid grid-cols-[70px_1fr_140px] items-center gap-2">
      <div className="flex items-center gap-2">
        <span className={clsx('w-[3px] h-4', accentStripe[accent])} />
        <span className="font-mono text-[11px] text-fog-200">{label}</span>
      </div>
      <input
        type="range"
        value={value}
        min={0}
        max={100}
        step={5}
        onChange={(e) => onChange(Number(e.target.value))}
        className={clsx(
          'cursor-pointer',
          accent === 'molten' ? 'accent-molten' : 'accent-mint'
        )}
        aria-label={`${label} ceiling`}
      />
      <div className="flex items-center gap-2 justify-end">
        <span className="font-mono text-[10.5px] text-fog-700">{hint}</span>
        <span className="font-mono text-[11px] text-fog-200 tabular-nums w-8 text-right">
          {value}%
        </span>
      </div>
    </div>
  );
}

function ObservationTooltip() {
  return (
    <div className="space-y-2 w-[320px]">
      <div>
        <div className="font-mono text-micro uppercase tracking-widest2 text-molten">
          observation = watched + bounded
        </div>
        <div className="font-mono text-[10.5px] text-fog-400 leading-snug mt-0.5">
          you set bounds on the run; agents self-select providers within them. this panel shows what actually happened. no per-agent assignments live here — never have, never will.
        </div>
      </div>

      <div className="hairline-t pt-1.5">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500 mb-1">
          cues this is observation not control
        </div>
        <ul className="space-y-0.5 font-mono text-[10.5px] text-fog-400 leading-snug">
          <li>
            · verbs are <span className="text-fog-200">save</span> /{' '}
            <span className="text-fog-200">reset</span>, not{' '}
            <span className="text-fog-700 line-through">halt</span> /{' '}
            <span className="text-fog-700 line-through">pin</span>
          </li>
          <li>· bounds are caps + ceilings, never per-agent routes</li>
          <li>
            · shapes are <span className="text-fog-200">derived</span> from behavior,
            read-only
          </li>
        </ul>
      </div>

      <div className="hairline-t pt-1.5">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500 mb-1">
          what's gone on purpose
        </div>
        <div className="font-mono text-[10.5px] text-fog-400 leading-snug">
          no{' '}
          <span className="text-fog-700 line-through">
            if role=X then provider=Y
          </span>
          . role-pinning reproduced a supervisor-worker dialectic the swarm refuses. agents route themselves; humans observe and bound.
        </div>
      </div>

      <div className="hairline-t pt-1.5">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500 mb-1">
          stays pure on purpose
        </div>
        <div className="font-mono text-[10.5px] text-fog-400 leading-snug">
          no kill switch or force-redispatch here — imperatives live in the inspector and command palette. one panel, one contract.
        </div>
      </div>

      <div className="hairline-t pt-1.5">
        <div className="font-mono text-[9.5px] text-fog-700 leading-snug">
          analogs · budget envelope · carbon cap-and-trade · tcp congestion window · price ceilings
        </div>
      </div>
    </div>
  );
}
