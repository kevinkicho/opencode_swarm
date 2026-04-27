//
// Roster projection — derives Agent[] (one row per assistant identity in
// the run) plus an agentOrder array preserving first-appearance order.
// Identity = (agent-config name, sessionID), via agentIdFor in _shared.
// Status (idle / thinking / working / error) is layered in here from the
// trailing message + tool-state; `waiting` (pending permission) is added
// by callers that hold the permissions state.

import type { Agent } from '../../swarm-types';
import type { OpencodeMessage, OpencodePart } from '../types';
import { priceFor } from '../pricing';
import {
  ACCENT_ROTATION,
  agentIdFor,
  derivedCost,
  familyOf,
  normalizeTool,
  providerOf,
  toolStateFrom,
} from './_shared';

export function toAgents(messages: OpencodeMessage[]): {
  agents: Agent[];
  agentOrder: string[];
} {
  const byId = new Map<string, Agent>();
  const order: string[] = [];

  messages.forEach((m, idx) => {
    if (m.info.role !== 'assistant') return;
    const id = agentIdFor(m.info.agent, 'assistant', m.info.sessionID);
    const existing = byId.get(id);
    const tokens = m.info.tokens?.total ?? 0;
    // Per-direction breakdown for LaneMeter cumulative-fallback. opencode's
    // info.tokens.input is "raw" input tokens; .cache.{read,write} are
    // additional input-side accounting. Sum them for "in"; .output is the
    // model's generation. .reasoning isn't surfaced separately — folded
    // into output for the cumulative purpose.
    const t = m.info.tokens;
    const tokensIn = t ? t.input + t.cache.read + t.cache.write : 0;
    const tokensOut = t ? t.output : 0;
    const cost = derivedCost(m.info);

    if (!existing) {
      order.push(id);
      const price = priceFor(m.info.modelID);
      byId.set(id, {
        id,
        sessionID: m.info.sessionID,
        name: m.info.agent ?? 'assistant',
        model: {
          id: m.info.modelID ?? 'unknown',
          label: m.info.modelID?.split('/').pop() ?? 'unknown',
          provider: providerOf(m.info.providerID),
          family: familyOf(m.info.modelID),
          pricing: price ? { input: price.input, output: price.output } : undefined,
        },
        status: 'idle',
        focus: m.info.mode,
        tokensUsed: tokens,
        tokensIn,
        tokensOut,
        // Placeholder — PageInner overrides via runBudgetCap / pricing (see
        // withTokenBudget in app/page.tsx). Left non-zero so roster ratios
        // don't divide by zero in the mock-data / no-bounds case.
        tokensBudget: 80_000,
        costUsed: cost,
        messagesSent: 1,
        messagesRecv: 0,
        accent: ACCENT_ROTATION[order.length % ACCENT_ROTATION.length],
        glyph: (m.info.agent ?? 'A').charAt(0).toUpperCase(),
        tools: [],
      });
    } else {
      existing.tokensUsed += tokens;
      existing.tokensIn += tokensIn;
      existing.tokensOut += tokensOut;
      existing.costUsed += cost;
      existing.messagesSent += 1;
    }

    // infer tools used
    const agent = byId.get(id)!;
    for (const part of m.parts) {
      if (part.type === 'tool') {
        const t = normalizeTool(part.tool);
        if (t && !agent.tools.includes(t)) agent.tools.push(t);
      }
    }
    // silence unused-var warning — `idx` was only ever used for the
    // separate latestMsgIdxByAgent loop below.
    void idx;
  });

  // Status derivation: walk each agent back to their latest assistant message
  // and classify. `waiting` (pending permission) is layered in by callers that
  // hold the permissions state — toAgents only sees messages.
  const latestMsgIdxByAgent = new Map<string, number>();
  messages.forEach((m, idx) => {
    if (m.info.role !== 'assistant') return;
    latestMsgIdxByAgent.set(
      agentIdFor(m.info.agent, 'assistant', m.info.sessionID),
      idx,
    );
  });
  const overallLastIdx = messages.length - 1;

  for (const [id, msgIdx] of latestMsgIdxByAgent) {
    const agent = byId.get(id);
    if (!agent) continue;
    const last = messages[msgIdx];

    // error trumps all: opencode writes `info.error` on any abnormal turn end
    // (including user-triggered aborts, which are `MessageAbortedError`).
    if (last.info.error) {
      agent.status = 'error';
      continue;
    }

    // someone else spoke after this agent → this agent is just idle
    if (msgIdx !== overallLastIdx) {
      agent.status = 'idle';
      continue;
    }

    // this agent is the session's latest speaker. Distinguish in-progress
    // from completed by whether the info has a completion timestamp.
    const completed = !!last.info.time.completed;
    if (completed) {
      agent.status = 'idle';
      continue;
    }

    // ongoing turn — look at the trailing parts to tell `working` (a tool is
    // executing) from `thinking` (reasoning / no active tool).
    const trailingTool = [...last.parts]
      .reverse()
      .find((p) => p.type === 'tool') as
      | (OpencodePart & { type: 'tool' })
      | undefined;
    const trailingToolState = trailingTool ? toolStateFrom(trailingTool.state) : undefined;
    if (trailingToolState === 'running' || trailingToolState === 'pending') {
      agent.status = 'working';
    } else {
      agent.status = 'thinking';
    }
  }

  // Name-collision disambiguation. Council members all share one opencode
  // agent-config, so `m.info.agent` is identical across N sessions (e.g.
  // every member is named "build"). With sessionID-keyed IDs the roster
  // rows are already distinct, but the display names would still collide.
  // Suffix each colliding row with ` #N` in first-appearance order so the
  // roster / routing modal can tell members apart at a glance. Singletons
  // are untouched so pattern='none' output stays identical to before.
  const nameGroups = new Map<string, string[]>();
  for (const id of order) {
    const agent = byId.get(id);
    if (!agent) continue;
    const group = nameGroups.get(agent.name);
    if (group) group.push(id);
    else nameGroups.set(agent.name, [id]);
  }
  for (const [, ids] of nameGroups) {
    if (ids.length <= 1) continue;
    ids.forEach((id, i) => {
      const agent = byId.get(id);
      if (agent) agent.name = `${agent.name} #${i + 1}`;
    });
  }

  return { agents: Array.from(byId.values()), agentOrder: order };
}
