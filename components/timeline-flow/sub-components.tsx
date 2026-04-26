// Timeline-flow visual subcomponents — ChipCard, DropMarker, EventCard.
//
// Extracted from timeline-flow.tsx in #108. Each is purely presentational
// — receives the already-positioned layout object from buildRow and
// renders SVG / DOM at the supplied y-coordinate. The parent (timeline-
// flow.tsx) owns virtualization + scroll + the SVG container.

import clsx from 'clsx';
import type { Agent, AgentMessage, TodoItem } from '@/lib/swarm-types';
import { partMeta } from '@/lib/part-taxonomy';
import { Popover } from '../ui/popover';
import { Tooltip } from '../ui/tooltip';
import { EventInfo } from '../event-info';
import { compact } from '@/lib/format';
import {
  CARD_PIN_SIZE,
  CHIP_HEIGHT,
  CHIP_INSET,
  DROP_SIZE,
  LANE_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  eventLabel,
  type ChipLayout,
  type DropLayout,
  type EventLayout,
} from './types';
import { useTimelineInteraction } from '../swarm-timeline/interaction-context';

export function ChipCard({
  chip,
  y,
  focused,
}: {
  chip: ChipLayout;
  y: number;
  focused: boolean;
}) {
  // HARDENING_PLAN.md#C7 — onFocus from TimelineInteractionContext.
  const { onFocus } = useTimelineInteraction();
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

export function DropMarker({
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

export function EventCard({
  evt,
  y,
  allMessages,
  agentMap,
  focused,
  todoByTaskMessageId,
  onJumpToTodo,
}: {
  evt: EventLayout;
  y: number;
  allMessages: AgentMessage[];
  agentMap: Map<string, Agent>;
  focused: boolean;
  todoByTaskMessageId: Map<string, TodoItem>;
  onJumpToTodo: (todoId: string) => void;
}) {
  // HARDENING_PLAN.md#C7 — onFocus from TimelineInteractionContext.
  const { onFocus } = useTimelineInteraction();
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
