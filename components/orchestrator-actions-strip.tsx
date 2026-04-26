'use client';

// Orchestrator suggested-actions strip for the orchestrator-worker
// pattern. Sits above the composer on orchestrator-worker runs;
// renders a compact button row that posts canned prompts to the
// orchestrator session (session 0).
//
// The orchestrator is a persistent reasoning surface for the mission —
// users can just type into the composer to nudge it, but common nudges
// (status report, re-strategize, focus check) are reachable without
// having to compose prose. Buttons post to session 0 with NO `agent`
// field — opencode silently drops POSTs whose agent isn't one of its
// built-ins (build/compaction/explore/general/plan/summary/title), and
// 'orchestrator' is our role label, not an opencode agent. Without
// the agent field opencode uses the session's default, which is what
// we want anyway. See reference_opencode_agent_silent_drop.md.
//
// Rendering contract: returns null when pattern !== 'orchestrator-worker'
// OR when the orchestrator hasn't produced any completed turn yet
// (prevents firing actions before the initial plan has landed).

import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { roleNamesBySessionID } from '@/lib/blackboard/roles';
import type { Agent, AgentMessage } from '@/lib/swarm-types';
import type { SwarmRunMeta } from '@/lib/swarm-run-types';

export const ORCHESTRATOR_ACTIONS: ReadonlyArray<{
  id: string;
  label: string;
  hint: string;
  prompt: string;
}> = [
  {
    id: 'status',
    label: 'status report',
    hint: 'ask the orchestrator what the team has done + what is next',
    prompt: [
      'Give me a brief status update for this run:',
      '- What has the team accomplished so far?',
      '- What is currently in flight?',
      '- What are you watching or blocking on?',
      '- What is the next chunk of work you are scheduling?',
      '',
      'Keep it concise — one paragraph, not a wall of text.',
    ].join('\n'),
  },
  {
    id: 'restrategize',
    label: 're-strategize',
    hint: 'look at progress so far and consider pivoting the plan',
    prompt: [
      'Re-strategize now. The team has completed some work; more is',
      'in flight. Examine the board state (done, open, in-progress)',
      'and the mission, then decide whether we keep pursuing the',
      'current direction or pivot.',
      '',
      'If the current direction is good: no-op — confirm with one line.',
      'If we should pivot or re-prioritize: call todowrite with an',
      'updated todo list that reflects the new plan. The workers will',
      'pick up whatever you schedule next.',
    ].join('\n'),
  },
  {
    id: 'focus',
    label: 'focus check',
    hint: 'ask the orchestrator which 1-2 todos are highest leverage',
    prompt: [
      'Focus check: of the open and in-progress todos on the board,',
      'which 1-2 are the highest-leverage for the mission right now?',
      'Briefly explain why. No todowrite — just name them.',
    ].join('\n'),
  },
];

export function OrchestratorActionsStrip({
  agents,
  messages,
  meta,
  onAction,
}: {
  agents: Agent[];
  messages: AgentMessage[];
  meta: SwarmRunMeta | null;
  // Fires with the canned prompt for the chosen action. Callers route
  // the POST to the orchestrator's sessionID without an `agent` field
  // (opencode would silently drop the post otherwise — see file header).
  // The component stays HTTP-agnostic.
  onAction: (actionID: string, prompt: string) => Promise<void> | void;
}) {
  const [pending, setPending] = useState<string | null>(null);

  const visible = useMemo(() => {
    if (!meta || meta.pattern !== 'orchestrator-worker') return false;
    const roleBySID = roleNamesBySessionID(meta);
    const orchestratorAgent = agents.find(
      (a) => a.sessionID && roleBySID.get(a.sessionID) === 'orchestrator',
    );
    if (!orchestratorAgent) return false;
    // Only surface actions after the orchestrator has produced at
    // least one completed text turn — firing a "status report" before
    // the initial plan has landed would race the planner sweep.
    return messages.some(
      (m) =>
        m.fromAgentId === orchestratorAgent.id &&
        m.part === 'text' &&
        m.status === 'complete',
    );
  }, [agents, messages, meta]);

  if (!visible) return null;

  const handleClick = async (
    actionID: string,
    prompt: string,
  ): Promise<void> => {
    if (pending) return;
    setPending(actionID);
    try {
      await onAction(actionID, prompt);
    } finally {
      // Brief cooldown after a click so rapid double-clicks don't
      // double-fire. Short enough to feel responsive, long enough to
      // visibly acknowledge the click.
      setTimeout(() => setPending(null), 700);
    }
  };

  return (
    <div className="mx-4 mt-2 px-3 h-7 rounded hairline bg-ink-900/40 flex items-center gap-2">
      <span className="font-mono text-micro uppercase tracking-widest2 text-rust shrink-0">
        orchestrator
      </span>
      <span className="font-mono text-[10px] text-fog-700 shrink-0">
        nudge →
      </span>
      <div className="flex items-center gap-1 flex-wrap">
        {ORCHESTRATOR_ACTIONS.map((a) => {
          const isPending = pending === a.id;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => handleClick(a.id, a.prompt)}
              disabled={pending !== null}
              title={a.hint}
              className={clsx(
                'h-5 px-2 rounded font-mono text-[9.5px] uppercase tracking-widest2 border transition shrink-0',
                isPending
                  ? 'bg-rust/15 text-rust border-rust/30'
                  : pending !== null
                    ? 'bg-ink-900 text-fog-700 border-ink-800 cursor-not-allowed'
                    : 'bg-ink-900 text-fog-400 border-ink-700 hover:text-rust hover:border-rust/30',
              )}
            >
              {isPending ? `${a.label}…` : a.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
