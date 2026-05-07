'use client';

import clsx from 'clsx';
import type { AgentRollup, RunRetro } from '@/lib/server/memory/types';

interface CompareRun {
  swarmRunID: string;
  retro: RunRetro | null;
  agentRollups: AgentRollup[];
}

const OUTCOME_TONE: Record<string, string> = {
  completed: 'text-mint',
  aborted: 'text-rust',
  failed: 'text-rust',
};

function fmtCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

export function RetroCompareView({ runs }: { runs: CompareRun[] }) {
  return (
    <div className="min-h-screen bg-ink-900 text-fog-100 p-6">
      <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 mb-4">
        cross-run comparison · {runs.length} runs
      </div>
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${Math.min(runs.length, 4)}, 1fr)` }}>
        {runs.map((run) => (
          <div key={run.swarmRunID} className="rounded-md hairline bg-ink-850/60 p-3 space-y-2">
            <div className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
              {run.swarmRunID.slice(0, 16)}
            </div>
            {run.retro ? (
              <>
                <div className={clsx('font-mono text-xs font-medium', OUTCOME_TONE[run.retro.outcome] ?? 'text-fog-300')}>
                  {run.retro.outcome}
                </div>
                <div className="space-y-1">
                  <div className="font-mono text-[11px] text-fog-400 flex justify-between">
                    <span>duration</span>
                    <span className="tabular-nums text-fog-200">{fmtDuration(run.retro.timeline.durationMs)}</span>
                  </div>
                  <div className="font-mono text-[11px] text-fog-400 flex justify-between">
                    <span>tokens</span>
                    <span className="tabular-nums text-fog-200">{fmtTokens(run.retro.cost.tokensTotal)}</span>
                  </div>
                  <div className="font-mono text-[11px] text-fog-400 flex justify-between">
                    <span>cost</span>
                    <span className="tabular-nums text-fog-200">{fmtCost(run.retro.cost.costUSD)}</span>
                  </div>
                  <div className="font-mono text-[11px] text-fog-400 flex justify-between">
                    <span>agents</span>
                    <span className="tabular-nums text-fog-200">{run.agentRollups.length}</span>
                  </div>
                  <div className="font-mono text-[11px] text-fog-400 flex justify-between">
                    <span>commits</span>
                    <span className="tabular-nums text-fog-200">{run.retro.artifactGraph.commits.length}</span>
                  </div>
                  <div className="font-mono text-[11px] text-fog-400 flex justify-between">
                    <span>lessons</span>
                    <span className="tabular-nums text-fog-200">{run.retro.lessons.length}</span>
                  </div>
                </div>
                {run.retro.lessons.length > 0 && (
                  <div className="pt-1 space-y-0.5">
                    {run.retro.lessons.slice(0, 5).map((l, i) => (
                      <div key={i} className="font-mono text-[10px] text-fog-500 leading-snug">
                        <span className="text-fog-700">[{l.tag}]</span> {l.text.slice(0, 80)}{l.text.length > 80 ? '…' : ''}
                      </div>
                    ))}
                    {run.retro.lessons.length > 5 && (
                      <div className="font-mono text-[10px] text-fog-700">+{run.retro.lessons.length - 5} more</div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="font-mono text-[11px] text-fog-600 italic">no rollup data</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}