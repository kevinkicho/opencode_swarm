'use client';

import clsx from 'clsx';
import type { RunMeta, ProviderSummary } from '@/lib/swarm-types';
import { IconLogo, IconAgent, IconSettings } from './icons';
import { Tooltip } from './ui/tooltip';
import { Popover } from './ui/popover';
import { StatsStream } from './ui/stats-stream';
import { ProviderBadge } from './provider-badge';
import { compact } from '@/lib/format';

export function SwarmTopbar({
  run,
  providers,
  onOpenPalette,
  onOpenSettings,
}: {
  run: RunMeta;
  providers: ProviderSummary[];
  onOpenPalette: () => void;
  onOpenSettings: () => void;
}) {
  const budgetPct = Math.min(100, Math.round((run.totalCost / run.budgetCap) * 100));
  const goTierPct = Math.min(100, Math.round((run.goTier.used / run.goTier.cap) * 100));
  const totalAgents = providers.reduce((s, p) => s + p.agents, 0);

  return (
    <header className="relative h-12 flex items-center hairline-b mica">
      <div className="flex items-center gap-2.5 pl-4 pr-4 h-full">
        <div className="relative w-5 h-5 grid place-items-center text-molten">
          <IconLogo size={18} />
          <span className="absolute -right-0.5 -top-0.5 w-1 h-1 rounded-full bg-molten shadow-glow-molten" />
        </div>
        <span className="font-display italic text-[16px] tracking-tight text-fog-100">
          opencode
        </span>
        <span className="font-mono text-micro uppercase tracking-widest2 text-molten/80">
          swarm
        </span>
      </div>

      <span className="w-px h-4 bg-ink-600" />

      <nav className="flex items-center gap-2 pl-4 text-[12.5px] min-w-0 flex-1">
        <span className="text-fog-200 truncate">{run.title}</span>
      </nav>

      <div className="flex items-center gap-1 pr-1 h-full">
        <BudgetChip
          label="$"
          used={run.totalCost}
          cap={run.budgetCap}
          pct={budgetPct}
          tooltipTitle="run budget"
          tooltipBody={[
            ['total spend', `$${run.totalCost.toFixed(2)}`],
            ['cap', `$${run.budgetCap.toFixed(2)}`],
            ['remaining', `$${(run.budgetCap - run.totalCost).toFixed(2)}`],
            ['tokens', compact(run.totalTokens)],
          ]}
        />

        <BudgetChip
          label={run.goTier.window}
          used={run.goTier.used}
          cap={run.goTier.cap}
          pct={goTierPct}
          accent="mint"
          tooltipTitle="go 5h rolling limit"
          tooltipBody={[
            ['used', `$${run.goTier.used.toFixed(2)}`],
            ['cap', `$${run.goTier.cap.toFixed(2)}`],
            ['resets', 'in 3h 12m'],
            ['weekly', '$2.41 / $30'],
          ]}
        />

        <Tooltip
          side="bottom"
          align="end"
          wide
          content={
            <div className="space-y-2 min-w-[240px]">
              <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
                provider mix
              </div>
              {providers.map((p) => (
                <div key={p.provider} className="flex items-center gap-2">
                  <ProviderBadge provider={p.provider} size="sm" />
                  <span className="font-mono text-[11px] text-fog-200 tabular-nums ml-auto">
                    {p.agents} agent{p.agents === 1 ? '' : 's'}
                  </span>
                  <span className="font-mono text-[10.5px] text-fog-600 tabular-nums w-12 text-right">
                    ${p.cost.toFixed(2)}
                  </span>
                </div>
              ))}
              <div className="hairline-t pt-1.5 font-mono text-[10.5px] text-fog-600 opacity-20">
                click to open routing rules
              </div>
            </div>
          }
        >
          <button onClick={onOpenSettings} className="fluent-btn gap-1.5">
            <IconAgent size={12} className="text-fog-400" />
            <span className="font-mono text-2xs text-fog-200 tabular-nums">{totalAgents}</span>
          </button>
        </Tooltip>

        <Tooltip content="palette jump inject" side="bottom" align="end">
          <button onClick={onOpenPalette} className="fluent-btn">
            <span className="font-mono text-micro text-fog-400 uppercase tracking-wider">palette</span>
          </button>
        </Tooltip>

        <Tooltip content="settings" side="bottom" align="end">
          <button onClick={onOpenSettings} className="fluent-btn" aria-label="settings">
            <IconSettings size={14} />
          </button>
        </Tooltip>

        <Tooltip content="kevin team admin" side="bottom" align="end">
          <button className="fluent-btn font-mono text-2xs text-fog-300" aria-label="account">
            kk
          </button>
        </Tooltip>
      </div>
    </header>
  );
}

function BudgetChip({
  label,
  used,
  cap,
  pct,
  accent = 'molten',
  tooltipTitle,
  tooltipBody,
}: {
  label: string;
  used: number;
  cap: number;
  pct: number;
  accent?: 'molten' | 'mint';
  tooltipTitle: string;
  tooltipBody: [string, string][];
}) {
  const barColor = pct > 80 ? 'bg-rust' : pct > 60 ? 'bg-amber' : accent === 'mint' ? 'bg-mint' : 'bg-molten';
  const textColor = pct > 80 ? 'text-rust' : accent === 'mint' ? 'text-mint/90' : 'text-fog-100';

  return (
    <Popover
      side="bottom"
      align="end"
      content={() => (
        <div className="w-[320px]">
          <div className="px-2.5 py-1.5 hairline-b flex items-center gap-2">
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
              {tooltipTitle}
            </span>
            <span
              className={clsx(
                'ml-auto font-mono text-[10px] uppercase tracking-widest2',
                pct > 80 ? 'text-rust' : 'text-fog-500'
              )}
            >
              {pct}% of cap
            </span>
          </div>
          <div className="px-2.5 py-1.5 hairline-b space-y-1">
            {tooltipBody.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3">
                <span className="font-mono text-[10px] uppercase tracking-wider text-fog-600">
                  {k}
                </span>
                <span className="font-mono text-[11px] text-fog-100 tabular-nums">{v}</span>
              </div>
            ))}
          </div>
          <StatsStream
            live
            seed={{
              label: `${tooltipTitle} stream`,
              tokens: Math.round(used * 1200),
              cost: used,
              duration: 120,
              status: 'running',
            }}
          />
        </div>
      )}
    >
      <button className="fluent-btn gap-1.5">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          {label}
        </span>
        <span className={clsx('font-mono text-2xs tabular-nums', textColor)}>
          ${used.toFixed(2)}
        </span>
        <span className="relative w-6 h-[2px] rounded-full bg-ink-900 overflow-hidden">
          <span
            className={clsx('absolute inset-y-0 left-0 rounded-full', barColor)}
            style={{ width: `${pct}%` }}
          />
        </span>
      </button>
    </Popover>
  );
}
