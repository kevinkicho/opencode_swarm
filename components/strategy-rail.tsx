'use client';

// Strategy rail — pattern-specific tab for `orchestrator-worker`. A
// vertical timeline of planner sweeps, newest-first. Each row =
// one sweep. Iris stripe when the sweep actually changed the plan
// (added+removed > 0 or rephrased > 0). Fog-muted when a sweep
// confirmed the existing plan without changes.
//
// Spec frozen in docs/PATTERN_DESIGN/orchestrator-worker.md §3.
//
// Data flow: useStrategy polls /api/swarm/run/:id/strategy on a 5s
// cadence. The endpoint reads plan_revisions (one row per sweep,
// authored by runPlannerSweep). Empty state when sweepCount === 0;
// "no re-plans" when sweepCount === 1.

import clsx from 'clsx';
import { useMemo, useState } from 'react';

import { useStrategy, type PlanRevisionWire } from '@/lib/blackboard/strategy';

function fmtAge(ms: number): string {
  const now = Date.now();
  const dt = Math.max(0, now - ms);
  const s = Math.floor(dt / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function changedClass(rev: PlanRevisionWire): boolean {
  return rev.addedCount > 0 || rev.removedCount > 0 || rev.rephrasedCount > 0;
}

export function StrategyRail({
  swarmRunID,
  embedded = false,
}: {
  swarmRunID: string;
  embedded?: boolean;
}) {
  const { revisions, loading, error } = useStrategy(swarmRunID);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [replanState, setReplanState] = useState<'idle' | 'firing' | 'queued' | 'failed'>('idle');

  const headerStatus = useMemo(() => {
    if (loading && revisions.length === 0) return 'loading…';
    if (error) return `error: ${error}`;
    if (revisions.length === 0) return 'no sweeps yet';
    const latest = revisions[0];
    return `R${latest.round} · last sweep ${fmtAge(latest.createdAt)} ago · ${revisions.length} sweep${revisions.length === 1 ? '' : 's'}`;
  }, [loading, error, revisions]);

  // PATTERN_DESIGN/orchestrator-worker.md I3 — manual replan trigger.
  // POST /api/swarm/run/:id/replan returns 202 immediately. We render
  // a transient "queued" state that auto-resets so repeated clicks
  // produce repeated background sweeps without a permanent label
  // change.
  const fireReplan = async (): Promise<void> => {
    if (replanState === 'firing') return;
    setReplanState('firing');
    try {
      const res = await fetch(`/api/swarm/run/${swarmRunID}/replan`, {
        method: 'POST',
      });
      if (!res.ok) {
        setReplanState('failed');
        setTimeout(() => setReplanState('idle'), 3000);
        return;
      }
      setReplanState('queued');
      setTimeout(() => setReplanState('idle'), 3000);
    } catch {
      setReplanState('failed');
      setTimeout(() => setReplanState('idle'), 3000);
    }
  };

  if (revisions.length === 0) {
    return wrap(
      embedded,
      headerStatus,
      replanState,
      fireReplan,
      <div className="px-3 py-4 font-mono text-micro uppercase tracking-widest2 text-fog-700">
        {loading
          ? 'awaiting first plan — orchestrator is thinking'
          : 'no plan revisions logged yet'}
      </div>,
    );
  }

  return wrap(
    embedded,
    headerStatus,
    replanState,
    fireReplan,
    <ul className="flex-1 overflow-y-auto overflow-x-hidden py-1 list-none min-h-0">
      {revisions.map((rev) => (
        <StrategyRowEl
          key={rev.id}
          rev={rev}
          expanded={expandedId === rev.id}
          onToggle={() => setExpandedId((v) => (v === rev.id ? null : rev.id))}
        />
      ))}
    </ul>,
  );
}

function wrap(
  embedded: boolean,
  headerStatus: string,
  replanState: 'idle' | 'firing' | 'queued' | 'failed',
  fireReplan: () => void,
  body: React.ReactNode,
) {
  const replanLabel =
    replanState === 'firing'
      ? 'queueing…'
      : replanState === 'queued'
        ? 'queued ✓'
        : replanState === 'failed'
          ? 'failed'
          : '↻ replan';
  const replanTone =
    replanState === 'queued'
      ? 'text-mint border-mint/40'
      : replanState === 'failed'
        ? 'text-rust border-rust/40'
        : 'text-fog-400 border-fog-700 hover:text-iris hover:border-iris/40';
  const header = (
    <div className="h-7 hairline-b px-3 flex items-center gap-2 bg-ink-850/80 backdrop-blur shrink-0">
      <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600 shrink-0">
        strategy
      </span>
      <span className="font-mono text-micro tabular-nums text-fog-700 truncate">
        {headerStatus}
      </span>
      <button
        type="button"
        onClick={fireReplan}
        disabled={replanState === 'firing'}
        title="Trigger a fresh planner sweep on this run (PATTERN_DESIGN/orchestrator-worker.md I3)"
        className={clsx(
          'ml-auto h-5 px-1.5 rounded border bg-ink-900/60 font-mono text-[9.5px] uppercase tracking-widest2 transition cursor-pointer',
          replanTone,
          replanState === 'firing' && 'opacity-60 cursor-wait',
        )}
      >
        {replanLabel}
      </button>
    </div>
  );
  if (embedded) return <>{header}{body}</>;
  return (
    <section className="relative flex flex-col min-w-0 shrink-0 overflow-hidden bg-ink-850 max-h-[420px]">
      {header}
      {body}
    </section>
  );
}

function StrategyRowEl({
  rev,
  expanded,
  onToggle,
}: {
  rev: PlanRevisionWire;
  expanded: boolean;
  onToggle: () => void;
}) {
  const changed = changedClass(rev);
  const snap = rev.boardSnapshot;
  const snapChip =
    snap.total > 0
      ? `${snap.done}/${snap.total}${snap.inProgress + snap.claimed > 0 ? ` · ${snap.inProgress + snap.claimed}ip` : ''}${snap.stale > 0 ? ` · ${snap.stale}stale` : ''}`
      : '—';

  return (
    <li
      className={clsx(
        'relative cursor-pointer transition',
        expanded ? 'bg-ink-800/60' : 'hover:bg-ink-800/40',
      )}
      onClick={onToggle}
      title={`Sweep #${rev.round} — click to ${expanded ? 'collapse' : 'expand'}`}
    >
      {/* Iris stripe on the leading edge marks "this sweep changed the plan" */}
      <div
        className={clsx(
          'absolute left-0 top-0 bottom-0 w-0.5',
          changed ? 'bg-iris/70' : 'bg-fog-800',
        )}
      />
      <div
        className="h-6 pl-3 pr-3 grid items-center gap-1.5 text-[10.5px] font-mono"
        style={{
          // round 28 · time 36 · snap 116 · added 28 · removed 28 · rephrased 28 · excerpt flex
          gridTemplateColumns: '28px 36px 116px 28px 28px 28px minmax(0, 1fr)',
        }}
      >
        <span className="text-fog-400 tabular-nums">#{rev.round}</span>
        <span className="text-fog-500 tabular-nums">{fmtAge(rev.createdAt)}</span>
        <span className="text-fog-500 tabular-nums truncate" title={`board: ${snap.total} total · ${snap.open} open · ${snap.claimed} claimed · ${snap.inProgress} in-progress · ${snap.done} done · ${snap.stale} stale · ${snap.blocked} blocked`}>
          {snapChip}
        </span>
        <span
          className={clsx(
            'tabular-nums text-right',
            rev.addedCount > 0 ? 'text-mint' : 'text-fog-700',
          )}
          title={`${rev.addedCount} added`}
        >
          {rev.addedCount > 0 ? `+${rev.addedCount}` : '·'}
        </span>
        <span
          className={clsx(
            'tabular-nums text-right',
            rev.removedCount > 0 ? 'text-rust' : 'text-fog-700',
          )}
          title={`${rev.removedCount} removed`}
        >
          {rev.removedCount > 0 ? `-${rev.removedCount}` : '·'}
        </span>
        <span
          className={clsx(
            'tabular-nums text-right',
            rev.rephrasedCount > 0 ? 'text-amber' : 'text-fog-700',
          )}
          title={`${rev.rephrasedCount} rephrased`}
        >
          {rev.rephrasedCount > 0 ? `~${rev.rephrasedCount}` : '·'}
        </span>
        <span className="text-fog-400 truncate" title={rev.excerpt ?? ''}>
          {rev.excerpt ?? <span className="text-fog-700">—</span>}
        </span>
      </div>
      {expanded && <ExpandedDelta rev={rev} />}
    </li>
  );
}

function ExpandedDelta({ rev }: { rev: PlanRevisionWire }) {
  if (rev.added.length === 0 && rev.removed.length === 0 && rev.rephrased.length === 0) {
    return (
      <div className="px-6 pb-2 pt-0 font-mono text-[10px] text-fog-700 uppercase tracking-widest2">
        sweep confirmed plan without changes
      </div>
    );
  }
  return (
    <div className="px-6 pb-2 pt-0 space-y-1.5 font-mono text-[10px]">
      {rev.added.length > 0 && (
        <DeltaList label="added" tone="mint" items={rev.added} />
      )}
      {rev.removed.length > 0 && (
        <DeltaList label="removed" tone="rust" items={rev.removed} />
      )}
      {rev.rephrased.length > 0 && (
        <div>
          <div className="text-amber uppercase tracking-widest2 text-[9px] mb-0.5">
            rephrased ({rev.rephrased.length})
          </div>
          <ul className="list-none space-y-0.5">
            {rev.rephrased.map((r, i) => (
              <li key={i} className="text-fog-400">
                <span className="text-fog-700 line-through">{r.before}</span>
                <span className="text-fog-700"> → </span>
                <span>{r.after}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DeltaList({
  label,
  tone,
  items,
}: {
  label: string;
  tone: 'mint' | 'rust' | 'amber';
  items: string[];
}) {
  const toneClass =
    tone === 'mint' ? 'text-mint' : tone === 'rust' ? 'text-rust' : 'text-amber';
  return (
    <div>
      <div
        className={clsx(
          'uppercase tracking-widest2 text-[9px] mb-0.5',
          toneClass,
        )}
      >
        {label} ({items.length})
      </div>
      <ul className="list-none space-y-0.5">
        {items.map((s, i) => (
          <li key={i} className="text-fog-400">
            {s}
          </li>
        ))}
      </ul>
    </div>
  );
}
