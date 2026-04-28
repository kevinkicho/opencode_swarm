// HeatRow + ViewToggleButton — flat-list view of file heat.
//
// Lifted from heat-rail/sub-components.tsx 2026-04-28 to keep the
// list view distinct from the tree view (the two render shapes are
// genuinely different and don't share row markup).

import clsx from 'clsx';
import type { FileHeat } from '@/lib/opencode/transform';
import type { Agent } from '@/lib/swarm-types';
import { Tooltip } from '../ui/tooltip';
import { accentBadge, fmtAgo, splitPath, stripWorkspace } from './utils';

export function ViewToggleButton({
  active,
  onClick,
  label,
  tooltip,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tooltip: string;
}) {
  const btn = (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'h-5 px-1.5 rounded font-mono text-micro uppercase tracking-widest2 transition cursor-pointer',
        active
          ? 'bg-ink-800 text-fog-100'
          : 'text-fog-600 hover:text-fog-200 hover:bg-ink-800/50',
      )}
    >
      {label}
    </button>
  );
  return (
    <Tooltip side="bottom" align="end" content={tooltip}>
      {btn}
    </Tooltip>
  );
}

export function HeatRow({
  heat,
  workspace,
  maxCount,
  agentBySession,
  diffStats,
  onSelect,
}: {
  heat: FileHeat;
  workspace: string;
  maxCount: number;
  agentBySession: Map<string, Agent>;
  diffStats?: { added: number; deleted: number };
  onSelect?: (heat: FileHeat) => void;
}) {
  const displayPath = stripWorkspace(heat.path, workspace);
  const { dir, base } = splitPath(displayPath);
  const intensity = heat.editCount / maxCount;
  const barTone =
    intensity >= 0.8
      ? 'bg-molten/60'
      : intensity >= 0.5
        ? 'bg-molten/35'
        : intensity >= 0.2
          ? 'bg-amber/30'
          : 'bg-fog-700';

  const touchers = heat.sessionIDs
    .map((sid) => agentBySession.get(sid))
    .filter((a): a is Agent => a !== undefined);

  return (
    <li className="relative min-w-0">
      <div
        role={onSelect ? 'button' : undefined}
        tabIndex={onSelect ? 0 : undefined}
        onClick={onSelect ? () => onSelect(heat) : undefined}
        onKeyDown={
          onSelect
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(heat);
                }
              }
            : undefined
        }
        className={clsx(
          'px-3 h-6 min-w-0 transition-colors',
          onSelect && 'cursor-pointer hover:bg-ink-800/50',
        )}
        style={{
          display: 'grid',
          gridTemplateColumns: '22px minmax(0, 1fr) 32px 32px',
          alignItems: 'center',
          columnGap: '8px',
        }}
      >
        <Tooltip
          content={`${heat.editCount} edit${heat.editCount === 1 ? '' : 's'}`}
          side="right"
        >
          <span
            className="relative h-2 w-full bg-ink-800 rounded-sm overflow-hidden cursor-default"
            aria-label={`intensity ${Math.round(intensity * 100)}%`}
          >
            <span
              className={clsx('absolute left-0 top-0 bottom-0', barTone)}
              style={{ width: `${Math.max(8, intensity * 100)}%` }}
            />
          </span>
        </Tooltip>
        <Tooltip
          content={
            <div className="space-y-1 max-w-[420px]">
              <div className="font-mono text-[10.5px] text-fog-200 break-all">
                {displayPath || heat.path}
              </div>
              <div className="font-mono text-[10.5px] text-fog-400 tabular-nums">
                {new Date(heat.lastTouchedMs).toLocaleString()}
              </div>
              <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 tabular-nums">
                {fmtAgo(heat.lastTouchedMs)} ago
              </div>
              {touchers.length > 0 && (
                <div className="flex items-center gap-1 pt-0.5 flex-wrap">
                  <span className="font-mono text-micro uppercase tracking-widest2 text-fog-700">
                    touched by
                  </span>
                  {touchers.map((a) => (
                    <span
                      key={a.id}
                      className={clsx(
                        'inline-flex items-center h-4 px-1 rounded-sm font-mono text-[9px] leading-none',
                        accentBadge[a.accent],
                      )}
                    >
                      {a.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          }
          side="right"
        >
          <span className="truncate-left font-mono text-[11.5px] cursor-default min-w-0 w-full">
            <bdi dir="ltr">
              {dir && <span className="text-fog-700">{dir}/</span>}
              <span className="text-fog-200">{base}</span>
            </bdi>
          </span>
        </Tooltip>
        <span
          className={clsx(
            'font-mono text-[10.5px] tabular-nums text-right',
            diffStats && diffStats.added > 0 ? 'text-mint' : 'text-fog-700',
          )}
        >
          {!diffStats ? '—' : diffStats.added > 0 ? `+${diffStats.added}` : ''}
        </span>
        <span
          className={clsx(
            'font-mono text-[10.5px] tabular-nums text-right',
            diffStats && diffStats.deleted > 0 ? 'text-rust' : 'text-fog-700',
          )}
        >
          {!diffStats ? '—' : diffStats.deleted > 0 ? `-${diffStats.deleted}` : ''}
        </span>
      </div>
    </li>
  );
}
