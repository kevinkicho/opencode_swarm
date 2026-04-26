// Visual subcomponents extracted from new-run-modal.tsx as part of the
// 2026-04-26 component decomposition pass. The modal's body now reads as
// the actual flow (state, validators, sections, launch handler) without
// having to scroll past several hundred lines of presentation primitives.
//
// All purely presentational — no shared state, no side effects. Inlined
// here rather than scattered into per-component files because they're
// only used by NewRunModal and a per-file split would be more cognitive
// overhead than the small win is worth.

import clsx from 'clsx';
import type React from 'react';
import { Tooltip } from '../ui/tooltip';
import {
  familyMeta,
  type ZenFamily,
} from '@/lib/zen-catalog';
import {
  patternAccentText,
  patternAccentBorder,
  type PatternMeta,
} from '@/lib/swarm-patterns';

export function Section({
  step,
  label,
  hint,
  optional,
  trailing,
  children,
}: {
  step: string;
  label: string;
  hint?: string;
  optional?: boolean;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  const labelEl = (
    <span
      className={clsx(
        'font-mono text-micro uppercase tracking-widest2 text-fog-300 transition',
        hint &&
          'cursor-help border-b border-dotted border-fog-700 hover:text-fog-100 hover:border-fog-500'
      )}
    >
      {label}
    </span>
  );
  return (
    <section>
      <header className="flex items-center gap-2 mb-2">
        <span className="font-mono text-micro text-fog-700 tabular-nums">{step}</span>
        {hint ? (
          <Tooltip side="top" align="start" wide content={hint}>
            {labelEl}
          </Tooltip>
        ) : (
          labelEl
        )}
        {optional && (
          <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 border border-ink-600 rounded-[3px] px-1 h-3.5 inline-flex items-center">
            optional
          </span>
        )}
        {trailing && <span className="ml-auto">{trailing}</span>}
      </header>
      {children}
    </section>
  );
}

export function CountStepper({
  count,
  onMinus,
  onPlus,
}: {
  count: number;
  onMinus: () => void;
  onPlus: () => void;
}) {
  return (
    <div className="w-[74px] flex items-center justify-end gap-0.5 shrink-0">
      {count > 0 ? (
        <button
          onClick={onMinus}
          className="w-4 h-4 rounded-[3px] bg-ink-900 hairline text-fog-400 hover:text-fog-100 hover:border-ink-500 transition font-mono text-[11px] flex items-center justify-center"
        >
          −
        </button>
      ) : (
        <span className="w-4 h-4" aria-hidden />
      )}
      <span
        className={clsx(
          'w-6 text-center font-mono text-[11px] tabular-nums',
          count > 0 ? 'text-molten' : 'text-fog-700'
        )}
      >
        {count || '·'}
      </span>
      <button
        onClick={onPlus}
        className="w-4 h-4 rounded-[3px] hairline bg-ink-900 text-fog-400 hover:text-fog-100 hover:border-ink-500 transition font-mono text-[11px] flex items-center justify-center"
      >
        +
      </button>
    </div>
  );
}

export function BoundRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="grid grid-cols-[70px_1fr_80px] items-center gap-2">
      <span className="font-mono text-[10.5px] uppercase tracking-widest2 text-fog-600">
        {label}
      </span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-molten cursor-pointer"
        aria-label={`${label} cap`}
      />
      <span className="font-mono text-[11px] tabular-nums text-fog-300 text-right">
        {format(value)}
      </span>
    </div>
  );
}

export function PatternCard({
  meta,
  active,
  onClick,
}: {
  meta: PatternMeta;
  active: boolean;
  onClick: () => void;
}) {
  const disabled = !meta.available;
  const accentText = patternAccentText[meta.accent];
  const accentBorder = patternAccentBorder[meta.accent];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      className={clsx(
        'relative rounded-md hairline p-2.5 text-left transition',
        disabled && 'opacity-50 cursor-not-allowed',
        !disabled && !active && 'bg-ink-900/40 hover:bg-ink-800/60',
        !disabled && active && clsx('bg-ink-800', accentBorder),
        disabled && 'bg-ink-900/40'
      )}
    >
      <div
        className={clsx(
          'font-mono text-[11px] uppercase tracking-widest2 mb-1',
          active ? accentText : 'text-fog-400'
        )}
      >
        {meta.label}
      </div>
      <div className="font-mono text-[10px] text-fog-500 leading-snug">
        {meta.tagline}
      </div>
      <div className="font-mono text-[9.5px] text-fog-700 leading-snug mt-1 tabular-nums">
        {meta.shape}
      </div>
      {active && (
        <div className="font-mono text-[9.5px] text-fog-600 leading-snug mt-1">
          <span className="text-fog-700">fit: </span>
          {meta.fit}
        </div>
      )}
      {disabled && (
        <span className="absolute top-1.5 right-1.5 font-mono text-[8.5px] uppercase tracking-widest2 text-fog-700 border border-ink-700 rounded-[3px] px-1 h-3.5 inline-flex items-center bg-ink-900">
          soon
        </span>
      )}
    </button>
  );
}

export function StrategyCard({
  active,
  onClick,
  icon,
  title,
  body,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
  accent: 'molten' | 'amber' | 'mint';
}) {
  const accentText =
    accent === 'molten'
      ? 'text-molten'
      : accent === 'amber'
        ? 'text-amber'
        : 'text-mint';
  const accentBorder =
    accent === 'molten'
      ? 'border-molten/40'
      : accent === 'amber'
        ? 'border-amber/40'
        : 'border-mint/40';
  return (
    <button
      onClick={onClick}
      className={clsx(
        'rounded-md hairline p-2.5 text-left transition',
        active
          ? clsx('bg-ink-800', accentBorder)
          : 'bg-ink-900/40 hover:bg-ink-800/60'
      )}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span className={clsx(active ? accentText : 'text-fog-500')}>{icon}</span>
        <span
          className={clsx(
            'font-mono text-[11px] uppercase tracking-widest2',
            active ? accentText : 'text-fog-400'
          )}
        >
          {title}
        </span>
      </div>
      <div className="font-mono text-[10px] text-fog-600 leading-snug">{body}</div>
    </button>
  );
}

export function ModeButton({
  active,
  onClick,
  label,
  accent,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  accent: 'molten' | 'amber' | 'mint';
  hint?: React.ReactNode;
}) {
  const accentCls =
    accent === 'molten'
      ? 'text-molten'
      : accent === 'amber'
        ? 'text-amber'
        : 'text-mint';
  const btn = (
    <button
      onClick={onClick}
      className={clsx(
        'h-7 px-3 rounded font-mono text-micro uppercase tracking-wider transition',
        active
          ? clsx('bg-ink-800 hairline', accentCls)
          : 'text-fog-600 hover:text-fog-300'
      )}
    >
      {label}
    </button>
  );
  if (!hint) return btn;
  return (
    <Tooltip side="bottom" align="start" wide content={hint}>
      {btn}
    </Tooltip>
  );
}

export function ModeHint({
  accent,
  posture,
  body,
  when,
}: {
  accent: 'molten' | 'amber' | 'mint';
  posture: string;
  body: string;
  when: string;
}) {
  const accentCls =
    accent === 'molten'
      ? 'text-molten'
      : accent === 'amber'
        ? 'text-amber'
        : 'text-mint';
  return (
    <div className="space-y-1">
      <div
        className={clsx(
          'font-mono text-micro uppercase tracking-widest2',
          accentCls
        )}
      >
        {posture}
      </div>
      <div className="font-mono text-[10.5px] text-fog-400 leading-snug">
        {body}
      </div>
      <div className="font-mono text-[10px] text-fog-600 leading-snug">
        {when}
      </div>
    </div>
  );
}

export function LabelRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 h-5">
      <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-600 w-16 shrink-0">
        {label}
      </span>
      <div className="flex items-center gap-1.5 ml-auto">{children}</div>
    </div>
  );
}

export function InferBlock({
  title,
  items,
  mono,
}: {
  title: string;
  items: string[];
  mono?: boolean;
}) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600 mb-0.5">
        {title}
      </div>
      <ul className="space-y-0.5">
        {items.map((it) => (
          <li
            key={it}
            className={clsx(
              'text-[10.5px] text-fog-400 leading-snug truncate',
              mono ? 'font-mono' : ''
            )}
          >
            · {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HeaderCell({ cls, children }: { cls: string; children: React.ReactNode }) {
  return (
    <span
      className={clsx(
        'font-mono text-[9.5px] uppercase tracking-widest2 text-fog-600 truncate',
        cls
      )}
    >
      {children}
    </span>
  );
}

export function ModelNameCell({ label, active }: { label: string; active: boolean }) {
  return (
    <span className="flex-1 min-w-0 flex items-center">
      <span
        className={clsx(
          'font-mono text-[11.5px] truncate',
          active ? 'text-fog-100' : 'text-fog-300'
        )}
      >
        {label}
      </span>
    </span>
  );
}

export function FamilyCell({ family }: { family: ZenFamily }) {
  const meta = familyMeta[family];
  return (
    <span
      className={clsx(
        'font-mono text-[10px] uppercase tracking-wider w-[82px] truncate',
        meta.color
      )}
    >
      {meta.label}
    </span>
  );
}

export function PriceCell({
  value,
  cls,
  muted,
}: {
  value: string;
  cls: string;
  muted?: boolean;
}) {
  return (
    <span
      className={clsx(
        'font-mono text-[11px] tabular-nums truncate',
        cls,
        muted ? 'text-fog-500' : 'text-fog-200'
      )}
    >
      {value}
    </span>
  );
}

export function InitiateTooltip() {
  return (
    <div className="space-y-2 w-[320px]">
      <div>
        <div className="font-mono text-micro uppercase tracking-widest2 text-molten">
          initiate = seed + substrate
        </div>
        <div className="font-mono text-[10.5px] text-fog-400 leading-snug mt-0.5">
          a run is anchored to a source and a workspace. everything else is optional —
          directive, team, bounds. blank fields hand control back to the swarm.
        </div>
      </div>
      <div className="hairline-t pt-1.5">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500 mb-1">
          what stays sacred
        </div>
        <ul className="space-y-0.5 font-mono text-[10.5px] text-fog-400 leading-snug">
          <li>· source — the github repo agents read and write</li>
          <li>· workspace — parent directory where the clone lands</li>
          <li>· start mode — dry-run / live / spectator</li>
          <li>· branch strategy — how writes land</li>
        </ul>
      </div>
      <div className="hairline-t pt-1.5">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500 mb-1">
          what the swarm can set itself
        </div>
        <ul className="space-y-0.5 font-mono text-[10.5px] text-fog-400 leading-snug">
          <li>· goal — inferred from readme / commits / issues</li>
          <li>· team — agents spawn as work demands</li>
          <li>· bounds — defaults if unbounded, revises mid-run</li>
        </ul>
      </div>
    </div>
  );
}
