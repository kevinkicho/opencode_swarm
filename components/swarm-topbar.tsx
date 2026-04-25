'use client';

import clsx from 'clsx';
import { useEffect, useState } from 'react';
import type { RunMeta, ProviderSummary } from '@/lib/swarm-types';
import type { SwarmRunMeta, SwarmRunStatus } from '@/lib/swarm-run-types';
import type { TickerState } from '@/lib/blackboard/live';
import type { BoardItem } from '@/lib/blackboard/types';
import { IconLogo, IconAgent, IconSettings } from './icons';
import { Tooltip } from './ui/tooltip';
import { Popover } from './ui/popover';
import { patternMeta, patternAccentText } from '@/lib/swarm-patterns';
import { ProviderBadge } from './provider-badge';
import { STATUS_VISUAL } from './swarm-runs-picker';
import { abortSessionBrowser, useBackendStale } from '@/lib/opencode/live';
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
  // When the backend has been unreachable for > ~5 s, React's in-memory
  // snapshots (run status, tier chip, agent animations) are showing
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
        {swarmRunMeta && (
          <RunHealthChip
            tickerState={tickerState}
            boardItems={boardItems ?? null}
            silentSessions={silentSessions ?? []}
            stale={backendStale}
          />
        )}
        {tier && <TierChip tier={tier.currentTier} maxTier={tier.maxTier} exhausted={tier.tierExhausted} stale={backendStale} />}
        {tier &&
          tickerState.state === 'stopped' &&
          tickerState.stopReason === 'zen-rate-limit' &&
          tickerState.retryAfterEndsAtMs && (
            <RetryAfterChip endsAtMs={tickerState.retryAfterEndsAtMs} />
          )}
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
  stale = false,
}: {
  meta: SwarmRunMeta;
  status: SwarmRunStatus | null;
  // When true, the backend has been unreachable long enough that any
  // status we show is a React cache from before the disconnect. We
  // don't blank it (history is still useful) but we fade it so the
  // user can tell at a glance "this is yesterday's news."
  stale?: boolean;
}) {
  const directive = meta.directive?.trim() ?? '';
  const costCap = meta.bounds?.costCap;
  const minutesCap = meta.bounds?.minutesCap;
  const hasBounds = costCap != null || minutesCap != null;
  const visual = status ? STATUS_VISUAL[status] : null;
  // Directive moved to the popover only (2026-04-24); collapsed-chip
  // teaser was deemed redundant with the run-title text directly to
  // the chip's left. The full directive renders inside the popover
  // body below.

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
      <button
        className={clsx(
          'fluent-btn gap-1.5 shrink-0 transition-opacity',
          stale && 'opacity-50 grayscale',
        )}
        title={
          stale
            ? 'backend unreachable — status shown is pre-disconnect cache'
            : `${visual?.label ?? 'unknown'} · click for run details`
        }
      >
        {/* Run-anchor chip is now status-only (2026-04-24): dot +
            status label (live / stale / error / done / queued / etc.).
            The directive teaser was demoted to the click-pin Popover —
            it's the authoritative surface for full directive text +
            pattern + caps + run-id. The chip's job is just "is this
            run still going?" at a glance. */}
        <span
          className={clsx(
            'w-1.5 h-1.5 rounded-full shrink-0',
            visual && !stale ? visual.dot : 'bg-fog-700',
          )}
          aria-label={visual ? `status: ${visual.label}` : 'status: unknown'}
        />
        <span
          className={clsx(
            'font-mono text-micro uppercase tracking-widest2 shrink-0',
            visual?.tone ?? 'text-fog-500',
          )}
        >
          {visual?.label ?? 'unknown'}
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
  stale = false,
}: {
  tier: number;
  maxTier: number;
  exhausted: boolean;
  stale?: boolean;
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
      <div
        className={clsx(
          'flex items-center gap-1 h-6 px-1.5 rounded hairline cursor-help transition-opacity',
          stale && 'opacity-50 grayscale',
        )}
      >
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

// Live countdown chip for zen-rate-limit stops. The opencode API's 429
// carried a retry-after header which the liveness watchdog parsed and
// stashed as `retryAfterEndsAtMs` on the ticker snapshot. This chip
// re-renders once per second so the user sees a visible "retry 3h 47m"
// countdown instead of a static frozen-looking chip. Self-terminates
// (renders nothing) once the window elapses.
function RetryAfterChip({ endsAtMs }: { endsAtMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  const remainingMs = endsAtMs - now;
  if (remainingMs <= 0) return null;
  const totalSec = Math.ceil(remainingMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const label =
    h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  return (
    <Tooltip
      side="bottom"
      content={`zen-rate-limit — opencode's 429 said to retry after this window. Run resumes automatically on next tick once the window clears.`}
    >
      <div className="flex items-center gap-1 h-6 px-1.5 rounded hairline cursor-help">
        <span className="font-mono text-[10px] uppercase tracking-widest2 text-rust">
          retry
        </span>
        <span className="font-mono text-[10.5px] tabular-nums text-rust/90">
          {label}
        </span>
      </div>
    </Tooltip>
  );
}

// Run-health aggregator chip — POSTMORTEMS/2026-04-24 F8. One-glance
// signal: "is this run currently in trouble?" Green dot = no issues
// detected. Amber dot = retry-exhausted items present. Red dot =
// ticker stopped on a non-idle reason (frozen / rate-limit / silent /
// provider-unavailable). Click to expand and see the breakdown.
//
// What we DON'T track here that the F8 spec mentions:
//   - "sessions silent > 60s" — needs new server signal aggregating
//     watchdog state across sessions; deferred. The F1 watchdog
//     already logs WARN/ERROR per-session, so the dev console
//     surfaces this today.
//   - "last opencode error" — F2 tails opencode's log into stdout,
//     but we don't currently lift those errors back into the UI.
//     Deferred to a follow-up that captures + buffers errors
//     server-side and exposes them via a /run/health endpoint.
function RunHealthChip({
  tickerState,
  boardItems,
  silentSessions,
  stale = false,
}: {
  tickerState: TickerState;
  boardItems: BoardItem[] | null;
  silentSessions: import('@/lib/silent-session').SilentSession[];
  stale?: boolean;
}) {
  // Severity ladder. Highest applies.
  //   ok      — no signals
  //   warn    — retry-exhausted items, or ticker stopped due to
  //             auto-idle (the soft / acceptable stop)
  //   error   — ticker stopped due to a hard failure
  type Severity = 'ok' | 'warn' | 'error';

  // Retry-exhausted detection: items whose `note` matches
  // /^\[retry:\d+\]/ AND status is 'stale' or 'blocked'. The N=2 cap
  // is enforced by retryOrStale; we don't need to filter by N value.
  const retryExhausted = (boardItems ?? []).filter(
    (it) =>
      typeof it.note === 'string' &&
      /^\[retry:\d+\]/.test(it.note) &&
      (it.status === 'stale' || it.status === 'blocked'),
  );

  const tickerStopReason =
    tickerState.state === 'stopped' ? tickerState.stopReason : undefined;

  let severity: Severity = 'ok';
  const reasons: Array<{ label: string; detail: string; severity: Severity }> = [];

  if (tickerState.state === 'stopped') {
    if (tickerStopReason === 'auto-idle') {
      reasons.push({
        label: 'idle stop',
        detail: 'ticker auto-stopped — board drained',
        severity: 'warn',
      });
      if (severity === 'ok') severity = 'warn';
    } else if (tickerStopReason) {
      reasons.push({
        label: tickerStopReason,
        detail:
          tickerStopReason === 'opencode-frozen'
            ? 'opencode stopped responding to ticker probes'
            : tickerStopReason === 'zen-rate-limit'
              ? 'opencode-zen returned 429 — backoff in effect'
              : tickerStopReason === 'replan-loop-exhausted'
                ? 'orchestrator hit the re-plan cap — human intervention needed (PATTERN_DESIGN/orchestrator-worker.md I1)'
                : `ticker stopped on ${tickerStopReason}`,
        severity: 'error',
      });
      severity = 'error';
    }
  }
  if (retryExhausted.length > 0) {
    reasons.push({
      label: `${retryExhausted.length} retry-exhausted`,
      detail: `${retryExhausted.length} board item${retryExhausted.length === 1 ? '' : 's'} marked stale after ≥2 worker failures — investigation needed`,
      severity: 'warn',
    });
    if (severity === 'ok') severity = 'warn';
  }
  if (silentSessions.length > 0) {
    // STATUS.md run-health #4 — surface "silent since dispatch" before
    // F1 watchdog aborts at 240s. Use the maximum age across silent
    // sessions for the label so the most-concerning one drives the
    // signal. Per-session breakdown lives in the tooltip.
    const maxSilentMs = Math.max(...silentSessions.map((s) => s.silentMs));
    const maxSilentS = Math.round(maxSilentMs / 1000);
    reasons.push({
      label: `${silentSessions.length} silent ${maxSilentS}s+`,
      detail:
        `${silentSessions.length} session${silentSessions.length === 1 ? '' : 's'} have a user prompt with no assistant response yet ` +
        `(longest: ${maxSilentS}s). F1 watchdog aborts at 240s if no progress.`,
      severity: 'warn',
    });
    if (severity === 'ok') severity = 'warn';
  }

  const dotTone =
    severity === 'error' ? 'bg-rust' : severity === 'warn' ? 'bg-amber' : 'bg-mint';
  const labelTone =
    severity === 'error'
      ? 'text-rust'
      : severity === 'warn'
        ? 'text-amber'
        : 'text-mint';
  const headerLabel =
    severity === 'error' ? 'unhealthy' : severity === 'warn' ? 'attention' : 'healthy';

  const tooltipBody = (
    <div className="space-y-1.5 min-w-[240px]">
      <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
        run health · {headerLabel}
      </div>
      {reasons.length === 0 ? (
        <div className="font-mono text-[10.5px] text-fog-500">
          no issues detected — ticker active, no retry-exhausted items, no
          stop-reason flagged.
        </div>
      ) : (
        <ul className="list-none space-y-1">
          {reasons.map((r, i) => (
            <li key={i} className="flex items-start gap-1.5 font-mono text-[10.5px]">
              <span
                className={clsx(
                  'mt-0.5 w-1.5 h-1.5 rounded-full shrink-0',
                  r.severity === 'error'
                    ? 'bg-rust'
                    : r.severity === 'warn'
                      ? 'bg-amber'
                      : 'bg-mint',
                )}
              />
              <span>
                <span className="text-fog-200 uppercase tracking-widest2 text-[9.5px]">
                  {r.label}
                </span>
                <span className="block text-fog-500">{r.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="hairline-t pt-1 font-mono text-[9.5px] text-fog-700 normal-case">
        F8 health surface · POSTMORTEMS/2026-04-24
      </div>
    </div>
  );

  return (
    <Tooltip side="bottom" wide content={tooltipBody}>
      <div
        className={clsx(
          'flex items-center gap-1.5 h-6 px-1.5 rounded hairline cursor-help',
          stale && 'opacity-50',
        )}
      >
        <span
          className={clsx(
            'w-1.5 h-1.5 rounded-full',
            dotTone,
            severity === 'error' && 'animate-pulse',
          )}
        />
        <span
          className={clsx(
            'font-mono text-[10px] uppercase tracking-widest2',
            labelTone,
          )}
        >
          health
        </span>
      </div>
    </Tooltip>
  );
}
