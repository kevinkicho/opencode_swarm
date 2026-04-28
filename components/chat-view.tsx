'use client';

// Chat-bubble view — chronological per-agent stream that reads like
// Slack/ChatGPT instead of the timeline's cross-lane diagram. One bubble
// per AgentMessage; tool calls fold into compact chip rows; A2A messages
// (where toAgentIds includes someone other than the sender) render with
// a quoted "to:" header so the addressed-to channel is visible.
//
// Why this view exists: the timeline's strength is showing inter-agent
// coordination as wires. The cost is cognitive — for a user who just
// wants "what did the agents say to each other in chronological order",
// the timeline forces them to follow lane geography. ChatView is the
// flat reading view: scroll top-down, each bubble shows author + part
// type + content, no spatial layout to track. Complementary, not a
// replacement (timeline still wins for "who connected to whom").
//
// Decisions:
//   - Chronological global order (not per-agent columns like cards view)
//   - Bubble color matches agent.accent — consistent with timeline lanes
//   - Tool calls collapse to a single chip row per turn-block (consecutive
//     tool calls from the same author) so they don't dominate the view
//   - A2A signaled by a "to: <agent>" header line on bubbles where
//     toAgentIds contains someone other than the sender

import clsx from 'clsx';
import { useMemo } from 'react';
import type { AgentMessage, Agent } from '@/lib/swarm-types';
import { partMeta, toolMeta } from '@/lib/part-taxonomy';
import { compact } from '@/lib/format';

const accentText: Record<Agent['accent'], string> = {
  molten: 'text-molten',
  mint: 'text-mint',
  iris: 'text-iris',
  amber: 'text-amber',
  fog: 'text-fog-400',
};
const accentBorder: Record<Agent['accent'], string> = {
  molten: 'border-molten/40',
  mint: 'border-mint/40',
  iris: 'border-iris/40',
  amber: 'border-amber/40',
  fog: 'border-fog-700',
};

export function ChatView({
  messages,
  agents,
  focusedId,
  onFocus,
}: {
  messages: AgentMessage[];
  agents: Agent[];
  focusedId: string | null;
  onFocus: (id: string) => void;
}) {
  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  // Group messages into "blocks": consecutive tool calls from the same
  // author collapse into one chip row instead of N bubbles. Text and
  // reasoning parts each get their own bubble.
  const blocks = useMemo(() => {
    type Block =
      | { kind: 'bubble'; msg: AgentMessage }
      | { kind: 'tools'; author: string; msgs: AgentMessage[] };
    const out: Block[] = [];
    for (const msg of messages) {
      if (msg.part === 'tool') {
        const last = out[out.length - 1];
        if (last && last.kind === 'tools' && last.author === msg.fromAgentId) {
          last.msgs.push(msg);
          continue;
        }
        out.push({ kind: 'tools', author: msg.fromAgentId, msgs: [msg] });
      } else {
        out.push({ kind: 'bubble', msg });
      }
    }
    return out;
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="font-mono text-[11px] uppercase tracking-widest2 text-fog-700">
          no messages yet
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
      {blocks.map((block, idx) => {
        if (block.kind === 'tools') {
          const author = agentMap.get(block.author);
          const accent = author?.accent ?? 'fog';
          return (
            <div
              key={`tools-${idx}`}
              className="flex items-center gap-2 pl-2"
            >
              <span
                className={clsx(
                  'font-mono text-[10px] uppercase tracking-widest2 shrink-0 w-32 truncate',
                  accentText[accent],
                )}
              >
                {author?.name ?? 'agent'}
              </span>
              <div className="flex-1 flex items-center gap-1 flex-wrap">
                {block.msgs.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => onFocus(m.id)}
                    title={m.toolPreview ?? m.body ?? m.title}
                    className={clsx(
                      'inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] tabular-nums hairline transition',
                      m.id === focusedId
                        ? 'bg-ink-800 border-fog-500'
                        : 'bg-ink-900/40 border-ink-700 hover:bg-ink-800/70',
                      m.toolState === 'error' && 'border-rust/60',
                      m.toolState === 'running' && 'border-mint/40 animate-pulse',
                    )}
                  >
                    <span
                      className="w-1 h-1 rounded-full shrink-0"
                      style={{ backgroundColor: m.toolName ? toolMeta[m.toolName].hex : '#5a6473' }}
                    />
                    <span className="text-fog-300 truncate max-w-[140px]">
                      {m.toolName ?? 'tool'}
                    </span>
                    {m.toolSubtitle && (
                      <span className="text-fog-600 truncate max-w-[100px]">
                        {m.toolSubtitle}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          );
        }
        const { msg } = block;
        const author = agentMap.get(msg.fromAgentId);
        const accent = author?.accent ?? 'fog';
        const isFromHuman = msg.fromAgentId === 'human';
        // A2A: addressed to someone other than the sender.
        const a2a = msg.toAgentIds.find((to) => to !== msg.fromAgentId);
        const a2aTo = a2a ? agentMap.get(a2a)?.name ?? a2a : null;
        const focused = msg.id === focusedId;
        return (
          <button
            key={msg.id}
            onClick={() => onFocus(msg.id)}
            className={clsx(
              'block w-full text-left rounded-md hairline px-3 py-2 transition',
              focused
                ? 'bg-ink-800 border-fog-500'
                : isFromHuman
                  ? 'bg-ink-900/30 border-ink-700 hover:bg-ink-800/40'
                  : clsx('bg-ink-900/40 hover:bg-ink-800/60', accentBorder[accent]),
            )}
          >
            <div className="flex items-baseline gap-2 mb-1">
              <span
                className={clsx(
                  'font-mono text-[10.5px] uppercase tracking-widest2 shrink-0',
                  isFromHuman ? 'text-fog-500' : accentText[accent],
                )}
              >
                {isFromHuman ? 'you' : (author?.name ?? 'agent')}
              </span>
              <span className="font-mono text-[9.5px] uppercase tracking-wider text-fog-700 shrink-0">
                {partMeta[msg.part].label}
              </span>
              {a2aTo && (
                <span className="font-mono text-[9.5px] text-fog-600 shrink-0">
                  → {a2aTo}
                </span>
              )}
              <span className="ml-auto font-mono text-[9.5px] text-fog-700 tabular-nums shrink-0">
                {msg.timestamp}
              </span>
              {msg.tokens != null && (
                <span className="font-mono text-[9.5px] text-fog-600 tabular-nums shrink-0">
                  {compact(msg.tokens)}
                </span>
              )}
            </div>
            <div className="text-[12.5px] text-fog-200 leading-relaxed whitespace-pre-wrap break-words">
              {msg.body ?? msg.title}
            </div>
          </button>
        );
      })}
    </div>
  );
}
