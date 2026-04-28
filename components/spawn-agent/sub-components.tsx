'use client';

// Visual subcomponents for the spawn-agent modal.
//
// Mirrors the components/new-run/sub-components.tsx split — same shapes
// (Section, HeaderCell, ModelNameCell, FamilyCell, PriceCell), plus
// spawn-specific footer affordances (SpawnModeToggle, SpawnButton).
//
// Kept as a sibling file rather than dedup'd against new-run/ because
// FamilyCell uses a slightly wider column here (w-[92px] vs w-[82px])
// — the spawn picker has fewer columns so the family label gets more
// room. Forcing both sites onto one width would compromise one or the
// other; a 6-line helper duplication is the cheaper choice.
//
// Lifted from spawn-agent-modal.tsx 2026-04-28 to shrink the modal's
// render block — every helper here is purely presentational.

import clsx from 'clsx';
import type React from 'react';
import { Tooltip } from '../ui/tooltip';
import {
  familyMeta,
  type ZenFamily as Family,
} from '@/lib/zen-catalog';

export type SpawnState = 'idle' | 'verifying' | 'failed' | 'verified';
export type SpawnMode = 'idle' | 'active';

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

export function FamilyCell({ family }: { family: Family }) {
  const meta = familyMeta[family];
  return (
    <span
      className={clsx(
        'font-mono text-[10px] uppercase tracking-wider w-[92px] truncate',
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

export function SpawnModeToggle({
  mode,
  onChange,
}: {
  mode: SpawnMode;
  onChange: (m: SpawnMode) => void;
}) {
  return (
    <Tooltip
      side="top"
      align="end"
      wide
      content={
        <div className="space-y-1">
          <div className="font-mono text-[11px] text-fog-200">spawn mode</div>
          <div className="font-mono text-[10.5px] text-fog-500 leading-snug">
            <span className="text-fog-200">idle</span> sits in the roster until
            another agent dispatches it via the task tool good for on-demand peers.
          </div>
          <div className="font-mono text-[10.5px] text-fog-500 leading-snug">
            <span className="text-mint">active</span> boots warm and immediately
            advertises availability good for long-running watchers and monitors.
          </div>
        </div>
      }
    >
      <span className="inline-flex items-center h-8 hairline rounded p-0.5 bg-ink-900 cursor-help">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onChange('idle');
          }}
          className={clsx(
            'h-7 px-2.5 rounded font-mono text-micro uppercase tracking-wider transition',
            mode === 'idle'
              ? 'bg-ink-800 text-fog-200 hairline'
              : 'text-fog-600 hover:text-fog-300'
          )}
        >
          idle
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onChange('active');
          }}
          className={clsx(
            'h-7 px-2.5 rounded font-mono text-micro uppercase tracking-wider transition',
            mode === 'active'
              ? 'bg-ink-800 text-mint hairline'
              : 'text-fog-600 hover:text-fog-300'
          )}
        >
          active
        </button>
      </span>
    </Tooltip>
  );
}

export function SpawnButton({
  state,
  mode,
  onClick,
  disabled,
}: {
  state: SpawnState;
  mode: SpawnMode;
  onClick: () => void;
  disabled?: boolean;
}) {
  if (state === 'verifying') {
    return (
      <button
        disabled
        className="h-8 px-4 rounded font-mono text-micro uppercase tracking-wider bg-amber/10 text-amber border border-amber/30 transition flex items-center gap-2 cursor-wait"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber animate-pulse" />
        spawning…
      </button>
    );
  }
  if (state === 'verified') {
    return (
      <button
        disabled
        className="h-8 px-4 rounded font-mono text-micro uppercase tracking-wider bg-mint/10 text-mint border border-mint/30 transition flex items-center gap-2"
      >
        spawned {mode}
      </button>
    );
  }
  if (state === 'failed') {
    return (
      <button
        onClick={onClick}
        disabled={disabled}
        className={clsx(
          'h-8 px-4 rounded font-mono text-micro uppercase tracking-wider transition flex items-center gap-2',
          disabled
            ? 'bg-ink-800 text-fog-600 border border-ink-700 cursor-not-allowed'
            : 'bg-rust/15 hover:bg-rust/25 text-rust border border-rust/30'
        )}
      >
        retry spawn
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'h-8 px-4 rounded font-mono text-micro uppercase tracking-wider transition',
        disabled
          ? 'bg-ink-800 text-fog-600 border border-ink-700 cursor-not-allowed'
          : 'bg-molten/15 hover:bg-molten/25 text-molten border border-molten/30'
      )}
    >
      spawn {mode === 'active' ? 'active' : 'agent'}
    </button>
  );
}
