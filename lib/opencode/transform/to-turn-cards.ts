//
// Card-view projection — one card per (user prompt → assistant reply) pair.
// Unlike toLiveTurns (patch-gated), this preserves every turn including the
// analysis / read-only ones where no files were touched. Used by the
// turn-cards view as a complementary projection to the event-level timeline.

import type { OpencodeMessage, OpencodePart } from '../types';

export interface TurnCard {
  id: string;                   // assistant messageID
  sessionID: string;            // source session — matters for multi-session runs
  agent: string;                // assistant agent name (from info.agent)
  modelID?: string;             // opencode model id, e.g. 'big-pickle'
  providerID?: string;          // opencode provider id, e.g. 'opencode' or 'zen'
  userPrompt?: string;          // full user-prompt text (may be undefined for auto-dispatched turns)
  assistantText?: string;       // concatenated assistant text parts
  reasoningText?: string;       // concatenated reasoning parts, if any
  tools: Array<{                // every tool call made during this turn
    id: string;
    name: string;
    state: 'pending' | 'running' | 'completed' | 'error';
    summary?: string;           // tool-specific one-liner (filepath, command, etc.)
  }>;
  filesTouched: string[];       // dedup'd from any patch parts in the turn
  startedMs: number;            // info.time.created
  completedMs?: number;         // info.time.completed — undefined for still-running turns
  status: 'success' | 'in_progress' | 'failure' | 'aborted';
  tokens?: number;              // info.tokens.total
  cost?: number;                // info.cost
}

interface PartWithState {
  type: string;
  tool?: string;
  state?: unknown;
  id?: string;
  [key: string]: unknown;
}

function toolStateOf(p: PartWithState): TurnCard['tools'][number]['state'] {
  const s = p.state;
  if (!s) return 'pending';
  if (typeof s === 'object' && s !== null) {
    const status = (s as { status?: string }).status;
    if (status === 'pending' || status === 'running' || status === 'completed' || status === 'error') {
      return status;
    }
  }
  return 'pending';
}

function toolSummaryOf(p: PartWithState): string | undefined {
  const input = (p.state as { input?: Record<string, unknown> } | undefined)?.input;
  if (!input) return undefined;
  // Tool-specific hints — pick the most useful single field per tool.
  const pick = (key: string): string | undefined => {
    const v = input[key];
    return typeof v === 'string' && v ? v : undefined;
  };
  switch (p.tool) {
    case 'read':
    case 'write':
    case 'edit':
      return pick('filePath');
    case 'bash':
      return pick('command');
    case 'grep':
    case 'glob':
      return pick('pattern');
    case 'task':
      return pick('description') ?? pick('prompt');
    case 'webfetch':
      return pick('url');
    case 'todowrite':
      return undefined; // todos surface elsewhere; no point repeating here
    default: {
      // Best-effort fallback — pick the first string value.
      for (const v of Object.values(input)) {
        if (typeof v === 'string' && v) return v;
      }
      return undefined;
    }
  }
}

export function toTurnCards(messages: OpencodeMessage[]): TurnCard[] {
  // One card per user prompt (per session). Opencode splits an assistant
  // turn across multiple messages — e.g. msg_1 (tool:read), msg_2
  // (tool:todowrite), msg_3 (wrap-up text) — each with its own assistant
  // record. A card aggregates all of those step-messages under the single
  // user prompt that triggered them, so `tools` is the full set of
  // tool calls the assistant made in response to that prompt.
  //
  // Per-session open-card map — a new user prompt in session S finalizes
  // the prior open card for S and starts a fresh one, while assistant
  // messages merge into whichever card is currently open on their session.
  // This mirrors toMessages' per-session user→assistant routing.
  const cards: TurnCard[] = [];
  const open = new Map<string, TurnCard>();

  const finalizeStatus = (card: TurnCard) => {
    // Aggregate status: any error wins, else any running wins, else success.
    if (card.status !== 'in_progress' && card.status !== 'success') return;
    // Leave 'in_progress' alone — only callers that see completedMs set it
    // to 'success'. 'failure' / 'aborted' are set at merge time below.
  };

  for (const m of messages) {
    const sessionID = m.info.sessionID;
    if (m.info.role === 'user') {
      // Flush the previous card for this session, if any.
      const prev = open.get(sessionID);
      if (prev) {
        finalizeStatus(prev);
        cards.push(prev);
      }
      // Start a new card for this prompt.
      const parts = m.parts.filter((p): p is Extract<OpencodePart, { type: 'text' }> => p.type === 'text');
      const joined = parts.map((p) => p.text).join('\n').trim();
      open.set(sessionID, {
        id: m.info.id,
        sessionID,
        agent: 'assistant',
        userPrompt: joined || undefined,
        assistantText: undefined,
        reasoningText: undefined,
        tools: [],
        filesTouched: [],
        startedMs: m.info.time.created,
        completedMs: undefined,
        status: 'in_progress',
      });
      continue;
    }
    if (m.info.role !== 'assistant') continue;

    const textParts = m.parts.filter((p): p is Extract<OpencodePart, { type: 'text' }> => p.type === 'text');
    const reasoningParts = m.parts.filter(
      (p): p is Extract<OpencodePart, { type: 'reasoning' }> => p.type === 'reasoning',
    );
    const toolParts = m.parts.filter(
      (p): p is Extract<OpencodePart, { type: 'tool' }> => p.type === 'tool',
    );
    const patchParts = m.parts.filter(
      (p): p is Extract<OpencodePart, { type: 'patch' }> => p.type === 'patch',
    );

    const stepText = textParts.map((p) => p.text).join('\n').trim();
    const stepReasoning = reasoningParts.map((p) => p.text).join('\n').trim();
    const stepTools: TurnCard['tools'] = toolParts.map((p) => {
      const asRec = p as unknown as PartWithState;
      return {
        id: p.id,
        name: p.tool ?? 'unknown',
        state: toolStateOf(asRec),
        summary: toolSummaryOf(asRec),
      };
    });
    const stepFiles = patchParts.flatMap((p) => p.files);

    // Merge into the open card for this session. If none exists (e.g. an
    // assistant message arrived before any user prompt in the stream —
    // possible for child-session task spawns that we catch mid-flow),
    // start a card with no userPrompt so the step's work still surfaces.
    let card = open.get(sessionID);
    if (!card) {
      card = {
        id: m.info.id,
        sessionID,
        agent: m.info.agent ?? 'assistant',
        userPrompt: undefined,
        assistantText: undefined,
        reasoningText: undefined,
        tools: [],
        filesTouched: [],
        startedMs: m.info.time.created,
        completedMs: undefined,
        status: 'in_progress',
      };
      open.set(sessionID, card);
    }

    // Identity metadata from the most-recent step.
    card.agent = m.info.agent ?? card.agent;
    card.modelID = m.info.modelID ?? card.modelID;
    card.providerID = m.info.providerID ?? card.providerID;

    if (stepText) {
      card.assistantText = card.assistantText ? `${card.assistantText}\n\n${stepText}` : stepText;
    }
    if (stepReasoning) {
      card.reasoningText = card.reasoningText
        ? `${card.reasoningText}\n\n${stepReasoning}`
        : stepReasoning;
    }
    if (stepTools.length) card.tools.push(...stepTools);
    if (stepFiles.length) {
      const seen = new Set(card.filesTouched);
      for (const f of stepFiles) if (!seen.has(f)) card.filesTouched.push(f);
    }

    // Token + cost aggregate across steps under one prompt.
    if (m.info.tokens?.total != null) {
      card.tokens = (card.tokens ?? 0) + m.info.tokens.total;
    }
    if (m.info.cost != null) {
      card.cost = (card.cost ?? 0) + m.info.cost;
    }

    // Status: error and aborted are sticky; otherwise track latest.
    if (m.info.error?.name === 'MessageAbortedError') card.status = 'aborted';
    else if (m.info.error && card.status !== 'aborted') card.status = 'failure';
    else if (card.status !== 'failure' && card.status !== 'aborted') {
      card.status = m.info.time.completed ? 'success' : 'in_progress';
    }

    // Track completion — last completed step's timestamp defines the
    // card's end. Leaving it undefined keeps 'in_progress' status visible.
    if (m.info.time.completed) card.completedMs = m.info.time.completed;
  }

  // Flush every remaining open card. A run that's still live leaves cards
  // with status='in_progress' and no completedMs — the view handles both.
  for (const card of open.values()) {
    finalizeStatus(card);
    cards.push(card);
  }

  // Chronological sort by prompt start time. Messages arrive sorted by
  // info.time.created already, but belt-and-suspenders this so callers
  // that pass an unsorted array still get a linear timebar.
  cards.sort((a, b) => a.startedMs - b.startedMs);

  return cards;
}
