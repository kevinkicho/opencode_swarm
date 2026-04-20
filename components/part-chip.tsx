'use client';

import clsx from 'clsx';
import type { PartType, ToolName } from '@/lib/swarm-types';
import { partMeta, partHex, toolMeta, hueClass } from '@/lib/part-taxonomy';
import { Tooltip } from './ui/tooltip';

export function PartChip({
  part,
  size = 'sm',
}: {
  part: PartType;
  size?: 'xs' | 'sm';
}) {
  const m = partMeta[part];
  const hue = hueClass[m.hue];
  return (
    <Tooltip
      side="top"
      content={
        <div className="space-y-0.5">
          <div className="font-mono text-[11px] text-fog-200">{m.label}</div>
          <div className="font-mono text-[10.5px] text-fog-600">{m.blurb}</div>
        </div>
      }
    >
      <span
        className={clsx(
          'inline-flex items-center gap-1 border rounded-[3px] font-mono uppercase tracking-wider cursor-default',
          size === 'xs' ? 'h-3.5 px-1 text-[9px]' : 'h-4 px-1.5 text-[9px]',
          hue.bg,
          hue.border,
          hue.text,
        )}
      >
        {m.label}
      </span>
    </Tooltip>
  );
}

export function ToolChip({
  tool,
  size = 'sm',
}: {
  tool: ToolName;
  size?: 'xs' | 'sm';
}) {
  const m = toolMeta[tool];
  return (
    <Tooltip
      side="top"
      content={
        <div className="space-y-0.5">
          <div className="font-mono text-[11px] text-fog-200">{m.label}</div>
          <div className="font-mono text-[10.5px] text-fog-600">{m.blurb}</div>
        </div>
      }
    >
      <span
        className={clsx(
          'inline-flex items-center gap-1 border rounded-[3px] font-mono uppercase tracking-wider cursor-default bg-ink-900/60',
          size === 'xs' ? 'h-3.5 px-1 text-[9px]' : 'h-4 px-1.5 text-[9px]',
        )}
        style={{ color: m.hex, borderColor: `${m.hex}55` }}
      >
        {m.label}
      </span>
    </Tooltip>
  );
}

export function ToolList({
  tools,
  size = 'sm',
}: {
  tools: ToolName[];
  size?: 'xs' | 'sm';
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tools.map((t) => (
        <ToolChip key={t} tool={t} size={size} />
      ))}
    </div>
  );
}

export { partHex };
