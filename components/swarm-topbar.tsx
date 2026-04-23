'use client';

import clsx from 'clsx';
import { useState } from 'react';
import type { RunMeta, ProviderSummary } from '@/lib/swarm-types';
import type { SwarmRunMeta, SwarmRunStatus } from '@/lib/swarm-run-types';
import type { TickerState } from '@/lib/blackboard/live';
import { IconLogo, IconAgent, IconSettings } from './icons';
import { Tooltip } from './ui/tooltip';
import { Popover } from './ui/popover';
import { SwarmRunsPicker } from './swarm-runs-picker';
import { patternMeta, patternAccentText } from '@/lib/swarm-patterns';
import { ProviderBadge } from './provider-badge';
import { LiveSessionPicker } from './live-session-picker';
import { STATUS_VISUAL } from './swarm-runs-picker';
import { abortSessionBrowser } from '@/lib/opencode/live';
import { compact } from '@/lib/format';

const TIER_LABELS: Record<number, string> = {
  1: 'polish',
  2: 'structural',
  3: 'capabilities',
  4: 'research',
  5: 'vision',
};

export function SwarmTopbar({
  run,
  providers,
  onOpenPalette,
  onOpenSettings,
  liveSessionId,
  liveDirectory,
  swarmRunMeta,
  swarmRunStatus,
  tickerState,
}: {
  run: RunMeta;
  providers: ProviderSummary[];
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  liveSessionId: string | null;
  liveDirectory: string | null;
  // Present only on `?swarmRun=<id>`. Read-only snapshot of how the run was
  // launched — directive text + bounds at dispatch time. NOT the same as
  // `run.budgetCap` (which reflects the *current* routing cost cap). Keeping
  // them separate preserves the "what was agreed at launch" vs "what the
  // dispatcher is enforcing right now" distinction.
  swarmRunMeta: SwarmRunMeta | null;
  // Live-derived status from the runs poll. Null when we're not on a
  // swarmRun URL or when the poll hasn't resolved yet. Rendered as the
  // leading dot on the run-anchor chip so "is this run still going?" is
  // answerable in one glance without opening the picker.
  swarmRunStatus: SwarmRunStatus | null;
  // Live ticker snapshot for the currently-anchored run. Feeds the
  // ambition-ratchet tier chip. `state: 'none'` = no ticker exists (e.g.
  // non-blackboard pattern, or ticker never started). Chip renders only
  // when state is 'active' or 'stopped' so it's meaningful to display.
  tickerState: TickerState;
}) {
  const budgetPct = Math.min(100, Math.round((run.totalCost / run.budgetCap) * 100));
  const totalAgents = providers.reduce((s, p) => s + p.agents, 0);
  // Show the tier chip only when the ticker has actually booted (active
  // or stopped with known tier state). The 'none' arm lacks the tier
  // fields by design — drawing 0/? would be worse than absence.
  const tier = tickerState.state === 'none' ? null : tickerState;

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
        <LiveSessionPicker title={run.title} />
        {/* Runs-navigation dropdown. Mirrors the sessions dropdown on
            the left — users can now hop between runs without leaving
            the topbar. Same component the bottom-bar uses; the click
            opens its popover with every run's id/pattern/status. */}
        <SwarmRunsPicker currentSwarmRunID={swarmRunMeta?.swarmRunID ?? null}>
          <button
            type="button"
            className="flex items-center gap-1 h-6 px-1.5 rounded hover:bg-ink-800 transition text-fog-500 hover:text-fog-200"
            aria-label="browse swarm runs"
          >
            <span className="font-mono text-[10px] uppercase tracking-widest2">runs</span>
            <span className="font-mono text-[9px] text-fog-700">▾</span>
          </button>
        </SwarmRunsPicker>
        {swarmRunMeta && <RunAnchorChip meta={swarmRunMeta} status={swarmRunStatus} />}
        {tier && <TierChip tier={tier.currentTier} maxTier={tier.maxTier} exhausted={tier.tierExhausted} />}
        {liveSessionId && liveDirectory && run.status === 'active' && (
          <AbortChip sessionId={liveSessionId} directory={liveDirectory} />
        )}
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

// Compact chip surfacing the run-launch contract: directive text + bounds as
// they were recorded in meta.json. This is a *read-only* handle on the
// run's origin — mutating bounds mid-run happens via routing rules, not
// here. The chip sits next to the session picker so the directive is one
// glance away without having to open a drawer.
//
// Leading dot reflects live-derived status from the runs poll (live / idle
// / error / stale / unknown). When null, we render a neutral fog-700 dot —
// the chip is still useful as an anchor even before the first poll lands.
function RunAnchorChip({
  meta,
  status,
}: {
  meta: SwarmRunMeta;
  status: SwarmRunStatus | null;
}) {
  const directive = meta.directive?.trim() ?? '';
  const costCap = meta.bounds?.costCap;
  const minutesCap = meta.bounds?.minutesCap;
  const hasBounds = costCap != null || minutesCap != null;
  const visual = status ? STATUS_VISUAL[status] : null;

  // Truncate the directive in the collapsed state but keep the newline
  // structure readable in the popover. The popover is the authoritative
  // surface; the chip is just the teaser.
  const teaser = directive
    ? directive.length > 56
      ? directive.slice(0, 56).replace(/\s+$/, '') + '…'
      : directive
    : '(no directive)';

  return (
    <Popover
      side="bottom"
      align="start"
      content={() => (
        <div className="w-[420px]">
          <div className="px-3 h-7 hairline-b flex items-center gap-2">
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
              run anchor
            </span>
            {visual && (
              <span className="flex items-center gap-1 shrink-0">
                <span className={clsx('w-1.5 h-1.5 rounded-full', visual.dot)} />
                <span
                  className={clsx(
                    'font-mono text-[9.5px] uppercase tracking-widest2',
                    visual.tone
                  )}
                >
                  {visual.label}
                </span>
              </span>
            )}
            <span
              className="ml-auto font-mono text-[10px] text-fog-600 tabular-nums truncate max-w-[220px]"
              title={meta.swarmRunID}
            >
              {meta.swarmRunID}
            </span>
          </div>
          <div className="px-3 py-2 hairline-b grid grid-cols-[78px_1fr] gap-y-1.5 gap-x-3 items-baseline">
            <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
              pattern
            </span>
            {meta.pattern === 'blackboard' ? (
              <a
                href={`/board-preview?swarmRun=${meta.swarmRunID}`}
                className={clsx(
                  'font-mono text-[11px] hover:opacity-80 flex items-center gap-1 group w-fit',
                  patternAccentText[patternMeta[meta.pattern].accent],
                )}
                title="open board view"
              >
                {meta.pattern}
                <span className="text-fog-600 group-hover:text-fog-300 transition">→ board</span>
              </a>
            ) : (
              <span
                className={clsx(
                  'font-mono text-[11px]',
                  patternAccentText[patternMeta[meta.pattern].accent],
                )}
              >
                {meta.pattern}
              </span>
            )}
            <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
              sessions
            </span>
            {meta.sessionIDs.length > 1 ? (
              <span className="flex flex-wrap items-center gap-1">
                <span className="font-mono text-[11px] text-fog-300 tabular-nums mr-1">
                  {meta.sessionIDs.length}×
                </span>
                {meta.sessionIDs.map((sid) => (
                  <span
                    key={sid}
                    className="font-mono text-[10px] text-fog-400 tabular-nums px-1 h-4 flex items-center rounded bg-ink-800/60 hairline"
                    title={sid}
                  >
                    {sid.slice(-8)}
                  </span>
                ))}
              </span>
            ) : (
              <span className="font-mono text-[11px] text-fog-300 tabular-nums">
                {meta.sessionIDs.length}
              </span>
            )}
            <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
              created
            </span>
            <span className="font-mono text-[11px] text-fog-200 tabular-nums">
              {fmtAbsTs(meta.createdAt)}
            </span>
            {meta.source && (
              <>
                <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
                  source
                </span>
                <a
                  href={meta.source}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[11px] text-mint/90 hover:text-mint truncate"
                  title={meta.source}
                >
                  {meta.source}
                </a>
              </>
            )}
          </div>
          {directive && (
            <div className="px-3 py-2 hairline-b">
              <div className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600 mb-1">
                directive
              </div>
              <div className="font-mono text-[11px] text-fog-200 whitespace-pre-wrap leading-relaxed max-h-[168px] overflow-y-auto">
                {directive}
              </div>
            </div>
          )}
          <div className="px-3 py-2 grid grid-cols-[78px_1fr] gap-y-1.5 gap-x-3 items-baseline">
            <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
              cost cap
            </span>
            <span
              className={clsx(
                'font-mono text-[11px] tabular-nums',
                costCap != null ? 'text-molten' : 'text-fog-700'
              )}
            >
              {costCap != null ? `$${costCap.toFixed(2)}` : 'unbounded'}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
              time cap
            </span>
            <span
              className={clsx(
                'font-mono text-[11px] tabular-nums',
                minutesCap != null ? 'text-amber' : 'text-fog-700'
              )}
            >
              {minutesCap != null ? `${minutesCap}m` : 'unbounded'}
            </span>
          </div>
        </div>
      )}
    >
      <button className="fluent-btn gap-1.5 min-w-0 max-w-[320px]" title={directive || meta.swarmRunID}>
        <span
          className={clsx(
            'w-1.5 h-1.5 rounded-full shrink-0',
            visual ? visual.dot : 'bg-fog-700'
          )}
          aria-label={visual ? `status: ${visual.label}` : 'status: unknown'}
        />
        <span className="font-mono text-micro uppercase tracking-widest2 text-iris/80 shrink-0">
          run
        </span>
        <span className="font-mono text-[10.5px] text-fog-300 truncate min-w-0">
          {teaser}
        </span>
        {hasBounds && (
          <span className="flex items-center gap-1 shrink-0 pl-1 border-l border-ink-700">
            {costCap != null && (
              <span className="font-mono text-[9.5px] text-fog-500 tabular-nums">
                ${costCap.toFixed(costCap < 10 ? 2 : 0)}
              </span>
            )}
            {minutesCap != null && (
              <span className="font-mono text-[9.5px] text-fog-500 tabular-nums">
                {minutesCap}m
              </span>
            )}
          </span>
        )}
      </button>
    </Popover>
  );
}

function fmtAbsTs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function AbortChip({
  sessionId,
  directory,
}: {
  sessionId: string;
  directory: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doAbort = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await abortSessionBrowser(sessionId, directory);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Tooltip
      side="bottom"
      content={
        error ? (
          <span className="font-mono text-[10.5px] text-rust">{error}</span>
        ) : (
          <span className="font-mono text-[10.5px] text-fog-300">
            cancel this run — already-committed tool calls finish, no further reasoning
          </span>
        )
      }
    >
      <button
        onClick={doAbort}
        disabled={busy}
        className={clsx(
          'h-6 px-2 rounded hairline font-mono text-[10px] uppercase tracking-widest2 transition flex items-center gap-1.5 shrink-0',
          busy
            ? 'bg-ink-800 border-ink-700 text-fog-600 cursor-wait'
            : 'bg-ink-900 border-rust/30 text-rust hover:bg-rust/10 hover:border-rust/50',
        )}
      >
        <span className={clsx('w-1.5 h-1.5 rounded-full', busy ? 'bg-fog-700 animate-pulse' : 'bg-rust')} />
        {busy ? 'aborting' : 'abort'}
      </button>
    </Tooltip>
  );
}

function BudgetChip({
  label,
  used,
  pct,
  tooltipTitle,
  tooltipBody,
}: {
  label: string;
  used: number;
  cap: number;
  pct: number;
  tooltipTitle: string;
  tooltipBody: [string, string][];
}) {
  const barColor = pct > 80 ? 'bg-rust' : pct > 60 ? 'bg-amber' : 'bg-molten';
  const textColor = pct > 80 ? 'text-rust' : 'text-fog-100';

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
          <div className="px-2.5 py-1.5 space-y-1">
            {tooltipBody.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3">
                <span className="font-mono text-[10px] uppercase tracking-wider text-fog-600">
                  {k}
                </span>
                <span className="font-mono text-[11px] text-fog-100 tabular-nums">{v}</span>
              </div>
            ))}
          </div>
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

// Ambition-ratchet tier indicator. Renders as a compact chip next to the
// run-anchor chip. Reads currentTier / maxTier / tierExhausted off the
// ticker snapshot — see SWARM_PATTERNS.md "Tiered execution". The chip
// is decorative (no click handler); its job is "let the user see the
// ratchet climb in real time without opening the ticker debug endpoint."
function TierChip({
  tier,
  maxTier,
  exhausted,
}: {
  tier: number;
  maxTier: number;
  exhausted: boolean;
}) {
  const label = TIER_LABELS[tier] ?? `tier ${tier}`;
  // At max tier with `exhausted` set, the ratchet has declared "no more
  // ambitious work" — treat as a subtle done-state rather than active.
  // Otherwise iris for tier climbing (matches the pattern-accent palette),
  // slightly dimmed if the ticker is stopped but not yet exhausted.
  const tone = exhausted
    ? 'text-fog-500'
    : tier >= 4
      ? 'text-iris'
      : tier >= 2
        ? 'text-iris/80'
        : 'text-fog-400';
  return (
    <Tooltip
      side="bottom"
      content={
        exhausted
          ? `tier ${tier}/${maxTier} (${label}) — ratchet exhausted; run will stop on next cascade`
          : `tier ${tier}/${maxTier} (${label}) — ambition ratchet; escalates on board drain`
      }
    >
      <div className="flex items-center gap-1 h-6 px-1.5 rounded hairline cursor-help">
        <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
          tier
        </span>
        <span className={clsx('font-mono text-[10.5px] tabular-nums', tone)}>
          {tier}/{maxTier}
        </span>
        <span className="font-mono text-[10px] text-fog-600">·</span>
        <span className={clsx('font-mono text-[10px] lowercase', tone)}>
          {label}
        </span>
      </div>
    </Tooltip>
  );
}
