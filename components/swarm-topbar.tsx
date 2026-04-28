'use client';

// SwarmTopbar — top-level navigation bar with run anchor + control chips
// + provider mix + palette / settings / account buttons.
//
// Decomposed: RunAnchorChip moved to swarm-topbar/run-anchor-chip.tsx
// (its own file because the popover content alone is ~200 lines), and the
// status / control chips moved into a per-concern split 2026-04-28:
//   - abort-chips.tsx     AbortChip, HardStopChip, fmtAbsTs
//   - health-chips.tsx    BudgetChip, RetryAfterChip, RunHealthChip
// This file owns the layout shell + the directive-teaser popover.

import type { RunMeta, ProviderSummary } from '@/lib/swarm-types';
import type { SwarmRunMeta, SwarmRunStatus } from '@/lib/swarm-run-types';
import type { TickerState } from '@/lib/blackboard/live';
import type { BoardItem } from '@/lib/blackboard/types';
import { IconLogo, IconAgent, IconSettings } from './icons';
import { Tooltip } from './ui/tooltip';
import { Popover } from './ui/popover';
import { ProviderBadge } from './provider-badge';
import { useBackendStale } from '@/lib/opencode/live';
import { compact } from '@/lib/format';
import { AbortChip, HardStopChip } from './swarm-topbar/abort-chips';
import { BudgetChip, RetryAfterChip, RunHealthChip } from './swarm-topbar/health-chips';
import { RunAnchorChip } from './swarm-topbar/run-anchor-chip';

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
  boardItems,
  silentSessions,
}: {
  run: RunMeta;
  providers: ProviderSummary[];
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  liveSessionId: string | null;
  liveDirectory: string | null;
  // Board items for the active run, used by the run-health chip to
  // count retry-exhausted items (notes matching /^\[retry:\d+\]/).
  // Undefined when the run isn't using a board (council, debate-judge,
  // map-reduce, critic-loop without board phase) — chip falls back to
  // ticker-only health.
  boardItems?: BoardItem[] | null;
  // Sessions whose last user prompt has no following assistant message
  // and exceeds SILENT_SESSION_THRESHOLD_MS (90s, matching F1 watchdog
  // WARN). Empty when no sessions are silent. Run-health chip surfaces
  // each one as a warn-level reason so the user sees the silence
  // BEFORE F1 watchdog gives up at 240s. STATUS.md "Run-health
  // surfacing #4".
  silentSessions?: import('@/lib/silent-session').SilentSession[];
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
  // Live ticker snapshot for the currently-anchored run.
  // `state: 'none'` = no ticker exists (e.g. non-blackboard pattern,
  // or ticker never started).
  tickerState: TickerState;
}) {
  const budgetPct = Math.min(100, Math.round((run.totalCost / run.budgetCap) * 100));
  const totalAgents = providers.reduce((s, p) => s + p.agents, 0);
  // When the backend has been unreachable for > ~5 s, React's in-memory
  // snapshots (run status, agent animations) are showing
  // stale data with no way to refresh. Gray the affected chips so users
  // can tell at a glance what's still reliable vs what's a cached frame.
  const backendStale = useBackendStale();

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
        {/* Run identity + status is the nav anchor now. Sessions
            dropdown + duplicate runs dropdown were removed 2026-04-23 —
            the bottombar has the canonical runs picker, and users
            navigate by run, not by individual opencode session.
            2026-04-24: hard-cap title width to 240 px and route the
            full text through a click-to-pin Popover so a 200-char
            directive doesn't dominate the topbar. The
            `RunAnchorChip` to the right has the authoritative
            full-text view; this title is just an inline teaser. */}
        <Popover
          side="bottom"
          align="start"
          content={() => (
            <div className="w-[420px] px-3 py-2 space-y-1.5">
              <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
                run title / directive
              </div>
              <div className="text-[11.5px] text-fog-200 leading-snug whitespace-pre-wrap break-words">
                {run.title || '(no title)'}
              </div>
              <div className="hairline-t pt-1.5 font-mono text-[9.5px] text-fog-700">
                source set at run launch · click outside to close
              </div>
            </div>
          )}
        >
          <button
            type="button"
            className="font-mono text-[12.5px] text-fog-300 truncate max-w-[240px] cursor-pointer hover:text-fog-100 text-left"
            title="click for full directive"
          >
            {run.title}
          </button>
        </Popover>
        {swarmRunMeta && <RunAnchorChip meta={swarmRunMeta} status={swarmRunStatus} stale={backendStale} />}
        {/*
          Conditional chip set — gated on the authoritative live status
          from the runs-poll (`swarmRunStatus`), NOT the mock-shaped
          `run.status` which can disagree with reality on historic runs.
          2026-04-28 fix:
            - terminal (stale / error) → no health, no abort, no force
            - active (live / idle) → health + force-stop; abort when
              there's an in-flight assistant turn (live only)
            - unknown / null → only the health chip renders (it has its
              own ok/warn/error tone) so the user has SOME signal during
              backend-blip / first-load windows
        */}
        {swarmRunMeta && swarmRunStatus !== 'stale' && swarmRunStatus !== 'error' && (
          <RunHealthChip
            tickerState={tickerState}
            boardItems={boardItems ?? null}
            silentSessions={silentSessions ?? []}
            stale={backendStale}
          />
        )}
        {tickerState.state === 'stopped' &&
          tickerState.stopReason === 'zen-rate-limit' &&
          tickerState.retryAfterEndsAtMs && (
            <RetryAfterChip endsAtMs={tickerState.retryAfterEndsAtMs} />
          )}
        {liveSessionId && liveDirectory && swarmRunStatus === 'live' && (
          <AbortChip sessionId={liveSessionId} directory={liveDirectory} />
        )}
        {swarmRunMeta && (swarmRunStatus === 'live' || swarmRunStatus === 'idle') && (
          <HardStopChip swarmRunID={swarmRunMeta.swarmRunID} />
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

        <Tooltip
          content={
            <div className="space-y-0.5">
              <div className="font-mono text-[11px] text-fog-200">routing</div>
              <div className="font-mono text-[10.5px] text-fog-600">
                run dispatch — bounds + ceilings, not a theme toggle
              </div>
            </div>
          }
          side="bottom"
          align="end"
        >
          <button onClick={onOpenSettings} className="fluent-btn" aria-label="open routing settings">
            <IconSettings size={14} />
          </button>
        </Tooltip>
      </div>
    </header>
  );
}
