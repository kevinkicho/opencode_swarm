'use client';

import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { compact } from '@/lib/format';

export type StatKind = 'tokens' | 'cost' | 'duration' | 'status';

export interface StatSample {
  t: number; // seconds since stream start
  tokens: number;
  cost: number;
  duration: number; // elapsed wall time in seconds
  status: 'queued' | 'running' | 'complete' | 'error';
}

interface Seed {
  label: string;
  tokens: number;
  cost: number;
  duration?: number;
  status?: StatSample['status'];
}

export function StatsStream({
  seed,
  live = true,
}: {
  seed: Seed;
  live?: boolean;
}) {
  const [view, setView] = useState<'graph' | 'table'>('graph');
  const [metric, setMetric] = useState<StatKind>('tokens');
  const [samples, setSamples] = useState<StatSample[]>(() => buildHistory(seed));
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      setSamples((prev) => {
        const last = prev[prev.length - 1];
        const next = evolve(last, seed);
        const trimmed = prev.length > 60 ? prev.slice(-60) : prev;
        return [...trimmed, next];
      });
      rafRef.current = window.setTimeout(tick, 500) as unknown as number;
    };
    rafRef.current = window.setTimeout(tick, 500) as unknown as number;
    return () => {
      cancelled = true;
      if (rafRef.current) clearTimeout(rafRef.current);
    };
  }, [live, seed]);

  const latest = samples[samples.length - 1];

  return (
    <div className="w-[320px] p-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
          {seed.label}
        </span>
        <span
          className={clsx(
            'ml-auto flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest2',
            live && latest.status === 'running' ? 'text-molten' : statusColor(latest.status)
          )}
        >
          <span
            className={clsx(
              'w-1.5 h-1.5 rounded-full',
              statusDot(latest.status),
              latest.status === 'running' && 'animate-pulse-ring'
            )}
          />
          {latest.status}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-1">
        <MetricCell
          label="tokens"
          value={compact(latest.tokens)}
          active={metric === 'tokens'}
          onClick={() => setMetric('tokens')}
        />
        <MetricCell
          label="cost"
          value={`$${latest.cost.toFixed(3)}`}
          active={metric === 'cost'}
          onClick={() => setMetric('cost')}
        />
        <MetricCell
          label="dur"
          value={`${latest.duration.toFixed(1)}s`}
          active={metric === 'duration'}
          onClick={() => setMetric('duration')}
        />
        <MetricCell
          label="status"
          value={latest.status.slice(0, 4)}
          active={metric === 'status'}
          onClick={() => setMetric('status')}
        />
      </div>

      <div className="flex items-center gap-0.5 h-6 p-0.5 rounded bg-ink-850 hairline">
        <ViewTab label="graph" active={view === 'graph'} onClick={() => setView('graph')} />
        <ViewTab label="table" active={view === 'table'} onClick={() => setView('table')} />
      </div>

      {view === 'graph' ? (
        <Sparkline samples={samples} metric={metric} />
      ) : (
        <SampleTable samples={samples} metric={metric} />
      )}

      <div className="font-mono text-[10px] text-fog-600 opacity-20 hairline-t pt-1">
        streaming {live ? 'live' : 'paused'} . click cells to switch metric
      </div>
    </div>
  );
}

function MetricCell({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'rounded hairline px-1.5 py-1 text-left transition',
        active
          ? 'bg-molten/10 border-molten/40'
          : 'bg-ink-850 hover:border-ink-500'
      )}
    >
      <div className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600">
        {label}
      </div>
      <div
        className={clsx(
          'font-mono text-[11px] tabular-nums truncate',
          active ? 'text-molten' : 'text-fog-100'
        )}
      >
        {value}
      </div>
    </button>
  );
}

function ViewTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex-1 h-full rounded font-mono text-[10px] uppercase tracking-widest2 transition',
        active ? 'bg-ink-700 text-fog-100' : 'text-fog-500 hover:text-fog-200'
      )}
    >
      {label}
    </button>
  );
}

function Sparkline({
  samples,
  metric,
}: {
  samples: StatSample[];
  metric: StatKind;
}) {
  const W = 300;
  const H = 72;
  const PAD = 4;

  const values = samples.map((s) => metricValue(s, metric));
  const min = Math.min(...values, 0);
  const rawMax = Math.max(...values, 1);
  const max = rawMax === min ? min + 1 : rawMax;

  const points = values.map((v, i) => {
    const x = PAD + (i / Math.max(samples.length - 1, 1)) * (W - PAD * 2);
    const y = H - PAD - ((v - min) / (max - min)) * (H - PAD * 2);
    return [x, y] as const;
  });

  const pathD = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ');
  const areaD = `${pathD} L${(points[points.length - 1]?.[0] ?? W - PAD).toFixed(1)} ${H - PAD} L${PAD} ${H - PAD} Z`;

  const last = points[points.length - 1];
  const accent = metricHex(metric);

  return (
    <div className="relative rounded hairline bg-ink-950 overflow-hidden">
      <svg width={W} height={H} className="block">
        {/* baseline grid */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={PAD}
            x2={W - PAD}
            y1={PAD + f * (H - PAD * 2)}
            y2={PAD + f * (H - PAD * 2)}
            stroke="#1f232a"
            strokeWidth={0.5}
          />
        ))}
        <path d={areaD} fill={`${accent}18`} />
        <path
          d={pathD}
          fill="none"
          stroke={accent}
          strokeWidth={1.25}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {last && (
          <>
            <circle cx={last[0]} cy={last[1]} r={3} fill={accent} opacity={0.2} />
            <circle cx={last[0]} cy={last[1]} r={1.6} fill={accent} />
          </>
        )}
        <text
          x={W - PAD}
          y={PAD + 8}
          textAnchor="end"
          fontSize={9}
          fontFamily="ui-monospace, monospace"
          fill="#7d8798"
        >
          {formatValue(values[values.length - 1] ?? 0, metric)}
        </text>
        <text
          x={PAD}
          y={H - PAD - 2}
          fontSize={9}
          fontFamily="ui-monospace, monospace"
          fill="#4a5161"
        >
          t-{samples.length}s
        </text>
      </svg>
    </div>
  );
}

function SampleTable({
  samples,
  metric,
}: {
  samples: StatSample[];
  metric: StatKind;
}) {
  const recent = samples.slice(-8).reverse();
  return (
    <div className="rounded hairline bg-ink-950 overflow-hidden">
      <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-2 px-2 py-1 hairline-b bg-ink-900/60 font-mono text-[9px] uppercase tracking-widest2 text-fog-600">
        <span>t</span>
        <span>{metric}</span>
        <span>tok</span>
        <span>$</span>
      </div>
      <div className="max-h-[88px] overflow-y-auto">
        {recent.map((s) => (
          <div
            key={s.t}
            className="grid grid-cols-[auto_1fr_auto_auto] gap-x-2 px-2 py-0.5 font-mono text-[10px] text-fog-300 tabular-nums hover:bg-ink-800/60"
          >
            <span className="text-fog-600">{s.t}s</span>
            <span style={{ color: metricHex(metric) }}>
              {formatValue(metricValue(s, metric), metric)}
            </span>
            <span className="text-fog-500">{compact(s.tokens)}</span>
            <span className="text-fog-500">${s.cost.toFixed(3)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function metricValue(s: StatSample, m: StatKind): number {
  if (m === 'tokens') return s.tokens;
  if (m === 'cost') return s.cost;
  if (m === 'duration') return s.duration;
  return statusScore(s.status);
}

function formatValue(v: number, m: StatKind): string {
  if (m === 'cost') return `$${v.toFixed(3)}`;
  if (m === 'duration') return `${v.toFixed(1)}s`;
  if (m === 'status') return statusLabel(v);
  return compact(v);
}

function metricHex(m: StatKind): string {
  if (m === 'cost') return '#fbbf24';
  if (m === 'tokens') return '#5eead4';
  if (m === 'duration') return '#c084fc';
  return '#ff7a3d';
}

function statusScore(s: StatSample['status']): number {
  if (s === 'queued') return 0;
  if (s === 'running') return 1;
  if (s === 'complete') return 2;
  return -1;
}
function statusLabel(v: number): string {
  if (v < 0) return 'error';
  if (v === 0) return 'queued';
  if (v === 1) return 'running';
  return 'complete';
}
function statusColor(s: StatSample['status']): string {
  if (s === 'complete') return 'text-mint';
  if (s === 'error') return 'text-rust';
  if (s === 'running') return 'text-molten';
  return 'text-fog-500';
}
function statusDot(s: StatSample['status']): string {
  if (s === 'complete') return 'bg-mint';
  if (s === 'error') return 'bg-rust';
  if (s === 'running') return 'bg-molten';
  return 'bg-fog-700';
}

function buildHistory(seed: Seed): StatSample[] {
  const dur = seed.duration ?? 2.5;
  const out: StatSample[] = [];
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    const f = i / (steps - 1);
    out.push({
      t: -(steps - 1 - i),
      tokens: Math.round(seed.tokens * Math.min(1, f + jitter(0.05))),
      cost: +(seed.cost * Math.min(1, f + jitter(0.03))).toFixed(4),
      duration: +(dur * f).toFixed(2),
      status: f < 1 ? 'running' : seed.status ?? 'complete',
    });
  }
  return out;
}

function evolve(last: StatSample, seed: Seed): StatSample {
  const nextT = last.t + 1;
  const growing = last.status === 'running';
  const tokens = growing
    ? last.tokens + Math.max(2, Math.round(seed.tokens * 0.04 + jitter(2)))
    : last.tokens;
  const cost = growing
    ? +(last.cost + seed.cost * 0.04 + jitter(0.0005)).toFixed(4)
    : last.cost;
  const duration = +(last.duration + 0.5 + jitter(0.05)).toFixed(2);
  return {
    t: nextT,
    tokens,
    cost,
    duration,
    status: last.status,
  };
}

function jitter(scale: number): number {
  return (Math.random() - 0.5) * 2 * scale;
}
