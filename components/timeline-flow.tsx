'use client';

import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import type { Agent, AgentMessage, TodoItem } from '@/lib/swarm-types';
import { partMeta, partHex, toolMeta, isCrossLane } from '@/lib/part-taxonomy';
import { Popover } from './ui/popover';
import { Tooltip } from './ui/tooltip';
import { EventInfo } from './event-info';
import { phaseFor, streamProgress, type MessagePhase } from '@/lib/playback-context';
import { compact } from '@/lib/format';

const LANE_WIDTH = 168;
const ROW_HEIGHT = 44;
const TOP_PAD = 16;
const NODE_WIDTH = 164;
const NODE_HEIGHT = ROW_HEIGHT - 6;
const DROP_SIZE = 14;
const CARD_PIN_SIZE = 6;
const CHIP_HEIGHT = 16;
const CHIP_GAP = 2;
const CHIP_TOP_PAD = 3;
const CHIP_INSET = 6;
// Left gutter shows wall-clock HH:MM:SS per row so events can be mapped
// to real time. Width kept narrow — the time label is ~54px at 10px font.
// Parent (swarm-timeline.tsx) reads this to offset lane headers + grid.
export const TIMELINE_GUTTER_WIDTH = 56;

function fmtWallClock(tsMs: number): string {
  const d = new Date(tsMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function fmtIso(tsMs: number): string {
  return new Date(tsMs).toISOString();
}

function accentFor(m: AgentMessage): string {
  if (m.toolName) return toolMeta[m.toolName].hex;
  return partHex[m.part];
}

function eventLabel(m: AgentMessage): string {
  if (m.toolName) return m.toolName;
  return partMeta[m.part].label;
}

type Row = { a2a: AgentMessage; chips: AgentMessage[] };

type RowLayout = {
  event: EventLayout;
  wires: WireLayout[];
  drops: DropLayout[];
  chips: ChipLayout[];
};

type EventLayout = {
  id: string;
  msg: AgentMessage;
  cardX: number;
  accent: string;
  isIO: boolean;
  phase: MessagePhase;
  progress: number;
  fromName: string;
  toNames: string[];
  dimmed: boolean;
  focused: boolean;
};

type WireLayout = {
  id: string;
  sx: number;
  tx: number;
  color: string;
  dashed: boolean;
  phase: MessagePhase;
  progress: number;
  dimmed: boolean;
  focused: boolean;
};

type DropLayout = {
  id: string;
  msgId: string;
  centerX: number;
  color: string;
  phase: MessagePhase;
  progress: number;
  dimmed: boolean;
  focused: boolean;
};

type ChipLayout = {
  id: string;
  msg: AgentMessage;
  x: number;
  color: string;
  phase: MessagePhase;
  dimmed: boolean;
  focused: boolean;
};

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

      {/* Left gutter — wall-clock HH:MM:SS per row (tooltip: full ISO). Held
          above the lane columns by a hairline right-border so it reads as
          navigation chrome, not content. */}
      {virtualItems.map((vi, idx) => {
        const row = layouts[idx];
        if (!row) return null;
        const tsMs = row.event.msg.tsMs;
        const y = vi.start + TOP_PAD;
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
            {tsMs != null ? (
              <Tooltip content={fmtIso(tsMs)} side="right">
                <span className="cursor-default">{fmtWallClock(tsMs)}</span>
              </Tooltip>
            ) : (
              <span className="text-fog-700">{row.event.msg.timestamp}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function buildRow(
  row: Row,
  agentIndex: Map<string, number>,
  agentMap: Map<string, Agent>,
  clockSec: number,
  focusedId: string | null,
  selectedAgentId: string | null,
): RowLayout {
  const m = row.a2a;
  const fromIdx = m.fromAgentId === 'human' ? 0 : agentIndex.get(m.fromAgentId) ?? 0;
  const fromCenterX = TIMELINE_GUTTER_WIDTH + fromIdx * LANE_WIDTH + LANE_WIDTH / 2;
  const cardX = fromCenterX - NODE_WIDTH / 2;
  const phase = phaseFor(m, clockSec);
  const progress = phase === 'streaming' ? streamProgress(m, clockSec) : 1;
  const fromName =
    m.fromAgentId === 'human' ? 'human' : agentMap.get(m.fromAgentId)?.name ?? m.fromAgentId;
  const toNames = m.toAgentIds.map((tid) =>
    tid === 'human' ? 'human' : agentMap.get(tid)?.name ?? tid,
  );
  const accent = accentFor(m);
  const isIO = isCrossLane(m);

  const msgFocused = focusedId === m.id;
  const otherFocused = focusedId != null && focusedId !== m.id;
  const msgInvolvesAgent =
    !selectedAgentId ||
    m.fromAgentId === selectedAgentId ||
    m.toAgentIds.includes(selectedAgentId);
  const eventDimmed = !msgFocused && (otherFocused || !msgInvolvesAgent);

  const event: EventLayout = {
    id: m.id,
    msg: m,
    cardX,
    accent,
    isIO,
    phase,
    progress,
    fromName,
    toNames,
    dimmed: eventDimmed,
    focused: msgFocused,
  };

  const wires: WireLayout[] = [];
  const drops: DropLayout[] = [];

  if (isIO) {
    const receivers = m.toAgentIds.filter((tid) => tid !== m.fromAgentId);
    const dashed = receivers.length > 1;

    receivers.forEach((tid, ti) => {
      const toIdx = tid === 'human' ? 0 : agentIndex.get(tid);
      if (toIdx === undefined) return;
      const toLaneX = TIMELINE_GUTTER_WIDTH + toIdx * LANE_WIDTH + LANE_WIDTH / 2;
      const goesRight = toLaneX > fromCenterX;
      const sx = goesRight ? fromCenterX + NODE_WIDTH / 2 : fromCenterX - NODE_WIDTH / 2;
      const edgeInvolvesAgent =
        !selectedAgentId || m.fromAgentId === selectedAgentId || tid === selectedAgentId;
      const edgeDimmed = !msgFocused && (otherFocused || !edgeInvolvesAgent);

      wires.push({
        id: `${m.id}__edge__${tid}__${ti}`,
        sx,
        tx: toLaneX,
        color: accent,
        dashed,
        phase,
        progress,
        dimmed: edgeDimmed,
        focused: msgFocused,
      });

      drops.push({
        id: `${m.id}__drop__${tid}__${ti}`,
        msgId: m.id,
        centerX: toLaneX,
        color: accent,
        phase,
        progress,
        dimmed: edgeDimmed,
        focused: msgFocused,
      });
    });
  }

  const chips: ChipLayout[] = row.chips.map((cm) => {
    const cIdx = cm.fromAgentId === 'human' ? 0 : agentIndex.get(cm.fromAgentId) ?? 0;
    const laneLeft = TIMELINE_GUTTER_WIDTH + cIdx * LANE_WIDTH + CHIP_INSET;
    const cPhase = phaseFor(cm, clockSec);
    const chipFocused = focusedId === cm.id;
    const otherFocusedForChip = focusedId != null && focusedId !== cm.id;
    const chipInvolvesAgent = !selectedAgentId || cm.fromAgentId === selectedAgentId;
    return {
      id: cm.id,
      msg: cm,
      x: laneLeft,
      color: accentFor(cm),
      phase: cPhase,
      dimmed: !chipFocused && (otherFocusedForChip || !chipInvolvesAgent),
      focused: chipFocused,
    };
  });

  return { event, wires, drops, chips };
}

function ChipCard({
  chip,
  y,
  focused,
  onFocus,
}: {
  chip: ChipLayout;
  y: number;
  focused: boolean;
  onFocus: (id: string) => void;
}) {
  const m = chip.msg;
  const streaming = chip.phase === 'streaming';
  const width = LANE_WIDTH - CHIP_INSET * 2;
  const label = m.toolSubtitle ?? m.title;
  const right = m.duration ?? (m.tokens != null ? compact(m.tokens) : '');

  return (
    <div
      style={{
        position: 'absolute',
        left: chip.x,
        top: y,
        width,
        height: CHIP_HEIGHT,
        zIndex: focused ? 15 : 5,
        opacity: chip.dimmed ? 0.22 : 1,
        transition: 'opacity 180ms',
      }}
    >
      <Tooltip
        side="right"
        align="center"
        content={
          <div className="space-y-1 min-w-[200px]">
            <div className="font-mono text-[10.5px] uppercase tracking-widest2 text-fog-500">
              {m.toolName ? `tool: ${m.toolName}` : partMeta[m.part].label}
            </div>
            <div className="text-[12px] text-fog-100 leading-snug">{m.title}</div>
            {m.toolSubtitle && (
              <div className="font-mono text-[10.5px] text-fog-500 truncate">
                {m.toolSubtitle}
              </div>
            )}
            <div className="flex items-center gap-2 font-mono text-[10px] text-fog-600 tabular-nums">
              {m.duration && <span>{m.duration}</span>}
              {m.tokens != null && <span>{compact(m.tokens)}</span>}
              <span className="ml-auto">{m.timestamp}</span>
            </div>
          </div>
        }
      >
        <button
          onClick={() => onFocus(m.id)}
          style={{ width, height: CHIP_HEIGHT }}
          className={clsx(
            'flex items-center gap-1.5 pl-1.5 pr-1 rounded-sm bg-ink-900/80 border transition text-left',
            focused ? 'border-fog-400/70' : 'border-ink-700 hover:border-ink-500',
            m.status === 'abandoned' && 'opacity-40',
            streaming && 'opacity-90',
          )}
        >
          <span
            className="font-mono text-[9px] uppercase tracking-wider shrink-0"
            style={{ color: chip.color }}
          >
            {eventLabel(m)}
          </span>
          <span className="flex-1 min-w-0 truncate text-[10.5px] text-fog-300 leading-none">
            {label}
          </span>
          {right && (
            <span className="font-mono text-[9px] tabular-nums text-fog-600 shrink-0">
              {right}
            </span>
          )}
        </button>
      </Tooltip>
    </div>
  );
}

function DropMarker({
  drop,
  centerY,
  onClick,
}: {
  drop: DropLayout;
  centerY: number;
  onClick: () => void;
}) {
  const streaming = drop.phase === 'streaming';
  const halfCircumference = 2 * Math.PI * 6;
  const focused = drop.focused;
  return (
    <div
      onClick={onClick}
      style={{
        position: 'absolute',
        left: drop.centerX - DROP_SIZE / 2,
        top: centerY - DROP_SIZE / 2,
        width: DROP_SIZE,
        height: DROP_SIZE,
        cursor: 'pointer',
        opacity: drop.dimmed ? 0.2 : 1,
        transition: 'opacity 180ms',
        zIndex: focused ? 18 : 6,
      }}
    >
      <svg
        width={DROP_SIZE}
        height={DROP_SIZE}
        viewBox={`0 0 ${DROP_SIZE} ${DROP_SIZE}`}
        style={{ overflow: 'visible' }}
      >
        {focused && (
          <circle
            cx={DROP_SIZE / 2}
            cy={DROP_SIZE / 2}
            r={9}
            fill={drop.color}
            opacity={0.18}
          />
        )}
        <circle
          cx={DROP_SIZE / 2}
          cy={DROP_SIZE / 2}
          r={6}
          fill="none"
          stroke={focused ? '#e8ecf2' : drop.color}
          strokeWidth={focused ? 0.8 : 0.5}
          opacity={focused ? 0.6 : streaming ? 0.25 : 0.15}
        />
        <circle
          cx={DROP_SIZE / 2}
          cy={DROP_SIZE / 2}
          r={6}
          fill="none"
          stroke={focused ? '#e8ecf2' : drop.color}
          strokeWidth={focused ? 1.6 : 1.2}
          strokeLinecap="round"
          strokeDasharray={halfCircumference}
          strokeDashoffset={(1 - drop.progress) * halfCircumference}
          transform={`rotate(-90 ${DROP_SIZE / 2} ${DROP_SIZE / 2})`}
          opacity={focused ? 1 : streaming ? 0.95 : 0.4}
        />
        <rect
          x={DROP_SIZE / 2 - 2.5}
          y={DROP_SIZE / 2 - 2.5}
          width={5}
          height={5}
          fill={focused ? drop.color : '#0b0d10'}
          stroke={focused ? '#e8ecf2' : drop.color}
          strokeWidth={1}
          opacity={focused ? 1 : streaming ? 0.5 : 1}
        />
      </svg>
    </div>
  );
}

function EventCard({
  evt,
  y,
  allMessages,
  agentMap,
  focused,
  onFocus,
  todoByTaskMessageId,
  onJumpToTodo,
}: {
  evt: EventLayout;
  y: number;
  allMessages: AgentMessage[];
  agentMap: Map<string, Agent>;
  focused: boolean;
  onFocus: (id: string) => void;
  todoByTaskMessageId: Map<string, TodoItem>;
  onJumpToTodo: (todoId: string) => void;
}) {
  const { msg, cardX, accent, isIO, phase, progress, fromName, toNames, dimmed } = evt;
  const labelTop = eventLabel(msg);
  const secondary = msg.toolName ? partMeta[msg.part].label : null;
  const streaming = phase === 'streaming';
  const partialTokens = msg.tokens != null ? Math.round(msg.tokens * progress) : null;
  const bodyRight =
    streaming && partialTokens != null
      ? compact(partialTokens)
      : msg.tokens != null
        ? compact(msg.tokens)
        : msg.duration ?? '';

  // Task-tool cards get a "todo· X" eyebrow pointing back at the plan row
  // that delegated this call. Binding comes from transform.ts; the eyebrow
  // is absent (not a broken pill) when no matching todo was found.
  const boundTodo =
    msg.toolName === 'task' ? todoByTaskMessageId.get(msg.id) : undefined;

  return (
    <div
      style={{
        position: 'absolute',
        left: cardX,
        top: y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        zIndex: focused ? 20 : 10,
        opacity: dimmed ? 0.25 : 1,
        transition: 'opacity 180ms',
      }}
    >
      {isIO && (
        <>
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: -CARD_PIN_SIZE / 2,
              top: NODE_HEIGHT / 2 - CARD_PIN_SIZE / 2,
              width: CARD_PIN_SIZE,
              height: CARD_PIN_SIZE,
              borderRadius: 999,
              background: accent,
              zIndex: 1,
            }}
          />
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: NODE_WIDTH - CARD_PIN_SIZE / 2,
              top: NODE_HEIGHT / 2 - CARD_PIN_SIZE / 2,
              width: CARD_PIN_SIZE,
              height: CARD_PIN_SIZE,
              borderRadius: 999,
              background: accent,
              zIndex: 1,
            }}
          />
        </>
      )}

      <Popover
        side="right"
        align="start"
        content={() => (
          <EventInfo
            msg={msg}
            fromName={fromName}
            toNames={toNames}
            allMessages={allMessages}
            agentMap={agentMap}
            onNavigate={onFocus}
          />
        )}
      >
        <button
          onClick={() => onFocus(msg.id)}
          className={clsx('block text-left transition')}
          style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
        >
          <div
            className={clsx(
              'w-full h-full border bg-ink-850 relative overflow-visible transition-opacity',
              focused
                ? 'border-fog-200/80'
                : msg.status === 'error'
                  ? 'border-rust/60'
                  : streaming
                    ? 'border-ink-500'
                    : 'border-ink-600 hover:border-ink-500',
              msg.status === 'abandoned' && 'opacity-40',
              streaming && 'opacity-90',
            )}
            style={
              focused
                ? { boxShadow: `0 0 0 1px ${accent}55, 0 0 18px 2px ${accent}40, inset 0 0 0 1px ${accent}25` }
                : streaming
                  ? { boxShadow: `inset 0 0 0 1px ${accent}30` }
                  : undefined
            }
          >
            <span
              aria-hidden
              className="absolute left-0 right-0 top-0 h-[2px]"
              style={{ backgroundColor: accent }}
            />
            <div className="h-full pl-2 pr-2 pt-[3px] pb-[4px] flex flex-col justify-between overflow-hidden">
              <div className="flex items-center gap-1.5 h-[12px] min-w-0">
                <span
                  className="font-mono text-[9px] uppercase tracking-wider shrink-0"
                  style={{ color: accent }}
                >
                  {labelTop}
                </span>
                {boundTodo ? (
                  <Tooltip
                    side="top"
                    wide
                    content={
                      <div className="space-y-1">
                        <div className="font-mono text-[10.5px] uppercase tracking-widest2 text-fog-500">
                          carries plan item {boundTodo.id}
                        </div>
                        <div className="font-mono text-[11px] text-fog-200 leading-snug">
                          {boundTodo.content}
                        </div>
                        <div className="font-mono text-[9.5px] text-fog-600">
                          click to reveal in plan
                        </div>
                      </div>
                    }
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onJumpToTodo(boundTodo.id);
                      }}
                      className="shrink-0 inline-flex items-center h-[12px] px-1 rounded-[2px] font-mono text-[9px] uppercase tracking-wider text-molten bg-molten/10 hover:bg-molten/20 border border-molten/25 transition"
                    >
                      todo·{boundTodo.id}
                    </button>
                  </Tooltip>
                ) : secondary && (
                  <span className="font-mono text-[9px] uppercase tracking-wider text-fog-600 shrink-0">
                    {secondary}
                  </span>
                )}
                <span className="ml-auto font-mono text-[9px] text-fog-600 tabular-nums shrink-0">
                  {msg.timestamp}
                </span>
              </div>
              <div className="flex items-center gap-1.5 h-[16px] min-w-0">
                <span
                  className={clsx(
                    'flex-1 min-w-0 text-[11.5px] truncate leading-tight',
                    streaming ? 'text-fog-300' : 'text-fog-100',
                  )}
                >
                  {msg.title}
                </span>
                {bodyRight && (
                  <span
                    className="font-mono text-[9.5px] tabular-nums shrink-0"
                    style={{ color: streaming ? accent : '#7d8798' }}
                  >
                    {bodyRight}
                  </span>
                )}
              </div>
            </div>
            {streaming && (
              <span
                aria-hidden
                className="absolute left-0 bottom-0 h-[2px] transition-[width] duration-75"
                style={{ width: `${progress * 100}%`, backgroundColor: accent }}
              />
            )}
            {!streaming && msg.status === 'running' && (
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-[2px] shimmer-line animate-shimmer"
              />
            )}
          </div>
        </button>
      </Popover>
    </div>
  );
}
