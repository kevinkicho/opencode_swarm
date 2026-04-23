'use client';

// Critic verdict strip for the critic-loop pattern. Sits above the
// composer when the run is critic-loop; parses the critic session's
// latest text reply and renders the verdict as a colored strip +
// the current iteration counter (N of M).
//
// Two verdict shapes (same parser as lib/server/critic-loop.ts —
// duplicated here so this component stays client-safe):
//   - APPROVED: <reason>   → mint (loop concluded)
//   - REVISE: <feedback>   → amber (loop continuing)
//   - anything else (unclear) → fog (the orchestrator will treat as
//     revise-with-full-text; strip shows the raw first line)
//
// Rendering contract: returns null when conditions aren't met.

import clsx from 'clsx';
import { useMemo } from 'react';
import { roleNamesBySessionID } from '@/lib/blackboard/roles';
import type { Agent, AgentMessage } from '@/lib/swarm-types';
import type { SwarmRunMeta } from '@/lib/swarm-run-types';

type Verdict =
  | { kind: 'approved'; body: string; accent: 'mint' }
  | { kind: 'revise'; body: string; accent: 'amber' }
  | { kind: 'unclear'; body: string; accent: 'fog' };

function classify(text: string): Verdict {
  const first = text.split('\n', 1)[0]?.trim() ?? '';
  if (/^approved\b/i.test(first)) {
    return { kind: 'approved', body: first, accent: 'mint' };
  }
  if (/^revise\b/i.test(first)) {
    const stripped = text.replace(/^\s*revise[:\s]*/i, '').trim();
    return { kind: 'revise', body: stripped, accent: 'amber' };
  }
  return { kind: 'unclear', body: text.trim(), accent: 'fog' };
}

const BG: Record<Verdict['accent'], string> = {
  mint: 'bg-mint/10 border-mint/30',
  amber: 'bg-amber/10 border-amber/30',
  fog: 'bg-ink-800/60 border-ink-700',
};
const TEXT: Record<Verdict['accent'], string> = {
  mint: 'text-mint',
  amber: 'text-amber',
  fog: 'text-fog-400',
};

export function CriticVerdictStrip({
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
  const state = useMemo(() => {
    if (!meta || meta.pattern !== 'critic-loop') return null;
    const roleBySID = roleNamesBySessionID(meta);
    const criticAgent = agents.find(
      (a) => a.sessionID && roleBySID.get(a.sessionID) === 'critic',
    );
    const workerAgent = agents.find(
      (a) => a.sessionID && roleBySID.get(a.sessionID) === 'worker',
    );
    if (!criticAgent) return null;

    // Iteration counter: worker completed text turns. The worker
    // produces a draft on round 1, revises on round 2, etc. Each
    // completed text turn is one round.
    const workerRounds = workerAgent
      ? messages.filter(
          (m) =>
            m.fromAgentId === workerAgent.id &&
            m.part === 'text' &&
            m.status === 'complete',
        ).length
      : 0;
    const maxIterations = meta.criticMaxIterations ?? 3;

    // Latest critic text verdict.
    let verdict: Verdict | null = null;
    let messageId: string | null = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.fromAgentId !== criticAgent.id) continue;
      if (m.part !== 'text') continue;
      if (m.status !== 'complete') continue;
      const body = m.body?.trim();
      if (!body) continue;
      verdict = classify(body);
      messageId = m.id;
      break;
    }
    if (!verdict) return null;
    return { verdict, messageId, workerRounds, maxIterations };
  }, [agents, messages, meta]);

  if (!state) return null;
  const { verdict: v, messageId, workerRounds, maxIterations } = state;
  const label =
    v.kind === 'approved'
      ? 'approved'
      : v.kind === 'revise'
        ? 'revise'
        : 'unclear';

  const headline = v.body.split('\n', 1)[0] ?? '';
  return (
    <button
      type="button"
      onClick={() => messageId && onFocus?.(messageId)}
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
        critic · {label}
      </span>
      <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600 tabular-nums shrink-0">
        round {Math.min(workerRounds, maxIterations)} of {maxIterations}
      </span>
      <span className="font-mono text-[11px] text-fog-200 truncate flex-1 min-w-0">
        {headline}
      </span>
      {v.kind === 'approved' && (
        <span className="font-mono text-[9px] uppercase tracking-widest2 text-mint shrink-0">
          loop done
        </span>
      )}
    </button>
  );
}
