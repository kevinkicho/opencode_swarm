// Status / control chips rendered inside SwarmTopbar's nav.
//
// Extracted from swarm-topbar.tsx in #108. Each chip is independent
// (own state, own tooltip / popover) so the parent's body reads as a
// composition of these atoms rather than ~700 lines of inline JSX.

import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { TickerState } from '@/lib/blackboard/live';
import type { BoardItem } from '@/lib/blackboard/types';
import { Tooltip } from '../ui/tooltip';
import { Popover } from '../ui/popover';
import { abortSessionBrowser } from '@/lib/opencode/live';

const TIER_LABELS: Record<number, string> = {
  1: 'polish',
  2: 'structural',
  3: 'capabilities',
  4: 'research',
  5: 'vision',
};

export function fmtAbsTs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function AbortChip({
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

// Hard-stop chip (#105). Two-step confirm: first click arms (3s
// auto-disarm so an accidental press doesn't kill the run on the next
// click), second click executes. Distinct from AbortChip because the
// soft abort only targets the primary session — multi-session runs
// (council, debate-judge, role-differentiated, etc.) keep N-1 sessions
// alive AND the orchestrator coroutine, which then waits forever for a
// session that's already idle. Hard-stop tears down the whole run via
// /api/swarm/run/:id/stop. See task #105.
export function HardStopChip({ swarmRunID }: { swarmRunID: string }) {
  const [phase, setPhase] = useState<'idle' | 'armed' | 'busy' | 'done'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);

  // Auto-disarm after 3s so an accidental click on 'idle' doesn't
  // become a permanent landmine the next time the operator hovers
  // over the chip. Runs only when armed; cleared on phase change.
  useEffect(() => {
    if (phase !== 'armed') return;
    const t = setTimeout(() => setPhase('idle'), 3000);
    return () => clearTimeout(t);
  }, [phase]);

  // ('idle' | 'armed' | 'busy' | 'done') stays as useState because it's
  // a multi-step UI state machine that includes pre-fetch states the
  // mutation doesn't model directly. Mutation drives only busy/done/error.
  const stopMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      const res = await fetch(`/api/swarm/run/${swarmRunID}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        throw new Error(detail.error ?? detail.detail ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => setPhase('done'),
    onError: (err) => {
      setError((err as Error).message);
      setPhase('idle');
    },
  });

  const onClick = () => {
    if (phase === 'busy' || phase === 'done') return;
    if (phase === 'idle') {
      setPhase('armed');
      setError(null);
      return;
    }
    // armed → execute
    setPhase('busy');
    setError(null);
    stopMutation.mutate();
  };

  const label =
    phase === 'idle'
      ? 'force stop'
      : phase === 'armed'
        ? 'click again to confirm'
        : phase === 'busy'
          ? 'stopping…'
          : 'stopped';

  return (
    <Tooltip
      side="bottom"
      content={
        error ? (
          <span className="font-mono text-[10.5px] text-rust">{error}</span>
        ) : (
          <span className="font-mono text-[10.5px] text-fog-300">
            {phase === 'idle'
              ? 'tear down the whole run — aborts every session + auto-ticker. in-flight tool calls land as-is'
              : phase === 'armed'
                ? 'this will kill all sessions in this run · 3s to auto-disarm'
                : phase === 'busy'
                  ? 'aborting all sessions…'
                  : 'all sessions aborted; partial-outcome finding recorded'}
          </span>
        )
      }
    >
      <button
        onClick={onClick}
        disabled={phase === 'busy' || phase === 'done'}
        className={clsx(
          'h-6 px-2 rounded hairline font-mono text-[10px] uppercase tracking-widest2 transition flex items-center gap-1.5 shrink-0',
          phase === 'idle' &&
            'bg-ink-900 border-rust/40 text-rust/90 hover:bg-rust/10 hover:border-rust/60',
          phase === 'armed' &&
            'bg-rust/15 border-rust text-rust animate-pulse',
          phase === 'busy' && 'bg-ink-800 border-ink-700 text-fog-600 cursor-wait',
          phase === 'done' && 'bg-ink-900 border-fog-700 text-fog-600',
        )}
      >
        <span
          className={clsx(
            'w-1.5 h-1.5 rounded-full',
            phase === 'idle' && 'bg-rust',
            phase === 'armed' && 'bg-rust animate-pulse',
            phase === 'busy' && 'bg-fog-700 animate-pulse',
            phase === 'done' && 'bg-fog-600',
          )}
        />
        {label}
      </button>
    </Tooltip>
  );
}

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

// Ambition-ratchet tier indicator. Renders as a compact chip next to the
// run-anchor chip. Reads currentTier / maxTier / tierExhausted off the
// ticker snapshot — see "Tiered execution". The chip
// is decorative (no click handler); its job is "let the user see the
// ratchet climb in real time without opening the ticker debug endpoint."
export function TierChip({
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
