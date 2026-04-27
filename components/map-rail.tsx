'use client';

// Map rail — pattern-specific tab for `map-reduce`. Two stacked
// sections: MAP (per-session row showing scope + status + output) and
// REDUCE (single synthesize row when present). Phase-transition banner
// surfaces between them when MAP finishes and the synthesize item lands
// on the board.
//
//
// Data sources:
//   - slots (LiveSwarmSessionSlot[]) — per-session messages for output
//     length + per-session status
//   - live.items — the synthesize item (if any) for the REDUCE row
//   - sessionIDs — slot ordering / labels
// Scope-text comes from the first user message on each session — that's
// the kickoff prompt where buildScopedDirective stamped the per-session
// scope annotation. Cheap to extract.

import clsx from 'clsx';
import { useMemo, useRef } from 'react';

import type { LiveBoard } from '@/lib/blackboard/live';
import type { LiveSwarmSessionSlot } from '@/lib/opencode/live';
import type { OpencodeMessage } from '@/lib/opencode/types';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { ScrollToBottomButton } from './ui/scroll-to-bottom';
import { compactNum, countLines, turnText } from './rails/_shared';

interface MapRow {
  slotIndex: number;
  sessionID: string;
  scope: string; // truncated; full in title
  scopeFull: string;
  status: 'pending' | 'working' | 'idle' | 'errored';
  outputLines: number;
  filesTouched: number;
  tokens: number;
}

interface ReduceRow {
  itemID: string;
  status: 'awaiting' | 'claimed' | 'running' | 'done' | 'stale';
  ownerSlot: number | null;
  elapsedMinutes: number | null;
  outputLines: number;
}

// components/rails/_shared.ts.

// Extract the scope annotation from the first user message. Convention
// from buildScopedDirective (lib/server/map-reduce.ts:98-114): the
// kickoff prompt mentions "your scope:" or similar followed by paths.
// Fall back to a generic "scope?" placeholder if we can't find it.
function extractScope(slot: LiveSwarmSessionSlot): string {
  const firstUser = slot.messages.find((m) => m.info.role === 'user');
  if (!firstUser) return '';
  const text = turnText(firstUser);
  // Look for "scope:" / "Your scope:" / "Slice:" prefixes (lenient).
  const m = /(?:scope|slice)\s*:?\s*([^.\n]+)/i.exec(text);
  if (m) return m[1].trim().slice(0, 80);
  return '';
}

// Count files touched in a session via patch parts. We skip the read-
// only file-watcher signal and only count parts whose type === 'patch'.
function countFilesTouched(slot: LiveSwarmSessionSlot): number {
  const seen = new Set<string>();
  for (const m of slot.messages) {
    for (const p of m.parts) {
      if (p.type === 'patch') {
        // patch parts have a `files` array (per opencode types).
        const files = (p as { files?: string[] }).files ?? [];
        for (const f of files) seen.add(f);
      }
    }
  }
  return seen.size;
}

function sessionTokens(slot: LiveSwarmSessionSlot): number {
  let n = 0;
  for (const m of slot.messages) {
    if (m.info.role !== 'assistant') continue;
    n += m.info.tokens?.total ?? 0;
  }
  return n;
}

function sessionStatus(slot: LiveSwarmSessionSlot): MapRow['status'] {
  if (slot.messages.length === 0) return 'pending';
  const lastAssist = [...slot.messages]
    .reverse()
    .find((m) => m.info.role === 'assistant');
  if (!lastAssist) return 'pending';
  if (lastAssist.info.error) return 'errored';
  if (lastAssist.info.time.completed) return 'idle';
  return 'working';
}

function sessionOutputLines(slot: LiveSwarmSessionSlot): number {
  // Sum text-part lines across all assistant messages — proxy for
  // "how much did this session generate" without holding the full text
  // in memory.
  let n = 0;
  for (const m of slot.messages) {
    if (m.info.role !== 'assistant') continue;
    n += countLines(turnText(m));
  }
  return n;
}

export function MapRail({
  slots,
  live,
  sessionIDs,
  embedded = false,
  onInspectSession,
}: {
  slots: LiveSwarmSessionSlot[];
  live: LiveBoard;
  sessionIDs: string[];
  embedded?: boolean;
  onInspectSession?: (sessionID: string) => void;
}) {
  const { mapRows, reduce, mapSummary, hasMapPhaseDone } = useMemo(() => {
    const mapRows: MapRow[] = slots.map((slot, idx) => {
      const scopeFull = extractScope(slot);
      return {
        slotIndex: idx,
        sessionID: slot.sessionID,
        scope: scopeFull,
        scopeFull,
        status: sessionStatus(slot),
        outputLines: sessionOutputLines(slot),
        filesTouched: countFilesTouched(slot),
        tokens: sessionTokens(slot),
      };
    });

    // Reduce row: find the synthesize-kind board item (deterministic id
    // from map-reduce kickoff is `synth_<swarmRunID>`).
    const items = live.items ?? [];
    const synth = items.find((i) => i.kind === 'synthesize');
    let reduce: ReduceRow | null = null;
    if (synth) {
      const ownerSlot =
        synth.ownerAgentId !== undefined
          ? sessionIDs.indexOf(synth.ownerAgentId)
          : -1;
      const elapsedMinutes =
        synth.completedAtMs && synth.createdAtMs
          ? (synth.completedAtMs - synth.createdAtMs) / 60_000
          : synth.status === 'in-progress' || synth.status === 'claimed'
            ? (Date.now() - synth.createdAtMs) / 60_000
            : null;
      let status: ReduceRow['status'];
      switch (synth.status) {
        case 'open':
          status = 'awaiting';
          break;
        case 'claimed':
          status = 'claimed';
          break;
        case 'in-progress':
          status = 'running';
          break;
        case 'done':
          status = 'done';
          break;
        case 'stale':
        case 'blocked':
          status = 'stale';
          break;
        default:
          status = 'awaiting';
      }
      reduce = {
        itemID: synth.id,
        status,
        ownerSlot: ownerSlot >= 0 ? ownerSlot : null,
        elapsedMinutes,
        // We don't have the synthesis output text in board-state alone;
        // it's in the claimant session's last assistant message. Use
        // 0 placeholder; future enhancement: cross-reference against
        // slots[ownerSlot]'s last assistant message.
        outputLines:
          ownerSlot >= 0 && slots[ownerSlot]
            ? sessionOutputLines(slots[ownerSlot])
            : 0,
      };
    }

    const idleCount = mapRows.filter((r) => r.status === 'idle').length;
    const workingCount = mapRows.filter((r) => r.status === 'working').length;
    const erroredCount = mapRows.filter((r) => r.status === 'errored').length;
    const mapSummary = `${idleCount}/${mapRows.length} idle${workingCount > 0 ? ` · ${workingCount} working` : ''}${erroredCount > 0 ? ` · ${erroredCount} errored` : ''}`;
    const hasMapPhaseDone = mapRows.length > 0 && idleCount === mapRows.length;
    return { mapRows, reduce, mapSummary, hasMapPhaseDone };
  }, [slots, live.items, sessionIDs]);

  if (mapRows.length === 0) {
    return wrap(
      embedded,
      'no scopes assigned yet',
      <div className="px-3 py-4 font-mono text-micro uppercase tracking-widest2 text-fog-700">
        no scopes assigned — kickoff hasn't dispatched per-session intros
      </div>,
    );
  }

  // Phase-transition banner shows when MAP is done AND reduce hasn't
  // completed — that's the "transitioning" window users want to see.
  const showBanner =
    hasMapPhaseDone && (!reduce || (reduce.status !== 'done' && reduce.status !== 'stale'));

  return wrap(
    embedded,
    `MAP: ${mapSummary}`,
    <MapScrollBody
      mapRows={mapRows}
      reduce={reduce}
      showBanner={showBanner}
      sessionIDs={sessionIDs}
      onInspectSession={onInspectSession}
    />,
  );
}

// Stick-to-bottom scrollable body for the MAP+REDUCE stack. Reduce
// row appends BELOW the map sessions when the synthesize item lands;
// auto-stick puts the user on the active phase. (
// 6.7+6.8.)
function MapScrollBody({
  mapRows,
  reduce,
  showBanner,
  sessionIDs,
  onInspectSession,
}: {
  mapRows: MapRow[];
  reduce: ReduceRow | null;
  showBanner: boolean;
  sessionIDs: string[];
  onInspectSession?: (sessionID: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sig = `${mapRows.length}:${reduce ? reduce.status : 'none'}`;
  useStickToBottom(scrollRef, sig);
  return (
    <>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 flex flex-col"
      >
        {showBanner && (
          <div className="hairline-b px-3 py-1 bg-iris/[0.08] font-mono text-micro uppercase tracking-widest2 text-iris">
            MAP complete · synthesizer dispatched
          </div>
        )}
        <ul className="list-none">
          {mapRows.map((r) => (
            <MapRowEl
              key={r.slotIndex}
              row={r}
              onInspectSession={onInspectSession}
            />
          ))}
        </ul>
        {reduce && (
          <>
            <div className="hairline-b hairline-t px-3 py-0.5 bg-ink-900/40 font-mono text-micro uppercase tracking-widest2 text-fog-600">
              reduce
            </div>
            <ul className="list-none">
              <ReduceRowEl
                row={reduce}
                ownerSessionID={
                  reduce.ownerSlot !== null
                    ? sessionIDs[reduce.ownerSlot] ?? null
                    : null
                }
                onInspectSession={onInspectSession}
              />
            </ul>
          </>
        )}
      </div>
      <ScrollToBottomButton scrollRef={scrollRef} />
    </>
  );
}

function wrap(
  embedded: boolean,
  headerStatus: string,
  body: React.ReactNode,
) {
  const header = (
    <div className="h-7 hairline-b px-3 flex items-center gap-2 bg-ink-850/80 backdrop-blur shrink-0">
      <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600 shrink-0">
        map
      </span>
      <span className="font-mono text-micro tabular-nums text-fog-700 truncate">
        {headerStatus}
      </span>
    </div>
  );
  if (embedded) return <>{header}{body}</>;
  return (
    <section className="relative flex flex-col min-w-0 shrink-0 overflow-hidden bg-ink-850 max-h-[420px]">
      {header}
      {body}
    </section>
  );
}

const MAP_STATUS_TONE: Record<MapRow['status'], string> = {
  pending: 'text-fog-700',
  working: 'text-molten animate-pulse',
  idle: 'text-mint',
  errored: 'text-rust',
};

const REDUCE_STATUS_TONE: Record<ReduceRow['status'], string> = {
  awaiting: 'text-fog-700',
  claimed: 'text-iris',
  running: 'text-molten animate-pulse',
  done: 'text-mint',
  stale: 'text-amber',
};

// shared version absorbs map-rail's strict-superset M branch).

function MapRowEl({
  row,
  onInspectSession,
}: {
  row: MapRow;
  onInspectSession?: (sessionID: string) => void;
}) {
  const clickable = !!(onInspectSession && row.sessionID);
  const onClick = clickable ? () => onInspectSession!(row.sessionID) : undefined;
  return (
    <li
      onClick={onClick}
      className={clsx(
        'h-5 px-3 grid items-center gap-1.5 text-[10.5px] font-mono transition',
        clickable
          ? 'cursor-pointer hover:bg-ink-800/60'
          : 'cursor-default hover:bg-ink-800/40',
      )}
      style={{
        // glyph 40 · scope flex · status 60 · output 48 · files 32 · tokens 48
        gridTemplateColumns: '40px minmax(0, 1fr) 60px 48px 32px 48px',
      }}
      title={
        (row.scopeFull || `slot s${row.slotIndex} · ${row.sessionID.slice(-8)}`) +
        (clickable ? ' · click to inspect session' : '')
      }
    >
      <span className="text-iris font-mono text-[10px] tabular-nums">
        s{row.slotIndex}
      </span>
      <span className="text-fog-300 truncate min-w-0">
        {row.scope || <span className="text-fog-700">no scope detected</span>}
      </span>
      <span
        className={clsx(
          'uppercase tracking-widest2 text-[9px] text-right',
          MAP_STATUS_TONE[row.status],
        )}
      >
        {row.status}
      </span>
      <span
        className={clsx(
          'tabular-nums text-right',
          row.outputLines > 0 ? 'text-fog-400' : 'text-fog-700',
        )}
      >
        {row.outputLines > 0 ? `${compactNum(row.outputLines)}L` : '—'}
      </span>
      <span
        className={clsx(
          'tabular-nums text-right',
          row.filesTouched > 0 ? 'text-fog-400' : 'text-fog-700',
        )}
      >
        {row.filesTouched > 0 ? row.filesTouched : '—'}
      </span>
      <span
        className={clsx(
          'tabular-nums text-right',
          row.tokens > 0 ? 'text-fog-400' : 'text-fog-700',
        )}
      >
        {row.tokens > 0 ? compactNum(row.tokens) : '—'}
      </span>
    </li>
  );
}

function ReduceRowEl({
  row,
  ownerSessionID,
  onInspectSession,
}: {
  row: ReduceRow;
  ownerSessionID: string | null;
  onInspectSession?: (sessionID: string) => void;
}) {
  const idShort = row.itemID.length > 12 ? `${row.itemID.slice(0, 8)}…` : row.itemID;
  const clickable = !!(onInspectSession && ownerSessionID);
  const onClick = clickable
    ? () => onInspectSession!(ownerSessionID!)
    : undefined;
  return (
    <li
      onClick={onClick}
      className={clsx(
        'h-5 px-3 grid items-center gap-1.5 text-[10.5px] font-mono transition',
        clickable
          ? 'cursor-pointer hover:bg-ink-800/60'
          : 'cursor-default hover:bg-ink-800/40',
      )}
      style={{
        // glyph 16 · item 80 · status 80 · owner 32 · elapsed 48 · output 48
        gridTemplateColumns: '16px 80px 80px 32px 48px 48px',
      }}
      title={
        `synthesize ${row.itemID}` +
        (clickable ? ' · click to inspect synthesizer' : '')
      }
    >
      <span className="text-iris">⬢</span>
      <span className="font-mono text-[9px] text-fog-500 tabular-nums truncate">
        {idShort}
      </span>
      <span
        className={clsx(
          'uppercase tracking-widest2 text-[9px]',
          REDUCE_STATUS_TONE[row.status],
        )}
      >
        {row.status}
      </span>
      <span className="font-mono text-[10px] text-iris tabular-nums text-right">
        {row.ownerSlot !== null ? `s${row.ownerSlot}` : '—'}
      </span>
      <span
        className={clsx(
          'tabular-nums text-right',
          row.elapsedMinutes !== null ? 'text-fog-400' : 'text-fog-700',
        )}
      >
        {row.elapsedMinutes !== null
          ? row.elapsedMinutes < 10
            ? `${row.elapsedMinutes.toFixed(1)}m`
            : `${Math.round(row.elapsedMinutes)}m`
          : '—'}
      </span>
      <span
        className={clsx(
          'tabular-nums text-right',
          row.outputLines > 0 ? 'text-fog-400' : 'text-fog-700',
        )}
      >
        {row.outputLines > 0 ? `${compactNum(row.outputLines)}L` : '—'}
      </span>
    </li>
  );
}
