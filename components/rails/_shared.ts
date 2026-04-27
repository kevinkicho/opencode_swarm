//
// Pre-fix: `turnText`, `countLines`, `compactNum` were copy-pasted
// character-identical across council-rail, debate-rail, iterations-rail,
// map-rail, phases-rail, contracts-rail. Every new pattern rail started
// with another copy. Drift risk: a fix in one site silently failed to
// apply to the other 5+.
//
// `wrap()` is intentionally NOT shared — each rail's wrapper builds a
// pattern-specific status pill / header layout, so the name collision
// the call-graph flagged is a false positive at the implementation level.

import type { OpencodeMessage } from '@/lib/opencode/types';

// Concatenate every text-like part of an assistant message into one
// string. `text` and `reasoning` parts are both treated as content;
// tool/patch/step parts are ignored (they have their own surfaces).
export function turnText(m: OpencodeMessage): string {
  let out = '';
  for (const p of m.parts) {
    if (p.type === 'text' || p.type === 'reasoning') {
      out += (p as { text?: string }).text ?? '';
    }
  }
  return out;
}

// Newline count, treating empty string as zero (split would give 1).
export function countLines(s: string): number {
  if (!s) return 0;
  return s.split('\n').length;
}

// Compact number formatter — 999 → '999', 1000 → '1.0k', 10500 → '11k',
// 1_500_000 → '1.5M'. Used for token / line counters in rail row meta
// strips. Map-rail had a strict-superset version that included the M
// branch; lifting that here so it's the canonical formatter.
export function compactNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
