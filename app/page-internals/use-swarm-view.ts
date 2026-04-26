// HARDENING_PLAN.md#C6 + #E8 — page.tsx decomposition.
//
// SwarmView is the consolidated render contract: nine derived shapes
// (agents, agentOrder, messages, runMeta, providerSummary, runPlan,
// liveTurns, turnCards, fileHeat) computed from one input — the live
// session messages — by routing through the transform pipeline.
//
// Pre-extraction this lived inline at app/page.tsx as a 55-line useMemo
// covering two branches (multi-session merge vs single-session) plus a
// zero-state EMPTY_VIEW. Eight transformers were called separately,
// recomputed on every render that crossed the dep array. Pulling it into
// a hook keeps the same one-pass-per-input shape and surfaces the
// contract: caller hands in (isMultiSession, slots, meta, sessionId,
// liveData) and gets back the full SwarmView shape.
//
// EMPTY_VIEW is exported because timeline rendering paths that handle
// "no run active" still need a referentially-stable empty shape — the
// page passes it down through several level of props.

import { useMemo } from 'react';

import {
  toAgents,
  toMessages,
  toRunMeta,
  toRunPlan,
  toProviderSummary,
  toLiveTurns,
  toTurnCards,
  toFileHeat,
  type LiveTurn,
  type TurnCard,
  type FileHeat,
} from '@/lib/opencode/transform';
import type { LiveSessionSnapshot, LiveSwarmRunMessagesSnapshot } from '@/lib/opencode/live';
import type { Agent, AgentMessage, RunMeta, ProviderSummary, TodoItem } from '@/lib/swarm-types';
import type { SwarmRunMeta } from '@/lib/swarm-run-types';

export interface SwarmView {
  agents: Agent[];
  agentOrder: string[];
  messages: AgentMessage[];
  runMeta: RunMeta;
  providerSummary: ProviderSummary[];
  runPlan: TodoItem[];
  liveTurns: LiveTurn[];
  turnCards: TurnCard[];
  fileHeat: FileHeat[];
}

// Zero-state view for "no run active" — topbar chips render as 0/placeholder,
// all live-data panels collapse to their empty states. Budget defaults match
// the routing-modal defaults so the topbar chip doesn't read 0/0.
export const EMPTY_SWARM_VIEW: SwarmView = {
  agents: [],
  agentOrder: [],
  messages: [],
  runMeta: {
    id: '',
    title: '',
    status: 'paused',
    started: '',
    elapsed: '—',
    totalTokens: 0,
    totalCost: 0,
    budgetCap: 5,
    cwd: '',
  },
  providerSummary: [],
  runPlan: [],
  liveTurns: [],
  turnCards: [],
  fileHeat: [],
};

interface UseSwarmViewArgs {
  isMultiSession: boolean;
  liveSwarmRun: Pick<LiveSwarmRunMessagesSnapshot, 'slots'>;
  swarmRunMeta: SwarmRunMeta | null;
  sessionId: string | null;
  liveData: LiveSessionSnapshot | null;
}

export function useSwarmView({
  isMultiSession,
  liveSwarmRun,
  swarmRunMeta,
  sessionId,
  liveData,
}: UseSwarmViewArgs): SwarmView {
  return useMemo(() => {
    // Council / multi-session: merge every slot's messages into a single
    // chronological stream, then feed the transform pipeline. toAgents and
    // toMessages are session-aware (S4 rekey), so merging is safe — IDs
    // stay disambiguated by sessionID and user→assistant routing resolves
    // per-session rather than cross-session. The primary slot's session is
    // the anchor for runMeta; workspace / title are identical across
    // council members by construction.
    if (isMultiSession && liveSwarmRun.slots.length > 0) {
      const merged = liveSwarmRun.slots
        .flatMap((s) => s.messages)
        .slice()
        .sort((a, b) => a.info.time.created - b.info.time.created);
      const anchorSession = liveSwarmRun.slots[0]?.session ?? null;
      const { agents, agentOrder } = toAgents(merged);
      const baseMeta = toRunMeta(anchorSession, merged);
      // For multi-session runs the primary member's opencode title carries
      // the `#1` member suffix we added at spawn time (swarm/run/route.ts).
      // Users reading the topbar want the run-level title, not "foo #1" —
      // so overlay meta.title (the seed title) and swarmRunID so the anchor
      // reads as a run identity rather than a stray member.
      return {
        agents,
        agentOrder,
        messages: toMessages(merged),
        runMeta: {
          ...baseMeta,
          id: swarmRunMeta?.swarmRunID ?? baseMeta.id,
          title: swarmRunMeta?.title ?? baseMeta.title,
        },
        providerSummary: toProviderSummary(agents, merged),
        runPlan: toRunPlan(merged),
        liveTurns: toLiveTurns(merged),
        turnCards: toTurnCards(merged),
        fileHeat: toFileHeat(merged),
      };
    }
    if (sessionId && liveData) {
      const { agents, agentOrder } = toAgents(liveData.messages);
      const messages = toMessages(liveData.messages);
      return {
        agents,
        agentOrder,
        messages,
        runMeta: toRunMeta(liveData.session, liveData.messages),
        providerSummary: toProviderSummary(agents, liveData.messages),
        runPlan: toRunPlan(liveData.messages),
        liveTurns: toLiveTurns(liveData.messages),
        turnCards: toTurnCards(liveData.messages),
        fileHeat: toFileHeat(liveData.messages),
      };
    }
    return EMPTY_SWARM_VIEW;
  }, [isMultiSession, liveSwarmRun.slots, swarmRunMeta, sessionId, liveData]);
}
