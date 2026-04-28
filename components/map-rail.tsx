'use client';

// Map rail — pattern-specific tab for `map-reduce`. Two stacked
// sections: MAP (per-session row showing scope + status + output) and
// REDUCE (single synthesize row when present). Phase-transition banner
// surfaces between them when MAP finishes and the synthesize item lands
// on the board.
//
// Data sources:
//   - slots (LiveSwarmSessionSlot[]) — per-session messages for output
//     length + per-session status
//   - live.items — the synthesize item (if any) for the REDUCE row
//   - sessionIDs — slot ordering / labels
// Scope-text comes from the first user message on each session — that's
// the kickoff prompt where buildScopedDirective stamped the per-session
// scope annotation. Cheap to extract.
//
// 2026-04-28 decomposition: pure derivation + types →
// map-rail/helpers.ts; MapRowEl + ReduceRowEl + tone palettes →
// map-rail/rows.tsx. Rail composition + phase-transition banner stay
// here.

import { useMemo, useRef } from 'react';

import type { LiveBoard } from '@/lib/blackboard/live';
import type { LiveSwarmSessionSlot } from '@/lib/opencode/live';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { ScrollToBottomButton } from './ui/scroll-to-bottom';
import {
  type MapRow,
  type ReduceRow,
  countFilesTouched,
  extractScope,
  sessionOutputLines,
  sessionStatus,
  sessionTokens,
} from './map-rail/helpers';
import { MapRowEl, ReduceRowEl } from './map-rail/rows';

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
// auto-stick puts the user on the active phase.
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
