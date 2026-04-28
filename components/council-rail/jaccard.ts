// Pure tokenization + jaccard + tone helpers for the council rail.
//
// Lifted from council-rail.tsx 2026-04-28. No React, no DOM —
// implemented inline rather than calling out to a backend so the
// rail is self-contained; if we later promote the metric to the
// server (for I1 auto-stop) we swap the call site without touching
// the render path.

export interface MemberDraft {
  // Length in lines (cheap scan-density signal).
  lines: number;
  // Per-round per-member draft text, kept for the convergence compute.
  // Not rendered directly — the body is in the inspector drawer if the
  // user clicks.
  text: string;
  // For round ≥2: diff vs prior round of same member. Null otherwise.
  diffVsPrior: string | null;
  status: 'pending' | 'drafting' | 'completed' | 'errored';
  // Token-jaccard between this member's draft in this round and their
  // own draft in the prior round. Null on R1 or when either side is
  // missing. >0.85 = stayed put; 0.5–0.85 = evolved; <0.5 = position
  // shift. The convergence metric tracks council-wide consensus; this
  // tracks each member's individual movement, which is a different
  // signal — a member can shift sharply while the council still
  // converges (everyone met in the middle).
  selfJaccard: number | null;
}

export interface RoundRow {
  round: number; // 1-indexed
  members: MemberDraft[];
  // 0..1, null when <2 drafts are completed for this round.
  convergence: number | null;
  status: 'pending' | 'in-progress' | 'done';
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

// Cheap tokenizer — lowercase, split on non-word, drop stopwords.
// Deterministic + fast enough for the max-few-hundred-lines-per-draft
// scale we expect. Full-text embedding would be overkill here.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that',
  'it', 'its', 'as', 'by', 'at', 'from', 'but', 'if', 'not', 'we',
  'you', 'i', 'they', 'our', 'your', 'their', 'his', 'her',
]);

export function tokenize(text: string): Set<string> {
  if (!text) return new Set();
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

// Pairwise token-jaccard between two tokenized drafts. Used by I2 for
// per-member persistence (a vs same member's prior round). Distinct
// from aggregateJaccard's pairwise mean — that's a council-wide
// consensus metric, this is a per-member trajectory.
export function pairJaccard(a: Set<string>, b: Set<string>): number | null {
  if (a.size === 0 && b.size === 0) return null;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect += 1;
  const union = a.size + b.size - intersect;
  if (union === 0) return null;
  return intersect / union;
}

// Jaccard similarity across a set of tokenized drafts. Returns mean of
// pairwise jaccards — captures "how similar is the council as a whole"
// rather than any one pair. Symmetric + order-invariant. Range [0, 1].
export function aggregateJaccard(sets: Set<string>[]): number | null {
  if (sets.length < 2) return null;
  let totalPairs = 0;
  let sum = 0;
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const a = sets[i];
      const b = sets[j];
      if (a.size === 0 && b.size === 0) continue;
      let intersect = 0;
      for (const t of a) if (b.has(t)) intersect += 1;
      const union = a.size + b.size - intersect;
      if (union === 0) continue;
      sum += intersect / union;
      totalPairs += 1;
    }
  }
  return totalPairs > 0 ? sum / totalPairs : null;
}

export function convergenceTone(value: number | null): 'mint' | 'amber' | 'rust' | 'fog' {
  if (value === null) return 'fog';
  if (value >= 0.8) return 'mint';
  if (value >= 0.5) return 'amber';
  return 'rust';
}

export function convergenceLabel(value: number | null): string {
  if (value === null) return '—';
  if (value >= 0.8) return 'high';
  if (value >= 0.5) return 'med';
  return 'low';
}

// Three buckets matched to the convergence chip's tone palette so
// the eye groups them intuitively: stable = mint (no movement),
// evolved = fog-muted (some refinement), shifted = amber (strong
// repositioning). Null cases (R1 / pending) get fog and an empty glyph.
export type StanceBucket = 'stable' | 'evolved' | 'shifted' | null;

export function stanceBucket(j: number | null): StanceBucket {
  if (j === null) return null;
  if (j >= 0.85) return 'stable';
  if (j >= 0.5) return 'evolved';
  return 'shifted';
}

export const STANCE_GLYPH: Record<NonNullable<StanceBucket>, string> = {
  stable: '=',
  evolved: '~',
  shifted: '↻',
};

export const STANCE_TONE: Record<NonNullable<StanceBucket>, string> = {
  stable: 'text-mint/70',
  evolved: 'text-fog-700',
  shifted: 'text-amber',
};
