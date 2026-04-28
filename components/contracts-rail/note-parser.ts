// Pure parsing + counting helpers for the contracts rail.
//
// Lifted from components/contracts-rail.tsx 2026-04-28. The rail's
// readability hinges on parsing the coordinator's stamped note tags
// ([retry:N], [cas-drift:<file>], [audit:<verdict>], …) into a
// strongly-typed shape that the row + header components can render
// without re-tokenizing per-row.
//
// All exports are pure — no React, no DOM. The TONE palette lives
// here because both the header Chip and ContractRow components need
// to share it; reusing it across the row + the chip keeps tones
// teaching the eye the same thing in both surfaces ("rust = action
// needed").

import type { BoardItem, BoardItemStatus } from '@/lib/blackboard/types';

// Per-row chip tone palette. Mint = good, rust = bad, amber = warning,
// fog = neutral / not applicable. Reused across columns so the eye
// learns "rust = action needed."
export const TONE = {
  mint: 'text-mint',
  rust: 'text-rust',
  amber: 'text-amber',
  iris: 'text-iris',
  fog: 'text-fog-700',
  fogActive: 'text-fog-300',
} as const;

// Note-tag parsers. The coordinator stamps these on item.note when it
// transitions a row through a verdict gate. Format conventions (live as
// of 2026-04-24, see lib/server/blackboard/{coordinator,auto-ticker}.ts):
//
//   [retry:N] reason          retryOrStale (coordinator.ts:199)
//   [final after N retries]   final-stale stamp (coordinator.ts:212)
//   [cas-drift:<file>]        commit-time CAS rejection (coordinator.ts:778)
//   [critic-rejected] reason  anti-busywork critic verdict (coordinator.ts:847)
//   [verifier-rejected] reason Playwright verifier failure (coordinator.ts:903)
//   [audit:<verdict>] reason  auditor stamp on criterion (auto-ticker.ts:906)
//
// Pass-verdicts don't write a note (silent good news), so absence of a
// rejection tag is itself a signal. Display rule: explicit pass for
// 'done' status; explicit verdict text only for the rejection paths.

export interface NoteSignals {
  retryCount: number;
  drift: string | null; // file path that drifted, when CAS triggered
  criticRejected: boolean;
  verifierRejected: boolean;
  auditVerdict: 'met' | 'unmet' | 'wont-do' | 'unclear' | null;
  finalAfterRetries: number | null; // stamp when the retry budget hit MAX
}

const RETRY_RE = /\[retry:(\d+)\]/;
const DRIFT_RE = /\[cas-drift:([^\]]+?)\]/;
const AUDIT_RE = /\[audit:([a-z-]+)\]/;
const FINAL_RE = /\[final after (\d+) retries?\]/;

export function parseNote(note: string | null | undefined): NoteSignals {
  if (!note) {
    return {
      retryCount: 0,
      drift: null,
      criticRejected: false,
      verifierRejected: false,
      auditVerdict: null,
      finalAfterRetries: null,
    };
  }
  const retryM = RETRY_RE.exec(note);
  const driftM = DRIFT_RE.exec(note);
  const auditM = AUDIT_RE.exec(note);
  const finalM = FINAL_RE.exec(note);
  const auditRaw = auditM ? auditM[1] : null;
  const auditVerdict =
    auditRaw === 'met' ||
    auditRaw === 'unmet' ||
    auditRaw === 'wont-do' ||
    auditRaw === 'unclear'
      ? auditRaw
      : null;
  return {
    retryCount: retryM ? parseInt(retryM[1] ?? '0', 10) : 0,
    drift: driftM ? driftM[1] : null,
    criticRejected: /\[critic-rejected\]/.test(note),
    verifierRejected: /\[verifier-rejected\]/.test(note),
    auditVerdict,
    finalAfterRetries: finalM ? parseInt(finalM[1] ?? '0', 10) : null,
  };
}

// Per-status sort priority. In-progress first (active work the user is
// most likely tracking), then open (with retry-desc tiebreak so stuck
// items rise), then stale, then done, then claimed/blocked at the
// bottom. Criterion items sort by verdict severity as a secondary key.
export const STATUS_RANK: Record<BoardItemStatus, number> = {
  'in-progress': 0,
  open: 1,
  stale: 2,
  blocked: 3,
  claimed: 4,
  done: 5,
};

export const VERDICT_RANK: Record<NonNullable<NoteSignals['auditVerdict']>, number> = {
  unmet: 0,
  unclear: 1,
  'wont-do': 2,
  met: 3,
};

// Aggregate counts for the sticky header chips. Walk the items once and
// derive every chip in a single pass — cheap because items are typically
// dozens, and explicit aggregation is easier to read than 5 separate
// filter().length calls.
export interface HeaderCounts {
  total: number;
  criteria: number;
  met: number;
  unmet: number;
  stale: number;
  busywork: number; // critic-rejected
  drift: number; // cas-drift
}

export function deriveCounts(items: BoardItem[]): HeaderCounts {
  let criteria = 0,
    met = 0,
    unmet = 0,
    stale = 0,
    busywork = 0,
    drift = 0;
  for (const it of items) {
    const s = parseNote(it.note);
    if (it.kind === 'criterion') {
      criteria += 1;
      if (s.auditVerdict === 'met') met += 1;
      else if (s.auditVerdict === 'unmet') unmet += 1;
    }
    if (it.status === 'stale') stale += 1;
    if (s.criticRejected) busywork += 1;
    if (s.drift) drift += 1;
  }
  return {
    total: items.length,
    criteria,
    met,
    unmet,
    stale,
    busywork,
    drift,
  };
}
