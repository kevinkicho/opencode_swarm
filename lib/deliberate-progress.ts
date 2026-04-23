// Client-side round inference for the deliberate-execute pattern's
// deliberation phase. The pattern's phase state isn't persisted
// server-side (STATUS.md known-limitation); this helper reads the
// observable signal — assistant text turns per session — and derives
// a round number that's "close enough" to drive the board empty-state
// round counter.
//
// Logic: during deliberation, every session produces one completed
// text turn per round (Round 1 responds to the initial directive,
// Round 2 to the peer-embedded revise prompt, etc.). The min count
// across sessions is the round everyone has at least started; the max
// is the round the fastest session has reached. We surface the MIN
// because that matches the "round N is complete when everyone has
// replied" semantics of runCouncilRounds.

import type { Agent, AgentMessage } from './swarm-types';
import type { SwarmRunMeta } from './swarm-run-types';

// Mirror of DEFAULT_DELIBERATION_ROUNDS in lib/server/deliberate-execute.ts.
// Kept in sync by convention — there's no shared import path because the
// server module uses server-only deps; duplicating the 3 here is cheap.
export const DEFAULT_DELIBERATION_ROUNDS = 3;

export interface DeliberationProgress {
  round: number; // 1..maxRounds; 0 if no one has replied yet
  maxRounds: number;
  // True when every session has completed at least `round` replies.
  // Signals "round N deliberation is done" vs. "round N in flight."
  allSessionsReached: boolean;
}

export function deliberationRoundInfo(
  meta: SwarmRunMeta | null | undefined,
  agents: Agent[],
  messages: AgentMessage[],
): DeliberationProgress | null {
  if (!meta || meta.pattern !== 'deliberate-execute') return null;

  // Count completed text turns per session. Only agents that correspond
  // to actual meta.sessionIDs contribute — ignores sub-agents spawned
  // via the task tool, whose role in deliberation is invisible.
  const sessionSet = new Set(meta.sessionIDs);
  const countBySession = new Map<string, number>();
  for (const sid of sessionSet) countBySession.set(sid, 0);

  const agentBySID = new Map<string, Agent>();
  for (const a of agents) {
    if (a.sessionID && sessionSet.has(a.sessionID)) {
      agentBySID.set(a.sessionID, a);
    }
  }

  // An agent may appear on multiple sessions' messages via subtask. We
  // only count text turns attributed to the primary agent of each
  // tracked session.
  const agentIdToSession = new Map<string, string>();
  for (const [sid, a] of agentBySID) agentIdToSession.set(a.id, sid);

  for (const m of messages) {
    if (m.part !== 'text') continue;
    if (m.status !== 'complete') continue;
    const sid = agentIdToSession.get(m.fromAgentId);
    if (!sid) continue;
    countBySession.set(sid, (countBySession.get(sid) ?? 0) + 1);
  }

  const counts = [...countBySession.values()];
  if (counts.length === 0) return null;

  const minReplies = Math.min(...counts);
  const maxReplies = Math.max(...counts);
  const maxRounds = DEFAULT_DELIBERATION_ROUNDS;

  // round = 1-indexed count of fully-completed rounds. If everyone has
  // replied N times, round N is "complete." If some have replied N+1
  // but at least one is stuck at N, we're IN round N+1.
  const round = Math.min(maxReplies, maxRounds);
  const allSessionsReached = minReplies >= round;

  return { round, maxRounds, allSessionsReached };
}
