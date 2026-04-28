// Pure parser + classifier for the debate rail.
//
// Lifted from debate-rail.tsx 2026-04-28. No React, no DOM —
// parses the judge's verdict tag (WINNER:N / MERGE / REVISE),
// classifies slots into judge + generators, and the diff summary
// shared with map/council rails.

import type { LiveSwarmSessionSlot } from '@/lib/opencode/live';

export interface RoundCell {
  // Length in lines of the generator's proposal that round; null when
  // the generator hasn't produced anything yet for that round.
  lines: number | null;
  // For round ≥ 2, a diff signal vs prior round. null on R1 / no prior.
  diff: string | null;
  status: 'pending' | 'drafting' | 'completed' | 'errored';
}

export interface RoundRow {
  round: number; // 1-indexed
  generators: RoundCell[];
  judge: {
    verdict: 'winner' | 'merge' | 'revise' | 'pending' | 'unknown';
    target: number | null; // for WINNER:N — which generator index (0-based)
    text: string | null; // first ~80 chars of judge text after the keyword
    completed: boolean;
  };
  status: 'pending' | 'deliberating' | 'done';
}

export function diffSummary(prev: string, next: string): string {
  if (!prev && !next) return '';
  const prevSet = new Set(prev.split('\n').map((l) => l.trim()).filter(Boolean));
  const nextSet = new Set(next.split('\n').map((l) => l.trim()).filter(Boolean));
  let added = 0;
  let removed = 0;
  for (const l of nextSet) if (!prevSet.has(l)) added += 1;
  for (const l of prevSet) if (!nextSet.has(l)) removed += 1;
  if (added === 0 && removed === 0) return 'no change';
  return `+${added} / -${removed}`;
}

// Parse judge verdict + target from review text. Convention from
// buildJudgePrompt: WINNER:<N> / MERGE:<text> / REVISE:<feedback>.
// Lenient on case + colon-vs-space.
export function parseVerdict(text: string): {
  verdict: 'winner' | 'merge' | 'revise' | 'unknown';
  target: number | null;
  body: string;
} {
  if (!text) return { verdict: 'unknown', target: null, body: '' };
  const trimmed = text.trimStart();
  const head = trimmed.slice(0, 40).toUpperCase();
  if (head.startsWith('WINNER')) {
    const m = /^WINNER\s*[:\s]\s*(\d+)/i.exec(trimmed);
    const target = m ? parseInt(m[1] ?? '0', 10) - 1 : null; // user-facing 1-indexed → 0-indexed
    return {
      verdict: 'winner',
      target,
      body: trimmed.replace(/^WINNER\s*[:\s]\s*\d+\s*/i, '').slice(0, 80),
    };
  }
  if (head.startsWith('MERGE')) {
    return {
      verdict: 'merge',
      target: null,
      body: trimmed.replace(/^MERGE\s*[:\s]\s*/i, '').slice(0, 80),
    };
  }
  if (head.startsWith('REVISE')) {
    return {
      verdict: 'revise',
      target: null,
      body: trimmed.replace(/^REVISE\s*[:\s]\s*/i, '').slice(0, 80),
    };
  }
  return { verdict: 'unknown', target: null, body: trimmed.slice(0, 80) };
}

// Identify judge + generators from slots. judge has agent='judge';
// generators have 'generator-N' or just 'generator'. Falls back to
// slot-order: slot[0]=judge, slot[1..]=generators.
export function classifySlots(slots: LiveSwarmSessionSlot[]): {
  judge: LiveSwarmSessionSlot | null;
  generators: LiveSwarmSessionSlot[];
} {
  let judge: LiveSwarmSessionSlot | null = null;
  const generators: LiveSwarmSessionSlot[] = [];
  for (const s of slots) {
    const firstAssist = s.messages.find((m) => m.info.role === 'assistant');
    const agent = firstAssist?.info.agent ?? '';
    if (agent === 'judge') judge = judge ?? s;
    else if (agent.startsWith('generator')) generators.push(s);
  }
  // Fallback: slot order.
  if (!judge && slots.length > 0) judge = slots[0];
  if (generators.length === 0 && slots.length > 1) {
    for (let i = 1; i < slots.length; i += 1) generators.push(slots[i]);
  }
  return { judge, generators };
}
