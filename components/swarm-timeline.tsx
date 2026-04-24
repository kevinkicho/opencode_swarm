'use client';

import clsx from 'clsx';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Agent, AgentMessage, PartType, TodoItem, ToolName } from '@/lib/swarm-types';
import { IconSearch, IconFilter } from './icons';
import { ProviderBadge } from './provider-badge';
import { Tooltip } from './ui/tooltip';
import { Popover } from './ui/popover';
import { ScrollToBottomButton } from './ui/scroll-to-bottom';
import { TimelineFlow, TIMELINE_GUTTER_WIDTH } from './timeline-flow';
import { partMeta, partHex, partOrder, toolMeta, isCrossLane } from '@/lib/part-taxonomy';
import { compact } from '@/lib/format';
import { useBackendStale } from '@/lib/opencode/live';
import {
  usePlayback,
  phaseFor,
  laneThroughput,
  formatRate,
  type LaneThroughput,
} from '@/lib/playback-context';
import { computeAttention, statusCircle } from '@/lib/agent-status';

const LANE_WIDTH = 168;
const ROW_HEIGHT = 44;
const HEADER_HEIGHT = 72;
const TOP_PAD = 16;
const CHIP_HEIGHT = 16;
const CHIP_GAP = 2;
const CHIP_TOP_PAD = 3;

const accentStripe: Record<Agent['accent'], string> = {
  molten: 'bg-molten',
  mint: 'bg-mint',
  iris: 'bg-iris',
  amber: 'bg-amber',
  fog: 'bg-fog-500',
};

const accentText: Record<Agent['accent'], string> = {
  molten: 'text-molten',
  mint: 'text-mint',
  iris: 'text-iris',
  amber: 'text-amber',
  fog: 'text-fog-400',
};

type Filter = 'all' | 'delegate' | 'subtask' | 'tool' | 'reasoning' | 'patch' | 'errors';

const filters: { key: Filter; label: string; hint: string }[] = [
  { key: 'all', label: 'all', hint: 'all parts' },
  { key: 'delegate', label: 'delegate', hint: 'task tool - A2A spawns' },
  { key: 'subtask', label: 'subtask', hint: 'sub-agent returns' },
  { key: 'tool', label: 'tools', hint: 'any tool call' },
  { key: 'reasoning', label: 'reasoning', hint: 'internal model thought' },
  { key: 'patch', label: 'patch', hint: 'code diffs' },
  { key: 'errors', label: 'errors', hint: 'error status' },
];

function matches(m: AgentMessage, f: Filter) {
  if (f === 'all') return true;
  if (f === 'errors') return m.status === 'error';
  if (f === 'delegate') return m.part === 'tool' && m.toolName === 'task';
  if (f === 'tool') return m.part === 'tool';
  if (f === 'subtask') return m.part === 'subtask';
  if (f === 'reasoning') return m.part === 'reasoning';
  if (f === 'patch') return m.part === 'patch';
  return true;
}

export function SwarmTimeline({
  agents,
  messages,
  agentOrder,
  focusedId,
  onFocus,
  onClearFocus,
  selectedAgentId,
  onSelectAgent,
  todos,
  onJumpToTodo,
}: {
  agents: Agent[];
  messages: AgentMessage[];
  agentOrder: string[];
  focusedId: string | null;
  onFocus: (id: string) => void;
  onClearFocus: () => void;
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
  todos: TodoItem[];
  onJumpToTodo: (todoId: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [partFilter, setPartFilter] = useState<PartType | 'all'>('all');
  const { clockSec } = usePlayback();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // When the dev backend has been unreachable long enough, the lane
  // status circles should stop pulsing — their "live" animation is
  // stale data after the SSE feed drops. See useBackendStale docs.
  const backendStale = useBackendStale();
  // Anchor-tracking refs for stick-to-bottom: `firstIdRef` distinguishes a
  // fresh session (forces a jump), `lastIdRef` triggers follow-on auto-scroll
  // only when the user was already near the bottom.
  const firstIdRef = useRef<string | null>(null);
  const lastIdRef = useRef<string | null>(null);

  const agentIndex = useMemo(() => {
    const m = new Map<string, number>();
    agentOrder.forEach((id, i) => m.set(id, i));
    return m;
  }, [agentOrder]);

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    agents.forEach((a) => m.set(a.id, a));
    return m;
  }, [agents]);

  // Reverse index: task-tool message -> originating todo. Lets each task
  // card in the timeline surface a "todo· X" eyebrow showing which plan
  // item it was delegated to carry out. Binding is established in
  // transform.ts's toRunPlan via hash-match; see DESIGN.md §8.
  const todoByTaskMessageId = useMemo(() => {
    const m = new Map<string, TodoItem>();
    for (const t of todos) {
      if (t.taskMessageId) m.set(t.taskMessageId, t);
    }
    return m;
  }, [todos]);

  const filtered = useMemo(
    () =>
      messages.filter((m) => {
        if (!matches(m, filter)) return false;
        if (partFilter !== 'all' && m.part !== partFilter) return false;
        if (phaseFor(m, clockSec) === 'hidden') return false;
        if (!query) return true;
        const hay = `${m.title} ${m.body ?? ''} ${m.toolSubtitle ?? ''}`.toLowerCase();
        return hay.includes(query.toLowerCase());
      }),
    [messages, filter, partFilter, query, clockSec],
  );

  const partCounts = useMemo(() => {
    const c = new Map<PartType, number>();
    messages.forEach((m) => c.set(m.part, (c.get(m.part) ?? 0) + 1));
    return c;
  }, [messages]);

  // A row is a "lead" event (cross-lane, gets a wire) followed by
  // chip events that pile up beneath it in the sender lane until the
  // next cross-lane event.
  const rows = useMemo(() => {
    const out: { a2a: AgentMessage; chips: AgentMessage[] }[] = [];
    let current: { a2a: AgentMessage; chips: AgentMessage[] } | null = null;
    for (const m of filtered) {
      if (!isCrossLane(m)) {
        if (current) current.chips.push(m);
        else out.push({ a2a: m, chips: [] });
      } else {
        current = { a2a: m, chips: [] };
        out.push(current);
      }
    }
    return out;
  }, [filtered]);

  const rowHeights = useMemo(
    () =>
      rows.map((r) =>
        r.chips.length > 0
          ? ROW_HEIGHT + CHIP_TOP_PAD + r.chips.length * (CHIP_HEIGHT + CHIP_GAP)
          : ROW_HEIGHT,
      ),
    [rows],
  );

  const totalHeight = rowHeights.reduce((a, b) => a + b, 0) + TOP_PAD * 2;
  const totalWidth = TIMELINE_GUTTER_WIDTH + agentOrder.length * LANE_WIDTH;

  // Stick-to-bottom: on a fresh session (first message id changes) always
  // land at the latest; on new messages within a session follow only if
  // the user was effectively AT the bottom (tight threshold so a manual
  // scroll-up reliably disengages auto-follow). 48 px tolerance covers
  // rounding + the floating "latest" button that anchors to bottom-3.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;
    const firstId = messages[0].id;
    const lastId = messages[messages.length - 1].id;

    if (firstId !== firstIdRef.current) {
      // Two-phase snap: scrollTop=scrollHeight first (synchronous, before
      // paint), then rAF a second pass so any content the React commit is
      // still settling (sticky headers, lazy rows) can't leave us a few
      // px short of truly-bottom. Needed for large runs where the first
      // layout pass underreports scrollHeight.
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        if (scrollRef.current === el) el.scrollTop = el.scrollHeight;
      });
      firstIdRef.current = firstId;
      lastIdRef.current = lastId;
      return;
    }

    if (lastId !== lastIdRef.current) {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      // Follow only when actually at bottom (within the floating-button
      // clearance). Anything looser yanks the view when the user is
      // mid-read 200 px up.
      if (distance < 48) el.scrollTop = el.scrollHeight;
      lastIdRef.current = lastId;
    }
  }, [messages, totalHeight]);

  return (
    <section className="relative flex-1 flex flex-col min-w-0 min-h-0 bg-ink-800">
      <div className="relative hairline-b">
        <div className="h-10 px-4 flex items-center gap-2 bg-ink-800/80 backdrop-blur">
          <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
            session timeline
          </span>
          <Tooltip
            content={`${filtered.length} parts across ${agents.length} agent lanes`}
            side="bottom"
          >
            <span className="font-mono text-micro text-fog-700 cursor-default">
              {filtered.length}
            </span>
          </Tooltip>

          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <IconSearch
                size={11}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-fog-600"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="search..."
                className="w-40 h-6 pl-6 pr-2 rounded bg-ink-900 hairline text-[11.5px] text-fog-100 placeholder:text-fog-700 focus:outline-none focus:border-molten/40 focus:w-56 transition-all"
              />
            </div>

            <PartLegend
              partFilter={partFilter}
              onChange={setPartFilter}
              counts={partCounts}
            />

            <Popover
              side="bottom"
              align="end"
              wide
              content={(close) => (
                <div className="space-y-1.5 min-w-[220px]">
                  <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
                    quick filter
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {filters.map((f) => (
                      <Tooltip key={f.key} content={f.hint} side="top">
                        <button
                          type="button"
                          onClick={() => {
                            setFilter(f.key);
                            close();
                          }}
                          className={clsx(
                            'h-6 px-2 rounded flex items-center transition cursor-pointer',
                            filter === f.key
                              ? 'bg-molten/15 text-molten border border-molten/30'
                              : 'bg-ink-800 text-fog-400 hairline hover:border-ink-500',
                          )}
                        >
                          <span className="font-mono text-micro uppercase tracking-wider">
                            {f.label}
                          </span>
                        </button>
                      </Tooltip>
                    ))}
                  </div>
                </div>
              )}
            >
              <button
                type="button"
                className={clsx(
                  'flex items-center gap-1.5 h-6 px-2 rounded bg-ink-900 hairline hover:border-ink-500 transition cursor-pointer',
                  filter !== 'all' && 'border-molten/30 bg-molten/5 text-molten',
                )}
              >
                <IconFilter size={10} />
                <span className="font-mono text-micro uppercase tracking-wider">
                  {filter === 'all' ? 'filter' : filter}
                </span>
              </button>
            </Popover>
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-auto bg-grid-dots"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClearFocus();
        }}
      >
        <div
          className="relative"
          // 56 px bottom padding reserves clearance below the last row
          // so the floating "latest" button (absolute, bottom-3, ~24 px
          // tall) doesn't overlay the tail of the timeline when scrolled
          // to bottom. Before this pad, "scroll to latest" landed with
          // the final message visually behind the chip.
          style={{
            width: Math.max(totalWidth, 800),
            minHeight: totalHeight + HEADER_HEIGHT + 56,
            paddingBottom: 56,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClearFocus();
          }}
        >
          <div
            className="sticky top-0 z-20 flex hairline-b bg-ink-800/95 backdrop-blur"
            style={{ height: HEADER_HEIGHT }}
            onClick={(e) => {
              if (e.target === e.currentTarget) onClearFocus();
            }}
          >
            {/* Gutter spacer — aligns lane columns with the timestamp column
                rendered per-row inside TimelineFlow. */}
            <div
              className="shrink-0 hairline-r font-mono text-micro uppercase tracking-widest2 text-fog-600 flex items-center justify-end"
              style={{ width: TIMELINE_GUTTER_WIDTH, paddingRight: 8 }}
            >
              time
            </div>
            {agentOrder.map((id) => {
              const a = agentMap.get(id)!;
              const active = selectedAgentId === id;
              const throughput = laneThroughput(id, messages, clockSec);
              const attention = computeAttention(a, messages);
              const circle = statusCircle(a, attention);

              return (
                <Tooltip
                  key={id}
                  side="bottom"
                  wide
                  content={
                    <div className="space-y-1.5 min-w-[200px]">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] text-fog-100">{a.name}</span>
                      </div>
                      <ProviderBadge provider={a.model.provider} label={a.model.label} size="sm" />
                      {a.focus && (
                        <div className="font-mono text-[10.5px] text-fog-500 leading-snug">
                          {a.focus}
                        </div>
                      )}
                      <div className="flex items-center gap-3 font-mono text-[10.5px] text-fog-600 tabular-nums">
                        <span>${a.costUsed.toFixed(2)}</span>
                        <span>{compact(a.tokensUsed)} tok</span>
                        <span>sent {a.messagesSent}</span>
                        <span>recv {a.messagesRecv}</span>
                      </div>
                      {(throughput.inRate > 0 || throughput.outRate > 0) && (
                        <div className="pt-1.5 hairline-t space-y-0.5">
                          <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
                            live throughput
                          </div>
                          <div className="flex items-center gap-2 font-mono text-[10.5px] text-fog-300 tabular-nums">
                            <span>out {formatRate(throughput.outRate)}/s</span>
                            <span className="text-fog-500">{throughput.activeOut.length} active</span>
                          </div>
                          <div className="flex items-center gap-2 font-mono text-[10.5px] text-fog-300 tabular-nums">
                            <span>in {formatRate(throughput.inRate)}/s</span>
                            <span className="text-fog-500">{throughput.activeIn.length} active</span>
                          </div>
                        </div>
                      )}
                      <div className="hairline-t pt-1.5 font-mono text-[10.5px] text-fog-600 opacity-20">
                        click lane to inspect
                      </div>
                    </div>
                  }
                >
                  <button
                    onClick={() => onSelectAgent(id)}
                    className={clsx(
                      'shrink-0 text-left hairline-r transition relative w-full',
                      active ? 'bg-ink-700/40' : 'hover:bg-ink-700/20',
                    )}
                    style={{ width: LANE_WIDTH }}
                  >
                    <span
                      className={clsx(
                        'absolute left-0 right-0 top-0 h-[2px]',
                        accentStripe[a.accent],
                        !active && 'opacity-70',
                      )}
                    />
                    <div className="px-3 pt-2.5 pb-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={clsx(
                            'w-1.5 h-1.5 rounded-full shrink-0',
                            // When the backend is stale, drop the animation
                            // and use a neutral dot color — an orange pulse
                            // without a live SSE feed is disinformation. The
                            // lane itself still renders (history is
                            // useful); just the "live-looking" veneer
                            // comes off.
                            backendStale ? 'bg-fog-700' : circle.dot,
                            backendStale ? undefined : circle.animation,
                          )}
                        />
                        <span className="text-[12px] text-fog-100 truncate flex-1 min-w-0">
                          {a.name}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 min-w-0">
                        {a.focus && (
                          <span
                            className={clsx(
                              'font-mono text-micro tracking-wide truncate min-w-0 flex-1',
                              accentText[a.accent],
                              'opacity-70',
                            )}
                          >
                            {a.focus}
                          </span>
                        )}
                        <ProviderBadge provider={a.model.provider} size="sm" clickable />
                      </div>
                      <LaneMeter throughput={throughput} tokens={a.tokensUsed} cost={a.costUsed} />
                    </div>
                    {active && (
                      <span className="absolute left-0 right-0 bottom-0 h-[1px] bg-molten" />
                    )}
                  </button>
                </Tooltip>
              );
            })}
          </div>

          {agentOrder.map((id, i) => (
            <div
              key={id}
              className={clsx(
                'absolute top-0 bottom-0 w-px',
                selectedAgentId === id ? 'bg-molten/20' : 'bg-ink-600/40',
              )}
              style={{ left: TIMELINE_GUTTER_WIDTH + i * LANE_WIDTH + LANE_WIDTH / 2 }}
            />
          ))}

          <div
            className="absolute"
            style={{
              top: HEADER_HEIGHT,
              left: 0,
              width: Math.max(totalWidth, 800),
              height: totalHeight,
            }}
          >
            <TimelineFlow
              agents={agents}
              agentOrder={agentOrder}
              agentIndex={agentIndex}
              agentMap={agentMap}
              rows={rows}
              rowHeights={rowHeights}
              allMessages={messages}
              focusedId={focusedId}
              onFocus={onFocus}
              onClearFocus={onClearFocus}
              selectedAgentId={selectedAgentId}
              clockSec={clockSec}
              totalWidth={Math.max(totalWidth, 800)}
              totalHeight={totalHeight}
              scrollRef={scrollRef}
              scrollMargin={HEADER_HEIGHT + TOP_PAD}
              todoByTaskMessageId={todoByTaskMessageId}
              onJumpToTodo={onJumpToTodo}
            />
          </div>
        </div>
      </div>
      <ScrollToBottomButton scrollRef={scrollRef} />
    </section>
  );
}

function LaneMeter({
  throughput,
  tokens,
  cost,
}: {
  throughput: LaneThroughput;
  tokens: number;
  cost: number;
}) {
  const hasOut = throughput.outRate > 0;
  const hasIn = throughput.inRate > 0;
  const anyActive = hasOut || hasIn;

  const uniqueColors = new Map<string, string>();
  for (const s of [...throughput.activeOut, ...throughput.activeIn]) {
    const key = s.toolName ?? `part:${s.part}`;
    const color = s.toolName ? toolMeta[s.toolName].hex : partHex[s.part];
    if (!uniqueColors.has(key)) uniqueColors.set(key, color);
  }
  const dots = Array.from(uniqueColors.values()).slice(0, 5);

  return (
    <>
      <div className="mt-1 flex items-center gap-1.5 h-3 font-mono text-[9.5px] tabular-nums">
        <Tooltip content="outbound part rate" side="top">
          <span
            className={clsx(
              'shrink-0 transition-colors cursor-help',
              hasOut ? 'text-fog-200' : 'text-fog-800',
            )}
          >
            out {formatRate(throughput.outRate)}
          </span>
        </Tooltip>
        <Tooltip content="inbound part rate" side="top">
          <span
            className={clsx(
              'shrink-0 transition-colors cursor-help',
              hasIn ? 'text-fog-200' : 'text-fog-800',
            )}
          >
            in {formatRate(throughput.inRate)}
          </span>
        </Tooltip>
        <div className="ml-auto flex items-center gap-[3px]">
          {dots.map((color, i) => (
            <span
              key={i}
              className="w-1 h-1 rounded-full animate-pulse"
              style={{ backgroundColor: color }}
            />
          ))}
          {!anyActive && <span className="w-1 h-1 rounded-full bg-ink-600" />}
        </div>
      </div>
      {/* Cumulative tokens + cost. Always rendered so a quiet lane
          still carries meaningful data (rates alone read as zeros
          when a session is between turns). Compact format: "12.4K
          tok · $0.42" fits within the typical lane width. */}
      <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[9.5px] tabular-nums text-fog-600">
        <Tooltip content="cumulative tokens this session" side="top">
          <span className="shrink-0 cursor-help">{compact(tokens)} tok</span>
        </Tooltip>
        <span className="text-fog-800">·</span>
        <Tooltip content="cumulative cost this session" side="top">
          <span className="shrink-0 cursor-help">${cost.toFixed(2)}</span>
        </Tooltip>
      </div>
    </>
  );
}

function PartLegend({
  partFilter,
  onChange,
  counts,
}: {
  partFilter: PartType | 'all';
  onChange: (v: PartType | 'all') => void;
  counts: Map<PartType, number>;
}) {
  const active = partFilter !== 'all';
  // Popover (click-pin), not Tooltip: the rows inside are interactive —
  // click a label to isolate that part in the main view. Tooltip would
  // collapse the moment the mouse moved onto a row and the click would
  // never register. See the interactive_tooltip project memory.
  return (
    <Popover
      side="bottom"
      align="end"
      wide
      content={(close) => (
        <div className="space-y-2 min-w-[320px]">
          <div className="flex items-center gap-2">
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
              part types
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700">
              opencode sdk
            </span>
            <button
              type="button"
              onClick={() => onChange('all')}
              className={clsx(
                'ml-auto font-mono text-micro uppercase tracking-wider transition cursor-pointer',
                partFilter === 'all' ? 'text-molten' : 'text-fog-600 hover:text-fog-200',
              )}
            >
              show all
            </button>
          </div>

          {/* Grid: label | blurb | count. tabular-nums on the count column
              so digits align vertically across rows. */}
          <ul
            className="list-none"
            style={{
              display: 'grid',
              gridTemplateColumns: 'max-content 1fr max-content',
              columnGap: '10px',
              rowGap: '1px',
            }}
          >
            {partOrder.map((p) => {
              const selected = partFilter === p;
              const count = counts.get(p) ?? 0;
              if (count === 0) return null;
              return (
                <li key={p} className="contents">
                  <button
                    type="button"
                    onClick={() => {
                      onChange(selected ? 'all' : p);
                      close();
                    }}
                    className={clsx(
                      'contents font-mono text-micro uppercase tracking-wider cursor-pointer group',
                    )}
                    aria-label={`isolate ${partMeta[p].label}`}
                  >
                    <span
                      className={clsx(
                        'h-6 px-2 flex items-center rounded-l',
                        selected ? 'bg-ink-700' : 'group-hover:bg-ink-800',
                      )}
                      style={{ color: partHex[p] }}
                    >
                      {partMeta[p].label}
                    </span>
                    <span
                      className={clsx(
                        'h-6 flex items-center text-[10.5px] text-fog-500 normal-case truncate',
                        selected ? 'bg-ink-700' : 'group-hover:bg-ink-800',
                      )}
                    >
                      {partMeta[p].blurb}
                    </span>
                    <span
                      className={clsx(
                        'h-6 px-2 flex items-center justify-end text-[10.5px] text-fog-400 tabular-nums rounded-r',
                        selected ? 'bg-ink-700' : 'group-hover:bg-ink-800',
                      )}
                    >
                      {count}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="hairline-t pt-1 font-mono text-[10.5px] text-fog-600 opacity-40">
            click a label to isolate that part type in the main view
          </div>
        </div>
      )}
    >
      <button
        type="button"
        className={clsx(
          'flex items-center gap-1.5 h-6 px-2 rounded hairline transition cursor-pointer',
          active ? 'border-molten/30 bg-molten/5' : 'bg-ink-900 hover:border-ink-500',
        )}
      >
        <span
          className={clsx(
            'font-mono text-micro uppercase tracking-wider',
            active ? 'text-molten' : 'text-fog-400',
          )}
        >
          {active ? partMeta[partFilter as PartType].label : 'parts'}
        </span>
        {active && (
          <span className="font-mono text-[9px] text-fog-600 tabular-nums">
            {counts.get(partFilter as PartType) ?? 0}
          </span>
        )}
      </button>
    </Popover>
  );
}

// ToolName export retained for consumers that reference the type indirectly.
export type { ToolName };
