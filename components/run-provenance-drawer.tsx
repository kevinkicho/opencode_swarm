'use client';

// Run-level event provenance drawer.
//
// This is the first consumer of useSwarmRunEvents — it exists to prove L0
// events.ndjson is actually readable and useful. The single-session pipeline
// (useLiveSession + toMessages) can't show this view because it's scoped to
// one sessionID and reads from /session/{id}/message, not from the run's
// tagged event stream.
//
// Information architecture:
//   - Header chip states the replay/live phase and a running count
//   - Newest-first log of every tagged event (replay rows dimmed)
//   - Each row: ts, sessionID tail, type (colour-coded), one-line preview
//
// What this deliberately is NOT: a timeline replacement. The main timeline
// still reads from useLiveSession (single-session, narrative view). This
// drawer is the raw server-receive log, useful for debugging and for future
// cross-session views when pattern != 'none'.

import clsx from 'clsx';
import { useMemo } from 'react';
import { Drawer } from './ui/drawer';
import { useSwarmRunEvents, type SwarmRunPhase } from '@/lib/opencode/live';
import type { SwarmRunEvent } from '@/lib/swarm-run-types';

export function RunProvenanceDrawer({
  swarmRunID,
  open,
  onClose,
}: {
  swarmRunID: string | null;
  open: boolean;
  onClose: () => void;
}) {
  // Only subscribe while the drawer is open — EventSource lifetime follows
  // the drawer so a closed drawer doesn't hold a socket open.
  const activeID = open ? swarmRunID : null;
  const { events, phase, replayCount, error } = useSwarmRunEvents(activeID);

  const liveCount = Math.max(0, events.length - replayCount);

  // Newest-first. Copy into a new array because events is immutable state.
  const ordered = useMemo(() => [...events].reverse(), [events]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      eyebrow="run provenance"
      title={swarmRunID ?? undefined}
      width={460}
    >
      <div className="flex flex-col min-h-0 h-full">
        <div className="px-4 py-2.5 hairline-b flex items-center gap-3 bg-ink-900/40">
          <PhaseChip phase={phase} />
          <CountPill label="replay" value={replayCount} />
          <CountPill label="live" value={liveCount} />
          {error && (
            <span
              className="ml-auto font-mono text-[10px] text-rust truncate max-w-[180px]"
              title={error}
            >
              {error}
            </span>
          )}
        </div>

        {ordered.length === 0 ? (
          <EmptyState phase={phase} />
        ) : (
          <ul className="divide-y divide-ink-800/60">
            {ordered.map((ev, i) => (
              <EventRow key={`${ev.ts}-${i}`} ev={ev} />
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  );
}

function PhaseChip({ phase }: { phase: SwarmRunPhase }) {
  const { label, dot } = phaseVisual[phase];
  return (
    <span className="inline-flex items-center gap-1.5 h-5 px-1.5 rounded hairline bg-ink-900">
      <span className={clsx('w-1 h-1 rounded-full', dot)} />
      <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-300">
        {label}
      </span>
    </span>
  );
}

const phaseVisual: Record<SwarmRunPhase, { label: string; dot: string }> = {
  idle: { label: 'idle', dot: 'bg-fog-700' },
  attached: { label: 'attached', dot: 'bg-fog-500 animate-pulse' },
  replaying: { label: 'replaying', dot: 'bg-amber animate-pulse' },
  live: { label: 'live', dot: 'bg-mint' },
  error: { label: 'error', dot: 'bg-rust' },
};

function CountPill({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-baseline gap-1 font-mono">
      <span className="text-[9.5px] uppercase tracking-widest2 text-fog-600">
        {label}
      </span>
      <span className="text-[11px] tabular-nums text-fog-200">{value}</span>
    </span>
  );
}

function EventRow({ ev }: { ev: SwarmRunEvent & { replay?: boolean } }) {
  const { bucket, colorCls } = classifyType(ev.type);
  return (
    <li
      className={clsx(
        'px-4 h-6 flex items-center gap-3 hover:bg-ink-800/40 transition',
        ev.replay && 'opacity-60'
      )}
    >
      <span className="font-mono text-[10px] tabular-nums text-fog-700 w-[66px] shrink-0">
        {fmtTs(ev.ts)}
      </span>
      <span
        className="font-mono text-[10px] tabular-nums text-fog-500 w-[48px] shrink-0 truncate"
        title={ev.sessionID}
      >
        {tailID(ev.sessionID)}
      </span>
      <span
        className={clsx(
          'font-mono text-[10.5px] w-[160px] shrink-0 truncate',
          colorCls
        )}
        title={ev.type}
      >
        {ev.type}
      </span>
      <span
        className="font-mono text-[10px] text-fog-500 truncate flex-1 min-w-0"
        title={previewOf(ev.properties)}
      >
        {previewOf(ev.properties)}
      </span>
      {ev.replay && (
        <span className="font-mono text-[8.5px] uppercase tracking-widest2 text-fog-700 shrink-0">
          replay
        </span>
      )}
      <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 w-10 shrink-0 text-right">
        {bucket}
      </span>
    </li>
  );
}

function EmptyState({ phase }: { phase: SwarmRunPhase }) {
  const msg =
    phase === 'idle'
      ? 'drawer closed'
      : phase === 'error'
        ? 'stream errored before any events arrived'
        : 'no events on the wire yet';
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="font-mono text-[11px] text-fog-700">{msg}</div>
    </div>
  );
}

function fmtTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function tailID(id: string): string {
  // Session IDs are usually "ses_<time>_<rand>" in opencode. Show the last
  // 6 chars to keep rows narrow but still disambiguable in a multi-session
  // run. Full id is available via the cell title attribute.
  const last = id.slice(-6);
  return last;
}

function classifyType(type: string): { bucket: string; colorCls: string } {
  if (type.startsWith('message.')) return { bucket: 'msg', colorCls: 'text-fog-200' };
  if (type.startsWith('tool.')) return { bucket: 'tool', colorCls: 'text-amber/90' };
  if (type.startsWith('permission.')) return { bucket: 'perm', colorCls: 'text-molten' };
  if (type.startsWith('session.')) return { bucket: 'ses', colorCls: 'text-mint' };
  if (type.startsWith('swarm.')) return { bucket: 'swarm', colorCls: 'text-iris' };
  if (type.includes('error')) return { bucket: 'err', colorCls: 'text-rust' };
  return { bucket: '—', colorCls: 'text-fog-400' };
}

function previewOf(properties: unknown): string {
  if (!properties || typeof properties !== 'object') return '';
  try {
    // Keep the preview to the top-level keys; full JSON on hover via title.
    // This keeps each row scannable without turning it into a dump.
    const keys = Object.keys(properties as Record<string, unknown>);
    if (keys.length === 0) return '{}';
    const first = JSON.stringify(properties).slice(0, 240);
    return first;
  } catch {
    return '';
  }
}
