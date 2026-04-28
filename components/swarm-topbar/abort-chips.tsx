// Abort + hard-stop chips rendered inside SwarmTopbar's nav.
//
// AbortChip — soft cancel via opencode's session.abort. Applies only
// to the primary session; multi-session runs may keep peer sessions
// alive (#105 motivates HardStopChip below).
//
// HardStopChip — two-step confirm hard kill via /api/swarm/run/:id/stop.
// Tears down the orchestrator coroutine + every session at once.
//
// Lifted from swarm-topbar/chips.tsx 2026-04-28 along with the small
// fmtAbsTs helper (used by both chips' tooltips).

import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Tooltip } from '../ui/tooltip';
import { abortSessionBrowser } from '@/lib/opencode/live';

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
// keep N-1 sessions alive AND the orchestrator coroutine, which then
// waits forever for a session that's already idle. Hard-stop tears down
// the whole run via /api/swarm/run/:id/stop. See task #105.
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
