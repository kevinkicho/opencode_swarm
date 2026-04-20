'use client';

import clsx from 'clsx';
import { useMemo, useRef, useState } from 'react';
import type { Agent, AgentMessage, PartType, ToolName } from '@/lib/swarm-types';
import { IconSearch, IconFilter } from './icons';
import { ProviderBadge } from './provider-badge';
import { Tooltip } from './ui/tooltip';
import { TimelineFlow } from './timeline-flow';
import { partMeta, partHex, partOrder, toolMeta, isCrossLane } from '@/lib/part-taxonomy';
import { compact } from '@/lib/format';
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
}: {
  agents: Agent[];
  messages: AgentMessage[];
  agentOrder: string[];
  focusedId: string | null;
  onFocus: (id: string) => void;
  onClearFocus: () => void;
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [partFilter, setPartFilter] = useState<PartType | 'all'>('all');
  const { clockSec } = usePlayback();
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
  const totalWidth = agentOrder.length * LANE_WIDTH;

  return (
    <section className="relative flex flex-col min-w-0 min-h-0 bg-ink-800">
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

            <Tooltip
              side="bottom"
              align="end"
              wide
              content={
                <div className="space-y-1.5 min-w-[220px]">
                  <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
                    quick filter
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {filters.map((f) => (
                      <Tooltip key={f.key} content={f.hint} side="top">
                        <button
                          onClick={() => setFilter(f.key)}
                          className={clsx(
                            'h-6 px-2 rounded flex items-center transition',
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
              }
            >
              <button
                className={clsx(
                  'flex items-center gap-1.5 h-6 px-2 rounded bg-ink-900 hairline hover:border-ink-500 transition',
                  filter !== 'all' && 'border-molten/30 bg-molten/5 text-molten',
                )}
              >
                <IconFilter size={10} />
                <span className="font-mono text-micro uppercase tracking-wider">
                  {filter === 'all' ? 'filter' : filter}
                </span>
              </button>
            </Tooltip>
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
          style={{ width: Math.max(totalWidth, 800), minHeight: totalHeight + HEADER_HEIGHT }}
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
                            circle.dot,
                            circle.animation,
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
                      <LaneMeter throughput={throughput} />
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
              style={{ left: i * LANE_WIDTH + LANE_WIDTH / 2 }}
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
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function LaneMeter({ throughput }: { throughput: LaneThroughput }) {
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
  return (
    <Tooltip
      side="bottom"
      align="end"
      wide
      content={
        <div className="space-y-2 min-w-[260px]">
          <div className="flex items-center gap-2">
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
              part types
            </span>
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700">
              opencode sdk
            </span>
            <button
              onClick={() => onChange('all')}
              className={clsx(
                'ml-auto font-mono text-micro uppercase tracking-wider transition',
                partFilter === 'all' ? 'text-molten' : 'text-fog-600 hover:text-fog-200',
              )}
            >
              show all
            </button>
          </div>
          <ul className="space-y-1">
            {partOrder.map((p) => {
              const selected = partFilter === p;
              const count = counts.get(p) ?? 0;
              if (count === 0) return null;
              return (
                <li key={p}>
                  <button
                    onClick={() => onChange(selected ? 'all' : p)}
                    className={clsx(
                      'w-full flex items-center gap-2 h-6 px-2 rounded transition',
                      selected ? 'bg-ink-700' : 'hover:bg-ink-800',
                    )}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: partHex[p] }}
                    />
                    <span
                      className="font-mono text-micro uppercase tracking-wider shrink-0"
                      style={{ color: partHex[p] }}
                    >
                      {partMeta[p].label}
                    </span>
                    <span className="font-mono text-[10.5px] text-fog-600 truncate">
                      {partMeta[p].blurb}
                    </span>
                    <span className="ml-auto font-mono text-[10.5px] text-fog-600 tabular-nums shrink-0">
                      {count}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="hairline-t pt-1 font-mono text-[10.5px] text-fog-600 opacity-20">
            click a row to isolate that part type
          </div>
        </div>
      }
    >
      <button
        className={clsx(
          'flex items-center gap-1.5 h-6 px-2 rounded hairline transition',
          active ? 'border-molten/30 bg-molten/5' : 'bg-ink-900 hover:border-ink-500',
        )}
      >
        <div className="flex items-center gap-[3px]">
          {partOrder.slice(0, 5).map((p) => (
            <span
              key={p}
              className={clsx(
                'w-1.5 h-1.5 rounded-full transition',
                !active || partFilter === p ? 'opacity-100' : 'opacity-25',
              )}
              style={{ backgroundColor: partHex[p] }}
            />
          ))}
        </div>
        <span
          className={clsx(
            'font-mono text-micro uppercase tracking-wider',
            active ? 'text-molten' : 'text-fog-400',
          )}
        >
          {active ? partMeta[partFilter as PartType].label : 'parts'}
        </span>
      </button>
    </Tooltip>
  );
}

// ToolName export retained for consumers that reference the type indirectly.
export type { ToolName };
