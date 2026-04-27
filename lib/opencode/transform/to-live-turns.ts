//
// One entry per assistant turn that committed file edits. The diff viewer
// uses this to build the turn list. `files` comes from the patch part, which
// is authoritative for which files this specific turn touched. Diff *text*
// has to be sliced from the session-aggregate response (see filterDiffsForTurn
// in ./diffs.ts).

import type { OpencodeMessage, OpencodePart } from '../types';
import { fmtClock, firstLine } from './_shared';

export interface LiveTurn {
  id: string;         // messageID of the assistant turn
  sha: string;        // short patch hash — stands in for a git sha in the UI
  title: string;      // first-line of the user prompt that triggered this turn
  summary?: string;   // first-line of the assistant text response, when present
  timestamp: string;  // "HH:MM" local time of turn completion
  agent: string;      // assistant agent name
  status: 'success' | 'in_progress' | 'failure';
  files: string[];    // files this turn touched — from patch.files
  tokens?: number;
  cost?: number;
}

export function toLiveTurns(messages: OpencodeMessage[]): LiveTurn[] {
  const turns: LiveTurn[] = [];
  // Walk messages in pairs — the user prompt that preceded an assistant turn
  // becomes the turn's title, since that's what the human asked for.
  let lastUserText: string | undefined;

  for (const m of messages) {
    if (m.info.role === 'user') {
      const text = firstTextPart(m.parts);
      if (text) lastUserText = text;
      continue;
    }
    if (m.info.role !== 'assistant') continue;

    const patches = m.parts.filter((p): p is Extract<OpencodePart, { type: 'patch' }> => p.type === 'patch');
    if (patches.length === 0) continue;

    const files = Array.from(new Set(patches.flatMap((p) => p.files)));
    const hash = patches[patches.length - 1].hash;
    const responseText = firstTextPart(m.parts);

    const completedMs = m.info.time.completed ?? m.info.time.created;
    const status: LiveTurn['status'] = m.info.error
      ? 'failure'
      : m.info.time.completed
        ? 'success'
        : 'in_progress';

    turns.push({
      id: m.info.id,
      sha: hash.slice(0, 7),
      title: lastUserText ?? responseText ?? 'turn',
      summary: responseText !== lastUserText ? responseText : undefined,
      timestamp: fmtClock(completedMs),
      agent: m.info.agent ?? 'assistant',
      status,
      files,
      tokens: m.info.tokens?.total,
      cost: m.info.cost,
    });
  }

  return turns;
}

function firstTextPart(parts: OpencodePart[]): string | undefined {
  for (const p of parts) {
    if (p.type === 'text' && p.text.trim()) return firstLine(p.text, 120);
  }
  return undefined;
}
