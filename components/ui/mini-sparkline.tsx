'use client';

// MiniSparkline — tiny inline SVG sparkline for roster throughput.
// 12px tall, auto-width. Renders a smooth path from numeric samples
// with a filled area underneath. Zero samples or all-zero → dim line.

import clsx from 'clsx';

interface Props {
  samples: number[];
  width?: number;
  height?: number;
  accent?: string;
}

export function MiniSparkline({
  samples,
  width = 48,
  height = 12,
  accent = 'text-molten',
}: Props) {
  if (samples.length === 0) return null;

  const max = Math.max(1, ...samples);
  const pad = 1;
  const innerH = height - pad * 2;

  const step = width / Math.max(1, samples.length - 1);
  const points: string[] = [];
  for (let i = 0; i < samples.length; i++) {
    const x = samples.length === 1 ? width / 2 : i * step;
    const y = pad + innerH - (samples[i] / max) * innerH;
    points.push(`${x},${y}`);
  }

  if (points.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={clsx(accent, 'opacity-60')}
      >
        <circle cx={width / 2} cy={height / 2} r={1.5} fill="currentColor" />
      </svg>
    );
  }

  const linePath = `M${points.join(' L')}`;
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
    >
      <path d={areaPath} className={clsx(accent, 'opacity-10')} fill="currentColor" />
      <path d={linePath} className={clsx(accent, 'opacity-50')} fill="none" stroke="currentColor" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}