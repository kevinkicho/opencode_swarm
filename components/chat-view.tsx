'use client';

// Turn-grouped chat view — one card per assistant turn, one card per
// user prompt. Tool calls fold inline as clickable pills. Multi-session
// fan-outs (council, debate-judge, map-reduce) collapse the user's
// prompt to a single card with a `→ alice, bob, carol` recipient list
// instead of N near-identical user bubbles.
//
// 2026-04-28 rewrite. The pre-rewrite version emitted one bubble per
// AgentMessage, which meant a single council assistant turn (text +
// 3 tool calls + step-start + step-finish) showed as 6 visually-equal
// bubbles dominated by step plumbing. The user pushback was that the
// view didn't read like chat — it read like an event log. Six changes
// in this rewrite, each addresses one specific failure mode:
//
//   1. step-start/step-finish filtered out — pure plumbing, never
//      contributed reading value.
//   2. parts grouped by threadId (= opencode message-id) so one
//      assistant turn = one card.
//   3. tool / agent / subtask / patch parts render as inline pills
//      inside their parent assistant card (matching the cards-view
//      idiom) instead of as standalone rows.
//   4. user prompts that fan across sessions de-duplicate by body
//      within a 5s window; the canonical card lists all recipients.
//   5. each card has a 3px accent stripe in the agent's color + the
//      agent name as label, so multi-agent scrollback is parseable
//      without reading every name.
//   6. `space-y-3` between turns for visual breathing room.

import clsx from 'clsx';
import { useMemo } from 'react';
import type { AgentMessage, Agent, PartType } from '@/lib/swarm-types';
import { partMeta, toolMeta } from '@/lib/part-taxonomy';
import { compact } from '@/lib/format';

const accentText: Record<Agent['accent'], string> = {
  molten: 'text-molten',
  mint: 'text-mint',
  iris: 'text-iris',
  amber: 'text-amber',
  fog: 'text-fog-400',
};

const accentStripe: Record<Agent['accent'], string> = {
  molten: 'bg-molten',
  mint: 'bg-mint',
  iris: 'bg-iris',
  amber: 'bg-amber',
  fog: 'bg-fog-500',
};

// Parts that are turn-boundary plumbing rather than content. Filtering
// at the source means a 1-tool-call turn doesn't render as 3 bubbles
// (step-start + tool + step-finish).
const PLUMBING_PARTS = new Set<PartType>(['step-start', 'step-finish']);

// Parts that read as compact "tool-like" pills below the body text
// rather than as primary content. `agent` and `subtask` are A2A
// markers: the parent assistant's text/reasoning is what the reader
// scans first; these are status chips, same as tool calls.
const PILL_PARTS = new Set<PartType>(['tool', 'agent', 'subtask', 'patch']);

interface UserTurn {
  kind: 'user';
  key: string;
  body: string;
  timestamp: string;
  tsMs?: number;
  toAgents: string[];
}

interface AssistantTurn {
  kind: 'assistant';
  key: string;
  agentId: string;
  bodyParts: AgentMessage[];
  pillParts: AgentMessage[];
  timestamp: string;
  tsMs: number;
  totalTokens?: number;
  hasError: boolean;
}

type Turn = UserTurn | AssistantTurn;

// User-prompt fan window. Council/debate-judge/map-reduce dispatch
// the same prompt to N sessions in a tight loop; the typical batch
// lands in <1s. 5s is generous against latency without crossing into
// "different prompts at the same wall-clock minute."
const FAN_WINDOW_MS = 5_000;

export function ChatView({
  messages,
  agents,
  focusedId,
  onFocus,
  loading = false,
}: {
  messages: AgentMessage[];
  agents: Agent[];
  focusedId: string | null;
  onFocus: (id: string) => void;
  loading?: boolean;
}) {
  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  const turns = useMemo<Turn[]>(() => buildTurns(messages), [messages]);

  if (turns.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="font-mono text-[11px] uppercase tracking-widest2 text-fog-700 animate-pulse">
          {loading ? 'loading messages…' : 'no messages yet'}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
      {turns.map((turn) =>
        turn.kind === 'user' ? (
          <UserTurnCard key={turn.key} turn={turn} agentMap={agentMap} />
        ) : (
          <AssistantTurnCard
            key={turn.key}
            turn={turn}
            agent={agentMap.get(turn.agentId)}
            focusedId={focusedId}
            onFocus={onFocus}
          />
        ),
      )}
    </div>
  );
}

function buildTurns(messages: AgentMessage[]): Turn[] {
  const filtered = messages.filter((m) => !PLUMBING_PARTS.has(m.part));

  // Pass 1: group by threadId. mock fixtures occasionally lack
  // threadId — fall back to a per-row synthetic key so each part
  // becomes its own single-part turn (legacy behavior, but plumbing
  // already filtered).
  const turnsByKey = new Map<string, AgentMessage[]>();
  const order: string[] = [];
  filtered.forEach((m, i) => {
    const key = m.threadId ?? `_synthetic:${i}:${m.fromAgentId}`;
    const existing = turnsByKey.get(key);
    if (existing) {
      existing.push(m);
    } else {
      turnsByKey.set(key, [m]);
      order.push(key);
    }
  });

  // Pass 2: turn the grouped parts into typed Turn objects. Each turn's
  // tsMs is its earliest part's; that's the position the global ordering
  // will use.
  const built: Turn[] = order.map((key) => {
    const parts = turnsByKey.get(key)!;
    const first = parts[0];
    const earliestTs = parts.reduce(
      (acc, p) => (p.tsMs != null && p.tsMs < acc ? p.tsMs : acc),
      first.tsMs ?? Number.POSITIVE_INFINITY,
    );
    const tsMs = Number.isFinite(earliestTs) ? earliestTs : (first.tsMs ?? 0);

    if (first.fromAgentId === 'human') {
      const toAgents = first.toAgentIds.filter((t) => t !== 'human');
      // Concatenate body across parts; in practice user turns are
      // single-part, but be defensive against multi-part user turns
      // (e.g. attached file part adjacent to text).
      const body = parts.map((p) => p.body ?? p.title).join('\n').trim();
      return {
        kind: 'user',
        key,
        body,
        timestamp: first.timestamp,
        tsMs,
        toAgents,
      };
    }

    const bodyParts = parts.filter((p) => !PILL_PARTS.has(p.part));
    const pillParts = parts.filter((p) => PILL_PARTS.has(p.part));
    // tokens propagate from the message-level aggregate (set on every
    // part by to-messages.ts) — read the first non-null value.
    const totalTokens = parts.find((p) => p.tokens != null)?.tokens;
    const hasError = parts.some((p) => p.status === 'error');
    return {
      kind: 'assistant',
      key,
      agentId: first.fromAgentId,
      bodyParts,
      pillParts,
      timestamp: first.timestamp,
      tsMs,
      totalTokens,
      hasError,
    };
  });

  // Pass 3: dedup user prompts that fan across sessions. Same body
  // within FAN_WINDOW_MS collapse into the earliest, with the union
  // of recipients on the survivor.
  const dropped = new Set<string>();
  const userIndices: number[] = [];
  built.forEach((t, i) => {
    if (t.kind === 'user') userIndices.push(i);
  });
  for (let i = 0; i < userIndices.length; i++) {
    const idx = userIndices[i];
    const turn = built[idx] as UserTurn;
    if (dropped.has(turn.key)) continue;
    const merged = new Set(turn.toAgents);
    for (let j = i + 1; j < userIndices.length; j++) {
      const otherIdx = userIndices[j];
      const other = built[otherIdx] as UserTurn;
      if (dropped.has(other.key)) continue;
      if (other.body !== turn.body) continue;
      if (
        other.tsMs != null &&
        turn.tsMs != null &&
        Math.abs(other.tsMs - turn.tsMs) > FAN_WINDOW_MS
      ) {
        continue;
      }
      for (const r of other.toAgents) merged.add(r);
      dropped.add(other.key);
    }
    (built[idx] as UserTurn).toAgents = Array.from(merged);
  }

  return built.filter((t) => !dropped.has(t.key));
}

function UserTurnCard({
  turn,
  agentMap,
}: {
  turn: UserTurn;
  agentMap: Map<string, Agent>;
}) {
  const recipientNames = turn.toAgents.map((id) => agentMap.get(id)?.name ?? id);
  return (
    <div className="flex gap-3">
      <div className="w-[3px] shrink-0 rounded-sm bg-fog-700" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-1.5 flex-wrap">
          <span className="font-mono text-[10.5px] uppercase tracking-widest2 text-fog-500">
            you
          </span>
          {recipientNames.length > 0 && (
            <span className="font-mono text-[10px] text-fog-700">
              → {recipientNames.join(', ')}
            </span>
          )}
          <span className="ml-auto font-mono text-[10px] text-fog-700 tabular-nums">
            {turn.timestamp}
          </span>
        </div>
        <div className="font-mono text-[12.5px] text-fog-200 leading-relaxed whitespace-pre-wrap break-words max-h-[40vh] overflow-y-auto">
          {turn.body}
        </div>
      </div>
    </div>
  );
}

function AssistantTurnCard({
  turn,
  agent,
  focusedId,
  onFocus,
}: {
  turn: AssistantTurn;
  agent?: Agent;
  focusedId: string | null;
  onFocus: (id: string) => void;
}) {
  const accent = agent?.accent ?? 'fog';
  const focused =
    turn.bodyParts.some((p) => p.id === focusedId) ||
    turn.pillParts.some((p) => p.id === focusedId);
  return (
    <div
      className={clsx(
        'flex gap-3 transition-colors',
        focused && 'rounded-sm ring-1 ring-fog-500/40 bg-ink-900/30',
      )}
    >
      <div className={clsx('w-[3px] shrink-0 rounded-sm', accentStripe[accent])} />
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span
            className={clsx(
              'font-mono text-[10.5px] uppercase tracking-widest2',
              accentText[accent],
            )}
          >
            {agent?.name ?? 'agent'}
          </span>
          {turn.hasError && (
            <span className="font-mono text-[10px] uppercase tracking-widest2 text-rust">
              error
            </span>
          )}
          <span className="ml-auto font-mono text-[10px] text-fog-700 tabular-nums">
            {turn.timestamp}
          </span>
          {turn.totalTokens != null && turn.totalTokens > 0 && (
            <span className="font-mono text-[10px] text-fog-600 tabular-nums">
              {compact(turn.totalTokens)}
            </span>
          )}
        </div>

        {turn.bodyParts.length > 0 && (
          <div className="space-y-1.5">
            {turn.bodyParts.map((p) => {
              const isReasoning = p.part === 'reasoning';
              const isFocused = p.id === focusedId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onFocus(p.id)}
                  className={clsx(
                    'block text-left w-full rounded-sm transition cursor-pointer',
                    isFocused
                      ? '-mx-1 px-1 py-0.5 bg-ink-800'
                      : 'hover:bg-ink-900/40',
                  )}
                >
                  {isReasoning && (
                    <div className="font-mono text-[9.5px] uppercase tracking-widest2 text-iris/80 mb-0.5">
                      reasoning
                    </div>
                  )}
                  <div
                    className={clsx(
                      'font-mono leading-relaxed whitespace-pre-wrap break-words max-h-[40vh] overflow-y-auto',
                      isReasoning
                        ? 'text-[11.5px] text-fog-400 italic'
                        : 'text-[12.5px] text-fog-200',
                    )}
                  >
                    {p.body ?? p.title}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {turn.pillParts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 pt-0.5">
            {turn.pillParts.map((p) => (
              <ToolPill
                key={p.id}
                part={p}
                focused={p.id === focusedId}
                onClick={() => onFocus(p.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolPill({
  part,
  focused,
  onClick,
}: {
  part: AgentMessage;
  focused: boolean;
  onClick: () => void;
}) {
  const isToolPart = part.part === 'tool';
  const label = isToolPart ? (part.toolName ?? 'tool') : partMeta[part.part].label;
  const dotColor =
    isToolPart && part.toolName ? toolMeta[part.toolName].hex : '#5a6473';
  const errored = part.status === 'error' || part.toolState === 'error';
  const running = part.status === 'running' || part.toolState === 'running';
  return (
    <button
      type="button"
      onClick={onClick}
      title={part.toolPreview ?? part.toolSubtitle ?? part.body ?? part.title}
      className={clsx(
        'inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] hairline transition cursor-pointer shrink-0',
        focused
          ? 'bg-ink-800 border-fog-500'
          : 'bg-ink-900/40 border-ink-700 hover:bg-ink-800/70 hover:border-fog-700',
        errored && 'border-rust/60',
        running && 'border-mint/40 animate-pulse',
      )}
    >
      <span
        className="w-1 h-1 rounded-full shrink-0"
        style={{ backgroundColor: dotColor }}
      />
      <span className="text-fog-300 truncate max-w-[160px]">{label}</span>
      {part.toolSubtitle && (
        <span className="text-fog-600 truncate max-w-[140px]">
          {part.toolSubtitle}
        </span>
      )}
    </button>
  );
}
