'use client';

// Judge verdict strip for the debate-judge pattern. Sits above the
// composer when the run is debate-judge; parses the judge session's
// latest text reply and renders the verdict as a colored strip.
//
// Three verdict shapes (same parser as lib/server/debate-judge.ts —
// duplicated here so this component stays client-safe):
//   - WINNER: <generator-N> — <reason>  → mint (debate concluded)
//   - MERGE: <synthesis of drafts>      → iris (debate concluded)
//   - REVISE: <feedback>                → amber (loop continuing)
//
// Rendering contract: returns null when conditions aren't met, so the
// caller can drop it unconditionally into the layout.

import clsx from 'clsx';
import { useMemo } from 'react';
import { roleNamesBySessionID } from '@/lib/blackboard/roles';
import type { Agent, AgentMessage } from '@/lib/swarm-types';
import type { SwarmRunMeta } from '@/lib/swarm-run-types';

type Verdict =
  | { kind: 'winner'; body: string; accent: 'mint' }
  | { kind: 'merge'; body: string; accent: 'iris' }
  | { kind: 'revise'; body: string; accent: 'amber' };

function classify(text: string): Verdict | null {
  const first = text.split('\n', 1)[0]?.trim() ?? '';
  if (/^winner\b/i.test(first)) {
    return { kind: 'winner', body: text.trim(), accent: 'mint' };
  }
  if (/^merge\b/i.test(first)) {
    return { kind: 'merge', body: text.trim(), accent: 'iris' };
  }
  if (/^revise\b/i.test(first)) {
    const stripped = text.replace(/^\s*revise[:\s]*/i, '').trim();
    return { kind: 'revise', body: stripped, accent: 'amber' };
  }
  return null;
}

// Tailwind-JIT-stable color maps. Dynamic `text-${accent}` interpolation
// would get purged.
const BG: Record<Verdict['accent'], string> = {
  mint: 'bg-mint/10 border-mint/30',
  iris: 'bg-iris/10 border-iris/30',
  amber: 'bg-amber/10 border-amber/30',
};
const TEXT: Record<Verdict['accent'], string> = {
  mint: 'text-mint',
  iris: 'text-iris',
  amber: 'text-amber',
};

export function JudgeVerdictStrip({
  agents,
  messages,
  meta,
  onFocus,
}: {
  agents: Agent[];
  messages: AgentMessage[];
  meta: SwarmRunMeta | null;
  onFocus?: (id: string) => void;
}) {
  const verdict = useMemo(() => {
    if (!meta || meta.pattern !== 'debate-judge') return null;
    const roleBySID = roleNamesBySessionID(meta);
    // Find the agent whose session is the judge.
    const judgeAgent = agents.find(
      (a) => a.sessionID && roleBySID.get(a.sessionID) === 'judge',
    );
    if (!judgeAgent) return null;
    // Latest completed text message from the judge — walk messages in
    // reverse so we don't scan the whole transcript.
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.fromAgentId !== judgeAgent.id) continue;
      if (m.part !== 'text') continue;
      if (m.status !== 'complete') continue;
      const body = m.body?.trim();
      if (!body) continue;
      const v = classify(body);
      if (v) return { verdict: v, messageId: m.id };
    }
    return null;
  }, [agents, messages, meta]);

  if (!verdict) return null;

  const { verdict: v, messageId } = verdict;
  const label =
    v.kind === 'winner' ? 'winner' : v.kind === 'merge' ? 'merge' : 'revise';
  // Keep strip height tight; body is truncated to a single line. Click
  // jumps the timeline to the judge's verdict message.
  const headline =
    v.kind === 'winner' || v.kind === 'merge'
      ? v.body.split('\n', 1)[0] ?? ''
      : v.body.split('\n', 1)[0] ?? '';
  return (
    <button
      type="button"
      onClick={() => onFocus?.(messageId)}
      className={clsx(
        'w-full mx-4 mt-2 px-3 h-7 rounded hairline flex items-center gap-2 transition hover:brightness-110 text-left',
        BG[v.accent],
      )}
      title={v.body}
    >
      <span
        className={clsx(
          'font-mono text-micro uppercase tracking-widest2 shrink-0',
          TEXT[v.accent],
        )}
      >
        judge · {label}
      </span>
      <span className="font-mono text-[11px] text-fog-200 truncate flex-1 min-w-0">
        {headline}
      </span>
      {v.kind !== 'revise' && (
        <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600 shrink-0">
          debate concluded
        </span>
      )}
    </button>
  );
}
