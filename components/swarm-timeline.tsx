'use client';

import clsx from 'clsx';
import { useMemo, useRef, useState } from 'react';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import type { Agent, AgentMessage, PartType, TodoItem, ToolName } from '@/lib/swarm-types';
import { IconSearch } from './icons';
import { ProviderBadge } from './provider-badge';
import { Tooltip } from './ui/tooltip';
import { Popover } from './ui/popover';
import { ScrollToBottomButton } from './ui/scroll-to-bottom';
import { TimelineFlow, TIMELINE_GUTTER_WIDTH } from './timeline-flow';
import { LaneMeter, PartLegend } from './swarm-timeline/sub-views';
import {
  TimelineInteractionProvider,
  type TimelineInteractionValue,
} from './swarm-timeline/interaction-context';
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
  roleNames,
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
  // Per-pattern role labels keyed by `ownerIdForSession` (matches
  // agent.id shape). When set, each lane header shows the role chip
  // (planner / worker-N / orchestrator / judge / member-N / mapper-N /
  // synthesizer / critic) instead of the provider name. Empty map →
  // falls back to provider chip. See lib/blackboard/roles.ts:
  // roleNamesFromMeta for the per-pattern derivation.
  roleNames?: ReadonlyMap<string, string>;
}) {
  const [query, setQuery] = useState('');
  // Multi-select part filter (2026-04-24): empty Set means "all parts
  // visible", otherwise only the selected parts pass the filter.
  // Migrated from `PartType | 'all'` so users can isolate (e.g.)
  // text + reasoning + tool simultaneously without round-tripping
  // through the dropdown.
  //
  // The single-choice quick-filter preset that lived alongside this
  // (with its own popover trigger labeled "filter") was removed
  // 2026-04-26 (#175) — it duplicated the parts toggle for every
  // category that mattered (tool / reasoning / patch / subtask) and
  // the unique outliers (delegate, errors) were rarely used. Search
  // covers tool-name lookup; errored parts already render with a
  // visible accent in the timeline.
  const [partFilter, setPartFilter] = useState<Set<PartType>>(() => new Set());
  const { clockSec } = usePlayback();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // onFocus / onSelectAgent / roleNames were drilled 4-5 levels deep
  // through TimelineFlow → EventCard/ChipCard → TimelineNodeCard. The
  // provider hangs them off the subtree so consumers read via hook.
  // Stable identity via useMemo so subtree memoization isn't busted
  // every render.
  const interactionValue: TimelineInteractionValue = useMemo(
    () => ({
      onFocus,
      onSelectAgent,
      roleNames: roleNames ?? new Map(),
    }),
    [onFocus, onSelectAgent, roleNames],
  );
  // When the dev backend has been unreachable long enough, the lane
  // status circles should stop pulsing — their "live" animation is
  // stale data after the SSE feed drops. See useBackendStale docs.
  const backendStale = useBackendStale();
  // Stick-to-bottom: extracted to `useStickToBottom` 2026-04-24
  // (lib/use-stick-to-bottom.ts) so every panel can share the same
  // state-machine + first-render multi-pass snap. This component
  // just calls the hook with its scroll container ref + a content
  // signal that changes on each new message.

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
        if (partFilter.size > 0 && !partFilter.has(m.part)) return false;
        if (phaseFor(m, clockSec) === 'hidden') return false;
        if (!query) return true;
        const hay = `${m.title} ${m.body ?? ''} ${m.toolSubtitle ?? ''}`.toLowerCase();
        return hay.includes(query.toLowerCase());
      }),
    [messages, partFilter, query, clockSec],
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
  // Natural width: gutter + one lane's worth per agent. Don't floor this
  // (was previously Math.max(_, 800) — that overflowed narrow viewports
  // at the empty state where totalWidth degenerates to gutter-only).
  // The parent scroll container handles wide-canvas cases via overflow-auto.
  const totalWidth = TIMELINE_GUTTER_WIDTH + agentOrder.length * LANE_WIDTH;

  // Stick-to-bottom: shared `useStickToBottom` hook governs both the
  // first-render multi-pass snap and the at-bottom-state follow-on
  // behavior. Content signal is `messages.length + ":" + totalHeight`
  // so both new messages AND row-height settling trigger the effect.
  useStickToBottom(scrollRef, `${messages.length}:${totalHeight}`);

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
            width: totalWidth,
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
                        {/* Role chip 2026-04-24: shows the session's role
                            in the run (planner / worker-N / judge /
                            generator-N / critic / orchestrator / member-N /
                            mapper-N / synthesizer) when the pattern
                            assigns one. Falls back to the provider name
                            for `none` pattern or unmapped sessions. The
                            full provider label still lives in the lane's
                            hover tooltip above (line 362).

                            Bugfix 2026-04-24 evening: roleNames is keyed
                            by `ownerIdForSession(sid)` = `ag_ses_<sid8>`
                            (the coordinator's owner-id convention), but
                            `a.id` is `ag_<agentName>_<sid8>` (the
                            display-id convention from agentIdFor). The
                            two never matched. We derive the owner-id
                            inline from `a.sessionID` to bridge them. */}
                        {(() => {
                          const ownerId = a.sessionID
                            ? `ag_ses_${a.sessionID.slice(-8)}`
                            : '';
                          const role = roleNames?.get(ownerId);
                          if (role) {
                            return (
                              <span
                                className={clsx(
                                  'shrink-0 inline-flex items-center h-4 px-1.5 rounded-sm',
                                  'font-mono text-[9.5px] uppercase tracking-widest2 hairline',
                                  accentText[a.accent],
                                  'bg-ink-900/70',
                                )}
                                title={`role: ${role} · model: ${a.model.label} (${a.model.provider})`}
                              >
                                {role}
                              </span>
                            );
                          }
                          return <ProviderBadge provider={a.model.provider} size="sm" clickable />;
                        })()}
                      </div>
                      <LaneMeter
                        throughput={throughput}
                        tokens={a.tokensUsed}
                        tokensIn={a.tokensIn}
                        tokensOut={a.tokensOut}
                        cost={a.costUsed}
                      />
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
              width: totalWidth,
              height: totalHeight,
            }}
          >
            <TimelineInteractionProvider value={interactionValue}>
              <TimelineFlow
                agents={agents}
                agentOrder={agentOrder}
                agentIndex={agentIndex}
                agentMap={agentMap}
                rows={rows}
                rowHeights={rowHeights}
                allMessages={messages}
                focusedId={focusedId}
                onClearFocus={onClearFocus}
                selectedAgentId={selectedAgentId}
                clockSec={clockSec}
                totalWidth={totalWidth}
                totalHeight={totalHeight}
                scrollRef={scrollRef}
                scrollMargin={HEADER_HEIGHT + TOP_PAD}
                todoByTaskMessageId={todoByTaskMessageId}
                onJumpToTodo={onJumpToTodo}
              />
            </TimelineInteractionProvider>
          </div>
        </div>
      </div>
      <ScrollToBottomButton scrollRef={scrollRef} />
    </section>
  );
}

// LaneMeter + PartLegend extracted to ./swarm-timeline/sub-views.tsx
// 2026-04-28 — pure renders, no internal timeline state. Re-imported
// at the top so the existing `<LaneMeter ... />` / `<PartLegend ... />`
// JSX call sites stay unchanged.

// ToolName export retained for consumers that reference the type indirectly.
export type { ToolName };
