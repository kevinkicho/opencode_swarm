//
// Per-part flattening of opencode messages → AgentMessage[]. The output
// is what the timeline renders: one entry per message-part, with
// fromAgent/toAgent routing, normalized tool state, and an aborted-turn
// synthetic strip that mirrors opencode's "Interrupted" UI cue.

import type { AgentMessage } from '../../swarm-types';
import type { OpencodeMessage, OpencodeTokenUsage } from '../types';
import {
  agentIdFor,
  bodyOf,
  derivedCost,
  fmtDuration,
  fmtTs,
  isHumanAgentId,
  isInterruptedTool,
  normalizePart,
  normalizeTool,
  previewOf,
  synthesizeTitle,
  toolStateFrom,
} from './_shared';

export function toMessages(messages: OpencodeMessage[]): AgentMessage[] {
  if (messages.length === 0) return [];
  const anchor = messages[0].info.time.created;
  const out: AgentMessage[] = [];

  // Per-session user→assistant routing. A flat `lastAssistant` pointer would
  // cross-route under council: session B's user prompt would land on session
  // A's assistant whenever A spoke most recently in the merged timeline.
  // Instead, track the latest assistant *per session* so a user message only
  // routes to its own session's agent. The prefill with each session's first
  // assistant preserves single-session behavior where a user prompt that
  // arrives before any assistant reply still points at the (soon-to-speak)
  // assistant rather than back at the human.
  const firstAssistantBySession = new Map<string, string>();
  for (const m of messages) {
    if (m.info.role !== 'assistant') continue;
    if (firstAssistantBySession.has(m.info.sessionID)) continue;
    firstAssistantBySession.set(
      m.info.sessionID,
      agentIdFor(m.info.agent, 'assistant', m.info.sessionID),
    );
  }
  const latestAssistantBySession = new Map<string, string>(firstAssistantBySession);

  for (const m of messages) {
    const role = m.info.role;
    const fromAgentId =
      role === 'user'
        ? 'human'
        : agentIdFor(m.info.agent, 'assistant', m.info.sessionID);
    if (role === 'assistant') latestAssistantBySession.set(m.info.sessionID, fromAgentId);
    const sessionAssistant = latestAssistantBySession.get(m.info.sessionID);
    const toAgentIds =
      role === 'user'
        ? sessionAssistant
          ? [sessionAssistant]
          : ['human']
        : ['human'];

    for (const part of m.parts) {
      const tMs = (part as { time?: { start: number; end?: number } }).time?.start ?? m.info.time.created;
      const partType = normalizePart(part.type);
      const toolName = part.type === 'tool' ? normalizeTool(part.tool) : undefined;
      const toolState = part.type === 'tool' ? toolStateFrom(part.state) : undefined;
      const interrupted = part.type === 'tool' && isInterruptedTool(part.state);
      const status: AgentMessage['status'] =
        interrupted ? 'abandoned'
        : toolState === 'error' ? 'error'
        : toolState === 'pending' || toolState === 'running' ? 'running'
        : 'complete';

      const partTokens: number | undefined =
        part.type === 'step-finish'
          ? (part.tokens as OpencodeTokenUsage | undefined)?.total
          : undefined;

      // Tokens + cost surface at the message level in opencode's data
      // model — m.info.tokens / m.info.cost are aggregates for the whole
      // assistant turn, not per-part. Only `step-finish` parts carry a
      // separate `tokens` field (mid-turn checkpoint). Surface the
      // message-level aggregate on every part so clicking any chip in
      // the inspector shows the message's totals (the user's mental
      // model — "what did this turn cost?"); fall back to step-finish's
      // partial total when message-level isn't set yet (mid-stream).
      const tokensForPart = m.info.tokens?.total ?? partTokens;
      const costForPart =
        typeof m.info.cost === 'number' ? m.info.cost : derivedCost(m.info);

      out.push({
        id: part.id,
        fromAgentId: isHumanAgentId(fromAgentId) ? 'human' : fromAgentId,
        toAgentIds,
        part: partType,
        toolName,
        toolState,
        title: synthesizeTitle(part),
        body: bodyOf(part),
        toolPreview: previewOf(part),
        timestamp: fmtTs(tMs, anchor),
        tsMs: tMs,
        duration: fmtDuration(
          (part as { time?: { start: number; end?: number } }).time?.start,
          (part as { time?: { start: number; end?: number } }).time?.end,
        ),
        tokens: tokensForPart,
        cost: costForPart > 0 ? costForPart : undefined,
        status,
        threadId: m.info.id,
      });
    }

    // Mirror opencode's "Interrupted" strip: when the assistant turn is tagged
    // with MessageAbortedError, emit a synthetic row so the timeline shows
    // where the user cancelled.
    if (role === 'assistant' && m.info.error?.name === 'MessageAbortedError') {
      const completedMs = m.info.time.completed ?? m.info.time.created;
      const msg = (m.info.error.data?.message as string | undefined) ?? 'turn cancelled by user';
      out.push({
        id: `${m.info.id}_interrupted`,
        fromAgentId: isHumanAgentId(fromAgentId) ? 'human' : fromAgentId,
        toAgentIds,
        part: 'text',
        title: 'interrupted',
        body: msg,
        timestamp: fmtTs(completedMs, anchor),
        tsMs: completedMs,
        status: 'abandoned',
        threadId: m.info.id,
      });
    }
  }

  // Global chronological sort by part wall time. Without this, multi-session
  // runs interleave out of order: a tool part that fired late in session A's
  // message (time.start = T+15) can land above session B's earlier part
  // (time.start = T+10) because the parent-message sort key is
  // info.time.created, not the per-part time.start. JS Array.sort is stable
  // since ES2019, so parts sharing the same tsMs preserve their emitted
  // order within a single message.
  out.sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));

  return out;
}
