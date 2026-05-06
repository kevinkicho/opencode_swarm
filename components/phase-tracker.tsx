'use client';

// PhaseTracker — pipeline phase progress rail.
//
// When the active run is a pipeline, each phase is a separate SwarmRunMeta
// linked via continuationOf. This component resolves the chain from
// runsSnapshot, maps each phase to its config pattern + status, and
// renders them as a vertical list. Clicking a phase navigates to that
// run's detail page.

import clsx from 'clsx';
import Link from 'next/link';
import type { SwarmRunListRow, SwarmRunMeta, SwarmRunStatus, PipelineConfig, PipelinePhase } from '@/lib/swarm-run-types';
import type { SwarmPattern } from '@/lib/swarm-types';
import { resolvePipelinePhases } from '@/lib/swarm-patterns';
import { patternMeta } from '@/lib/swarm-patterns';

type PhaseRow = {
  index: number;
  phase: PipelinePhase;
  status: SwarmRunStatus | null;
  swarmRunID: string | null;
  costTotal: number;
  tokensTotal: number;
};

// Resolve pipeline phases to PhaseRows. Walks the continuationOf chain
// starting from the pipeline watcher to find each phase run.
export function resolvePhases(
  pipelineMeta: SwarmRunMeta,
  allRows: SwarmRunListRow[],
): PhaseRow[] {
  const config = pipelineMeta.pipelineConfig;
  if (!config) return [];

  const phases = resolvePipelinePhases(config);
  const byId = new Map<string, SwarmRunListRow>();
  for (const r of allRows) byId.set(r.meta.swarmRunID, r);

  // Build continuation children: parentId → child row
  const children = new Map<string, SwarmRunListRow[]>();
  for (const r of allRows) {
    if (r.meta.continuationOf) {
      const arr = children.get(r.meta.continuationOf) ?? [];
      arr.push(r);
      children.set(r.meta.continuationOf, arr);
    }
  }

  // Walk the chain: pipeline → phase1 → phase2 → phase3
  const rows: PhaseRow[] = [];
  let parentId: string | null = pipelineMeta.swarmRunID;

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const childRows: SwarmRunListRow[] = parentId ? (children.get(parentId) ?? []) : [];

    // Find the child whose pattern matches this phase's pattern. If multiple
    // children share the same continuationOf (shouldn't happen for pipeline,
    // but defensive), pick the one created first.
    const match: SwarmRunListRow | null = childRows
      .filter((c: SwarmRunListRow) => c.meta.pattern === phase.pattern)
      .sort((a: SwarmRunListRow, b: SwarmRunListRow) => a.meta.createdAt - b.meta.createdAt)[0]
      ?? null;

    rows.push({
      index: i,
      phase,
      status: match?.status ?? null,
      swarmRunID: match?.meta.swarmRunID ?? null,
      costTotal: match?.costTotal ?? 0,
      tokensTotal: match?.tokensTotal ?? 0,
    });

    // Next phase continues from this one (or from pipeline if no match found)
    parentId = match?.meta.swarmRunID ?? parentId;
  }

  return rows;
}

const STATUS_DOT: Record<string, string> = {
  live: 'bg-molten animate-pulse-ring',
  idle: 'bg-mint',
  error: 'bg-rust',
  stale: 'bg-fog-600',
  unknown: 'bg-fog-700',
};

const STATUS_LABEL: Record<string, string> = {
  live: 'active',
  idle: 'idle',
  error: 'error',
  stale: 'done',
  unknown: '—',
};

function PhaseStatusDot({ status }: { status: SwarmRunStatus | null }) {
  const key = status ?? 'unknown';
  return (
    <span
      className={clsx(
        'w-1.5 h-1.5 rounded-full shrink-0',
        STATUS_DOT[key] ?? 'bg-fog-700',
      )}
    />
  );
}

function AccentStripe({ pattern }: { pattern: SwarmPattern }) {
  const accent = patternMeta[pattern]?.accent ?? 'fog';
  const tone: Record<string, string> = {
    molten: 'bg-molten',
    amber: 'bg-amber',
    mint: 'bg-mint',
    iris: 'bg-iris',
    rust: 'bg-rust',
    fog: 'bg-fog-500',
  };
  return <span className={clsx('absolute left-0 top-0 bottom-0 w-[2px]', tone[accent])} />;
}

export function PhaseTracker({
  phases,
  currentSwarmRunID,
}: {
  phases: PhaseRow[];
  // The pipeline watcher's own runID — used to detect which phase
  // corresponds to the currently-viewed run (highlight it).
  currentSwarmRunID?: string;
}) {
  if (phases.length === 0) {
    return (
      <ul className="flex-1 overflow-y-auto overflow-x-hidden py-1 list-none">
        <li className="px-3 py-3 font-mono text-micro uppercase tracking-widest2 text-fog-700">
          no phases resolved
        </li>
      </ul>
    );
  }

  // Find the currently active phase (first non-done, or last if all done)
  const activeIdx = phases.findIndex((p) => p.status === 'live' || p.status === 'idle')
    ?? phases.length - 1;

  return (
    <ul className="flex-1 overflow-y-auto overflow-x-hidden py-1 list-none">
      {/* Header showing pipeline progress */}
      <li className="px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
            pipeline
          </span>
          <span className="font-mono text-micro text-fog-700 tabular-nums">
            {phases.filter((p) => p.status === 'stale').length}/{phases.length} done
          </span>
        </div>
        {/* Phase progress bar — one segment per phase */}
        <div className="flex items-center gap-px mt-1 h-1 rounded-full overflow-hidden">
          {phases.map((row, i) => {
            const color = row.status === 'live' || row.status === 'idle'
              ? 'bg-molten'
              : row.status === 'stale'
              ? 'bg-mint/60'
              : row.status === 'error'
              ? 'bg-rust'
              : 'bg-fog-700';
            return (
              <div
                key={i}
                className={clsx('flex-1 h-full rounded-sm', color)}
              />
            );
          })}
        </div>
      </li>

      {phases.map((row) => {
        const meta = patternMeta[row.phase.pattern];
        const label = meta?.label ?? row.phase.pattern;
        const statusKey = row.status ?? 'unknown';
        const statusLabel = STATUS_LABEL[statusKey] ?? '—';
        const isActive = row.index === activeIdx;
        const isCurrentRun = row.swarmRunID === currentSwarmRunID;

        const content = (
          <div className={clsx(
            'relative w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-ink-800/40 transition',
            isActive && 'bg-ink-800/30',
            isCurrentRun && 'bg-molten/10',
          )}>
            <AccentStripe pattern={row.phase.pattern} />
            <PhaseStatusDot status={row.status} />
            <div className="flex flex-col min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 tabular-nums shrink-0">
                  P{row.index + 1}
                </span>
                <span className="font-mono text-[10.5px] text-fog-200 truncate min-w-0">
                  {label}
                </span>
                {isActive && (
                  <span className="font-mono text-[8px] uppercase tracking-widest2 text-molten shrink-0">
                    current
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={clsx(
                  'inline-flex items-center h-4 px-1 rounded-sm font-mono text-[9px] uppercase tracking-widest2 hairline',
                  statusKey === 'live' ? 'text-molten border-molten/30 bg-molten/10' :
                  statusKey === 'error' ? 'text-rust border-rust/30 bg-rust/10' :
                  statusKey === 'idle' ? 'text-mint border-mint/30 bg-mint/10' :
                  'text-fog-600 border-fog-700 bg-ink-900/70',
                )}>
                  {statusLabel}
                </span>
                {row.phase.directive && (
                  <span className="font-mono text-[9px] text-fog-600 truncate min-w-0">
                    {row.phase.directive}
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-col items-end shrink-0 gap-0.5">
              {row.tokensTotal > 0 && (
                <span className="font-mono text-[9px] text-fog-700 tabular-nums">
                  {(row.tokensTotal / 1000).toFixed(1)}k tok
                </span>
              )}
              {row.costTotal > 0 && (
                <span className="font-mono text-[9px] text-fog-700 tabular-nums">
                  ${row.costTotal.toFixed(2)}
                </span>
              )}
            </div>
          </div>
        );

        if (row.swarmRunID) {
          return (
            <li key={row.index} className="relative min-w-0">
              <Link href={`/?swarmRun=${row.swarmRunID}`} className="block">
                {content}
              </Link>
            </li>
          );
        }

        return (
          <li key={row.index} className="relative min-w-0 cursor-default">
            {content}
          </li>
        );
      })}
    </ul>
  );
}