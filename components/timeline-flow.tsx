'use client';

// TimelineFlow — virtualized SVG + DOM render of message rows.
//
// Decomposed in #108: positioning math (constants + types) lives in
// timeline-flow/types.ts, the layout calculator in
// timeline-flow/build-row.ts, the visual subcomponents
// (ChipCard / DropMarker / EventCard) in timeline-flow/sub-components.tsx.
// This file owns the virtualizer wiring + the SVG container that holds
// all four layers (wires / drops / event cards / chips / time gutter).

import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { Agent, AgentMessage, TodoItem } from '@/lib/swarm-types';
import { Tooltip } from './ui/tooltip';
import { buildRow } from './timeline-flow/build-row';
import {
  CHIP_GAP,
  CHIP_HEIGHT,
  CHIP_TOP_PAD,
  LANE_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  ROW_HEIGHT,
  TIMELINE_GUTTER_WIDTH,
  TOP_PAD,
  fmtIso,
  fmtWallClock,
  type Row,
  type RowLayout,
} from './timeline-flow/types';
import {
  ChipCard,
  DropMarker,
  EventCard,
} from './timeline-flow/sub-components';

// Re-exported so swarm-timeline.tsx (the parent) can use the same gutter
// width when it draws lane headers + grid above this flow.
export { TIMELINE_GUTTER_WIDTH };

export function TimelineFlow({
  agents: _agents,
  agentOrder: _agentOrder,
  agentIndex,
  agentMap,
  rows,
  rowHeights,
  allMessages,
  focusedId,
  onFocus,
  onClearFocus,
  selectedAgentId,
  clockSec,
  totalWidth,
  totalHeight,
  scrollRef,
  scrollMargin,
  todoByTaskMessageId,
  onJumpToTodo,
}: {
  agents: Agent[];
  agentOrder: string[];
  agentIndex: Map<string, number>;
  agentMap: Map<string, Agent>;
  rows: Row[];
  rowHeights: number[];
  allMessages: AgentMessage[];
  focusedId: string | null;
  onFocus: (id: string) => void;
  onClearFocus: () => void;
  selectedAgentId: string | null;
  clockSec: number;
  totalWidth: number;
  totalHeight: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollMargin: number;
  todoByTaskMessageId: Map<string, TodoItem>;
  onJumpToTodo: (todoId: string) => void;
}) {
  const estimateSize = useCallback(
    (i: number) => rowHeights[i] ?? ROW_HEIGHT,
    [rowHeights],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: 8,
    scrollMargin,
  });

  const virtualItems = virtualizer.getVirtualItems();

  const layouts: RowLayout[] = useMemo(() => {
    return virtualItems.map((vi) =>
      buildRow(rows[vi.index], agentIndex, agentMap, clockSec, focusedId, selectedAgentId),
    );
  }, [virtualItems, rows, agentIndex, agentMap, clockSec, focusedId, selectedAgentId]);

  // Plan → timeline hop (DESIGN.md §8.3). When focusedId changes (from the
  // plan rail, inspector jump, or anywhere else that isn't a click on the
  // timeline itself), bring the corresponding row + lane into view. We skip
  // the scroll when the card is already visible on both axes — otherwise
  // clicking a card that's already in-frame would re-center it jarringly.
  const lastFocusHandled = useRef<string | null>(null);
  useEffect(() => {
    if (!focusedId) {
      lastFocusHandled.current = null;
      return;
    }
    if (lastFocusHandled.current === focusedId) return;

    const rowIndex = rows.findIndex(
      (r) => r.a2a.id === focusedId || r.chips.some((c) => c.id === focusedId),
    );
    if (rowIndex < 0) return;

    const row = rows[rowIndex];
    const focusedMsg =
      row.a2a.id === focusedId
        ? row.a2a
        : row.chips.find((c) => c.id === focusedId) ?? null;
    if (!focusedMsg) return;

    lastFocusHandled.current = focusedId;

    virtualizer.scrollToIndex(rowIndex, { behavior: 'smooth', align: 'auto' });

    const el = scrollRef.current;
    if (!el) return;
    const fromIdx =
      focusedMsg.fromAgentId === 'human' ? 0 : agentIndex.get(focusedMsg.fromAgentId) ?? 0;
    const cardX = TIMELINE_GUTTER_WIDTH + fromIdx * LANE_WIDTH + LANE_WIDTH / 2 - NODE_WIDTH / 2;
    const viewLeft = el.scrollLeft;
    const viewRight = viewLeft + el.clientWidth;
    if (cardX < viewLeft || cardX + NODE_WIDTH > viewRight) {
      el.scrollTo({ left: Math.max(0, cardX - 80), behavior: 'smooth' });
    }
  }, [focusedId, rows, virtualizer, agentIndex, scrollRef]);

  return (
    <div
      style={{ position: 'relative', width: totalWidth, height: totalHeight }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClearFocus();
      }}
    >
      <svg
        width={totalWidth}
        height={totalHeight}
        style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' }}
      >
        {virtualItems.map((vi, idx) => {
          const row = layouts[idx];
          if (!row) return null;
          const y = vi.start + TOP_PAD + NODE_HEIGHT / 2;
          return row.wires.map((w) => {
            const streaming = w.phase === 'streaming';
            const pulseX = w.sx + (w.tx - w.sx) * w.progress;
            const stroke = w.focused ? '#e8ecf2' : w.color;
            const groupOpacity = w.dimmed ? 0.18 : 1;
            return (
              <g key={w.id} opacity={groupOpacity} style={{ transition: 'opacity 180ms' }}>
                {w.focused && (
                  <line
                    x1={w.sx}
                    y1={y}
                    x2={w.tx}
                    y2={y}
                    stroke={w.color}
                    strokeWidth={4}
                    opacity={0.35}
                    fill="none"
                    shapeRendering="geometricPrecision"
                  />
                )}
                <line
                  x1={w.sx}
                  y1={y}
                  x2={w.tx}
                  y2={y}
                  stroke={stroke}
                  strokeWidth={w.focused ? 1.6 : 1}
                  strokeDasharray={w.dashed ? '3 2' : undefined}
                  opacity={streaming ? 0.35 : 1}
                  fill="none"
                  shapeRendering="geometricPrecision"
                />
                {streaming && (
                  <>
                    <line
                      x1={w.sx}
                      y1={y}
                      x2={pulseX}
                      y2={y}
                      stroke={stroke}
                      strokeWidth={w.focused ? 2 : 1.5}
                      fill="none"
                      shapeRendering="geometricPrecision"
                    />
                    <circle cx={pulseX} cy={y} r={3.5} fill={stroke} opacity={0.25} />
                    <circle cx={pulseX} cy={y} r={2} fill={stroke} />
                  </>
                )}
              </g>
            );
          });
        })}
      </svg>

      {virtualItems.map((vi, idx) => {
        const row = layouts[idx];
        if (!row) return null;
        const centerY = vi.start + TOP_PAD + NODE_HEIGHT / 2;
        return row.drops.map((d) => (
          <DropMarker
            key={d.id}
            drop={d}
            centerY={centerY}
            onClick={() => {
              onFocus(d.msgId);
              const el = scrollRef.current;
              if (el) {
                const target = row.event.cardX - 80;
                el.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
              }
            }}
          />
        ));
      })}

      {virtualItems.map((vi, idx) => {
        const row = layouts[idx];
        if (!row) return null;
        const y = vi.start + TOP_PAD;
        return (
          <EventCard
            key={row.event.id}
            evt={row.event}
            y={y}
            allMessages={allMessages}
            agentMap={agentMap}
            focused={focusedId === row.event.id}
            onFocus={onFocus}
            todoByTaskMessageId={todoByTaskMessageId}
            onJumpToTodo={onJumpToTodo}
          />
        );
      })}

      {virtualItems.map((vi, idx) => {
        const row = layouts[idx];
        if (!row) return null;
        const chipBaseY = vi.start + TOP_PAD + NODE_HEIGHT + CHIP_TOP_PAD;
        return row.chips.map((c, i) => (
          <ChipCard
            key={c.id}
            chip={c}
            y={chipBaseY + i * (CHIP_HEIGHT + CHIP_GAP)}
            focused={focusedId === c.msg.id}
            onFocus={onFocus}
          />
        ));
      })}

      {/* Left gutter — wall-clock HH:MM:SS per row, deduped so N events in
          the same second render as one label + N blanks. Held above the
          lane columns by a hairline right-border so it reads as navigation
          chrome, not content. */}
      {virtualItems.map((vi, idx) => {
        const row = layouts[idx];
        if (!row) return null;
        const tsMs = row.event.msg.tsMs;
        const y = vi.start + TOP_PAD;
        // Dedup against the previous row in the full `rows` array (not the
        // virtualItems slice) so scroll-starts mid-run still collapse
        // repeats correctly. Second-level granularity matches the display
        // format — finer would show noise without gaining signal.
        const prevTsMs = vi.index > 0 ? rows[vi.index - 1]?.a2a.tsMs : undefined;
        const sameSecond =
          tsMs != null && prevTsMs != null && Math.floor(tsMs / 1000) === Math.floor(prevTsMs / 1000);
        return (
          <div
            key={`ts-${row.event.id}`}
            className="absolute font-mono text-micro tabular-nums text-fog-600 hairline-r bg-ink-850/80 backdrop-blur select-none"
            style={{
              left: 0,
              top: y,
              width: TIMELINE_GUTTER_WIDTH,
              height: NODE_HEIGHT,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              paddingRight: 8,
            }}
          >
            {tsMs == null ? (
              <span className="text-fog-700">{row.event.msg.timestamp}</span>
            ) : sameSecond ? null : (
              <Tooltip content={fmtIso(tsMs)} side="right">
                <span className="cursor-default">{fmtWallClock(tsMs)}</span>
              </Tooltip>
            )}
          </div>
        );
      })}
    </div>
  );
}
