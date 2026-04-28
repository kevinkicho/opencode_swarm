// Run-health + budget chips rendered inside SwarmTopbar's nav.
//
// BudgetChip — one-line popover-tooltip for an in-run resource cap
// (cost or wallclock). Bar tone shifts mint → amber → rust as cap
// nears 60% / 80%.
//
// RetryAfterChip — live countdown for zen-rate-limit stops; ticks
// once per second and self-terminates when the window elapses.
//
// RunHealthChip — F8 aggregate severity (POSTMORTEMS/2026-04-24).
// Walks the ticker's stopReason, retry-exhausted board items, and
// silent-session ages to compute a single ok/warn/error indicator.
//
// Lifted from swarm-topbar/chips.tsx 2026-04-28.

import clsx from 'clsx';
import { useEffect, useState } from 'react';
import type { TickerState } from '@/lib/blackboard/live';
import type { BoardItem } from '@/lib/blackboard/types';
import { Tooltip } from '../ui/tooltip';
import { Popover } from '../ui/popover';

export function BudgetChip({
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

// Live countdown chip for zen-rate-limit stops. The opencode API's 429
// carried a retry-after header which the liveness watchdog parsed and
// stashed as `retryAfterEndsAtMs` on the ticker snapshot. This chip
// re-renders once per second so the user sees a visible "retry 3h 47m"
// countdown instead of a static frozen-looking chip. Self-terminates
// (renders nothing) once the window elapses.
export function RetryAfterChip({ endsAtMs }: { endsAtMs: number }) {
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
export function RunHealthChip({
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
                ? 'orchestrator hit the re-plan cap — human intervention needed'
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
