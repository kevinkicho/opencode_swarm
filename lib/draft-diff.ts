// Line-level draft diff via LCS — used by critic-loop iterations rail
// (and any other surface that needs "how much changed between two text
// blobs"). Backs 
//
// The previous implementation in iterations-rail.tsx took a set
// symmetric difference of unique trimmed lines — fast, but it
// underreported when a draft kept all the same words but reordered
// them, and overreported on duplicate-line edits because the Set
// collapsed duplicates. Proper LCS catches both: counts duplicates,
// preserves order, and "unchanged" maps to the true longest common
// subsequence.
//
// Complexity is O(n × m) memory and time. For typical critic-loop
// drafts (a few hundred lines max) this is microseconds; for runaway
// drafts past a few thousand lines we cap each side at MAX_LINES so a
// pathological turn can't pin the renderer.

const MAX_LINES = 4000;

export interface DraftDiff {
  added: number;     // lines in `next` not in the LCS
  removed: number;   // lines in `prev` not in the LCS
  unchanged: number; // LCS length
}

export function computeDraftDiff(prev: string, next: string): DraftDiff {
  const a = splitTrimmedLines(prev);
  const b = splitTrimmedLines(next);
  if (a.length === 0 && b.length === 0) {
    return { added: 0, removed: 0, unchanged: 0 };
  }
  if (a.length === 0) return { added: b.length, removed: 0, unchanged: 0 };
  if (b.length === 0) return { added: 0, removed: a.length, unchanged: 0 };

  const lcs = lcsLength(a, b);
  return {
    added: b.length - lcs,
    removed: a.length - lcs,
    unchanged: lcs,
  };
}

// Convenience: a one-line summary string for the iterations-tab key
// column. Returns the same `+N / -M` format the rail used to render so
// callers can drop in directly.
export function summariseDiff(d: DraftDiff): string {
  if (d.added === 0 && d.removed === 0 && d.unchanged === 0) return '';
  if (d.added === 0 && d.removed === 0) return 'no change';
  return `+${d.added} / -${d.removed}`;
}

function splitTrimmedLines(s: string): string[] {
  if (!s) return [];
  const all = s.split('\n').map((l) => l.trim());
  // Drop empty leading/trailing runs but keep internal blank lines —
  // they're meaningful structure (paragraph breaks) inside drafts.
  let start = 0;
  let end = all.length;
  while (start < end && all[start] === '') start += 1;
  while (end > start && all[end - 1] === '') end -= 1;
  const trimmed = all.slice(start, end);
  if (trimmed.length <= MAX_LINES) return trimmed;
  // Pathologically long draft: keep head + tail so the LCS still
  // surfaces stable structure at the boundaries (which is where revise
  // changes typically land). The dropped middle counts as "unchanged"
  // by omission, which matches the user's intuition for these cases.
  const half = Math.floor(MAX_LINES / 2);
  return trimmed.slice(0, half).concat(trimmed.slice(trimmed.length - half));
}

function lcsLength(a: string[], b: string[]): number {
  // Two-row DP — we only need the previous row to compute the next,
  // so memory is O(min(n, m)) by always letting `b` be the shorter
  // axis. Saves a real array allocation when one side is much longer.
  let short = b;
  let long = a;
  if (a.length < b.length) {
    short = a;
    long = b;
  }
  const n = short.length;
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= long.length; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (long[i - 1] === short[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = curr[j - 1] >= prev[j] ? curr[j - 1] : prev[j];
      }
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[n];
}
