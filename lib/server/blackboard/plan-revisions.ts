// Plan revisions store + delta computation. Backs the orchestrator-
// worker `strategy` tab (PATTERN_DESIGN/orchestrator-worker.md §3 +
// I2). Logged at the end of every `runPlannerSweep`, regardless of
// pattern — the strategy tab consumes it for orchestrator-worker
// runs, but the data is pattern-agnostic so re-sweeps on any pattern
// produce a useful timeline.
//
// Delta semantics:
//   added     — items in this sweep but NOT in the prior sweep
//   removed   — items in the prior sweep but NOT in this one
//                 (orchestrator dropped a previously-proposed todo)
//   rephrased — items the prior sweep had in slightly different
//                 wording, matched by token-jaccard ≥ MATCH_THRESHOLD
//
// The match step pairs surviving "removed" against surviving "added"
// greedily — each side can match at most once, and matches above the
// threshold migrate from added/removed into the rephrased bucket.
//
// Server-only.

import 'server-only';

import { blackboardDb } from './db';

export interface PlanRevision {
  id: number;
  swarmRunID: string;
  round: number;
  added: string[];
  removed: string[];
  rephrased: Array<{ before: string; after: string }>;
  addedCount: number;
  removedCount: number;
  rephrasedCount: number;
  boardSnapshot: BoardSnapshot;
  excerpt: string | null;
  planMessageId: string | null;
  createdAt: number;
}

export interface BoardSnapshot {
  total: number;
  open: number;
  claimed: number;
  inProgress: number;
  done: number;
  stale: number;
  blocked: number;
}

interface PlanRevisionRow {
  id: number;
  swarm_run_id: string;
  round: number;
  added_json: string;
  removed_json: string;
  rephrased_json: string;
  added_count: number;
  removed_count: number;
  rephrased_count: number;
  board_snapshot_json: string;
  excerpt: string | null;
  plan_message_id: string | null;
  created_at: number;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'this', 'that',
]);

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Threshold tuned to call "Wire heatmap to API" and "Wire the heatmap
// panel to the live API" the same item, while keeping "Add unit tests"
// distinct from "Add integration tests". Token overlap at 60% catches
// genuine rephrasing but leaves typo-level differences as identical
// (those exit at exact-match before reaching this).
export const RENAME_MATCH_THRESHOLD = 0.6;

// Greedy bipartite-pair across removed × added by token-jaccard.
// Items above the threshold migrate into the rephrased bucket; the
// remainder stay as added/removed. Greedy is fine here: the lists are
// small (planner emits 6-15 items per sweep), and the optimal-pairing
// difference relative to greedy is ≤ 1 mispairing in pathological
// cases that don't matter for an observability surface.
export function computeDelta(
  prior: string[],
  current: string[],
): Pick<PlanRevision, 'added' | 'removed' | 'rephrased'> {
  // Exact-match pre-pass — stable items drop out before the fuzzy pair.
  const priorSet = new Set(prior);
  const currentSet = new Set(current);
  const removedRaw = prior.filter((s) => !currentSet.has(s));
  const addedRaw = current.filter((s) => !priorSet.has(s));

  // Tokenize once — re-using token sets across the pair loop keeps the
  // O(N*M) cost cheap for N,M ≤ 15.
  const removedTok = removedRaw.map((s) => tokenize(s));
  const addedTok = addedRaw.map((s) => tokenize(s));

  const usedRemoved = new Set<number>();
  const usedAdded = new Set<number>();
  const rephrased: Array<{ before: string; after: string }> = [];

  // Find best pair iteratively until no pair clears the threshold.
  while (true) {
    let bestI = -1;
    let bestJ = -1;
    let bestScore = RENAME_MATCH_THRESHOLD;
    for (let i = 0; i < removedRaw.length; i += 1) {
      if (usedRemoved.has(i)) continue;
      for (let j = 0; j < addedRaw.length; j += 1) {
        if (usedAdded.has(j)) continue;
        const score = jaccard(removedTok[i], addedTok[j]);
        if (score > bestScore) {
          bestScore = score;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI < 0) break;
    rephrased.push({ before: removedRaw[bestI], after: addedRaw[bestJ] });
    usedRemoved.add(bestI);
    usedAdded.add(bestJ);
  }

  const added = addedRaw.filter((_, j) => !usedAdded.has(j));
  const removed = removedRaw.filter((_, i) => !usedRemoved.has(i));
  return { added, removed, rephrased };
}

function hydrate(row: PlanRevisionRow): PlanRevision {
  // Defensive parsing — schema is internal so the JSON shapes are
  // stable, but a row written by a stale server build could
  // theoretically have a malformed array. Return [] rather than throw
  // — the strategy tab can still render a row with an empty delta.
  const safeArr = (json: string): string[] => {
    try {
      const v = JSON.parse(json) as unknown;
      return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : [];
    } catch {
      return [];
    }
  };
  const safeRephrased = (json: string): Array<{ before: string; after: string }> => {
    try {
      const v = JSON.parse(json) as unknown;
      if (!Array.isArray(v)) return [];
      return v.filter(
        (x): x is { before: string; after: string } =>
          !!x &&
          typeof x === 'object' &&
          typeof (x as { before?: unknown }).before === 'string' &&
          typeof (x as { after?: unknown }).after === 'string',
      );
    } catch {
      return [];
    }
  };
  let snapshot: BoardSnapshot;
  try {
    const raw = JSON.parse(row.board_snapshot_json) as Partial<BoardSnapshot>;
    snapshot = {
      total: typeof raw.total === 'number' ? raw.total : 0,
      open: typeof raw.open === 'number' ? raw.open : 0,
      claimed: typeof raw.claimed === 'number' ? raw.claimed : 0,
      inProgress: typeof raw.inProgress === 'number' ? raw.inProgress : 0,
      done: typeof raw.done === 'number' ? raw.done : 0,
      stale: typeof raw.stale === 'number' ? raw.stale : 0,
      blocked: typeof raw.blocked === 'number' ? raw.blocked : 0,
    };
  } catch {
    snapshot = { total: 0, open: 0, claimed: 0, inProgress: 0, done: 0, stale: 0, blocked: 0 };
  }
  return {
    id: row.id,
    swarmRunID: row.swarm_run_id,
    round: row.round,
    added: safeArr(row.added_json),
    removed: safeArr(row.removed_json),
    rephrased: safeRephrased(row.rephrased_json),
    addedCount: row.added_count,
    removedCount: row.removed_count,
    rephrasedCount: row.rephrased_count,
    boardSnapshot: snapshot,
    excerpt: row.excerpt,
    planMessageId: row.plan_message_id,
    createdAt: row.created_at,
  };
}

export function listPlanRevisions(swarmRunID: string): PlanRevision[] {
  const rows = blackboardDb()
    .prepare(
      `SELECT * FROM plan_revisions
       WHERE swarm_run_id = ?
       ORDER BY round DESC`,
    )
    .all(swarmRunID) as PlanRevisionRow[];
  return rows.map(hydrate);
}

// Returns the latest revision's full content list — caller compares
// against the new sweep's items to compute the delta. NULL when no
// prior sweep exists for the run (treat all current items as added).
export function getLatestRevisionContents(
  swarmRunID: string,
): { contents: string[]; round: number } | null {
  const row = blackboardDb()
    .prepare(
      `SELECT round, added_json, rephrased_json
       FROM plan_revisions
       WHERE swarm_run_id = ?
       ORDER BY round DESC
       LIMIT 1`,
    )
    .get(swarmRunID) as
    | Pick<PlanRevisionRow, 'round' | 'added_json' | 'rephrased_json'>
    | undefined;
  if (!row) return null;
  // Re-hydrating the prior sweep's items is not stored directly — we
  // chain forward from the prior revision's added + rephrased.after,
  // since added represents new items at sweep time and rephrased.after
  // represents items that survived in renamed form. Removed/exact-
  // matched items are already gone. This recovers the prior sweep's
  // logical content set without a separate table.
  let added: string[] = [];
  let rephrasedAfter: string[] = [];
  try {
    const a = JSON.parse(row.added_json) as unknown;
    if (Array.isArray(a)) added = a.filter((x): x is string => typeof x === 'string');
  } catch {
    // ignore
  }
  try {
    const r = JSON.parse(row.rephrased_json) as unknown;
    if (Array.isArray(r)) {
      rephrasedAfter = r
        .filter(
          (x): x is { after: string } =>
            !!x && typeof x === 'object' && typeof (x as { after?: unknown }).after === 'string',
        )
        .map((x) => x.after);
    }
  } catch {
    // ignore
  }
  // This is the LOGGED diff for that round, which is incomplete on its
  // own — the prior sweep's full list is the union of all prior rounds'
  // (added + rephrased.after). Walk back through the table.
  const allRows = blackboardDb()
    .prepare(
      `SELECT added_json, removed_json, rephrased_json
       FROM plan_revisions
       WHERE swarm_run_id = ?
       ORDER BY round ASC`,
    )
    .all(swarmRunID) as Array<Pick<PlanRevisionRow, 'added_json' | 'removed_json' | 'rephrased_json'>>;
  const cumulative = new Set<string>();
  for (const r of allRows) {
    let addedRow: string[] = [];
    let removedRow: string[] = [];
    let rephRow: Array<{ before: string; after: string }> = [];
    try {
      const a = JSON.parse(r.added_json) as unknown;
      if (Array.isArray(a)) addedRow = a.filter((x): x is string => typeof x === 'string');
    } catch {
      // ignore
    }
    try {
      const rm = JSON.parse(r.removed_json) as unknown;
      if (Array.isArray(rm)) removedRow = rm.filter((x): x is string => typeof x === 'string');
    } catch {
      // ignore
    }
    try {
      const rp = JSON.parse(r.rephrased_json) as unknown;
      if (Array.isArray(rp)) {
        rephRow = rp.filter(
          (x): x is { before: string; after: string } =>
            !!x &&
            typeof x === 'object' &&
            typeof (x as { before?: unknown }).before === 'string' &&
            typeof (x as { after?: unknown }).after === 'string',
        );
      }
    } catch {
      // ignore
    }
    for (const a of addedRow) cumulative.add(a);
    for (const rm of removedRow) cumulative.delete(rm);
    for (const rp of rephRow) {
      cumulative.delete(rp.before);
      cumulative.add(rp.after);
    }
  }
  return { contents: [...cumulative], round: row.round };
}

export function recordPlanRevision(input: {
  swarmRunID: string;
  round: number;
  added: string[];
  removed: string[];
  rephrased: Array<{ before: string; after: string }>;
  boardSnapshot: BoardSnapshot;
  excerpt: string | null;
  planMessageId: string | null;
}): void {
  blackboardDb()
    .prepare(
      `INSERT INTO plan_revisions
       (swarm_run_id, round, added_json, removed_json, rephrased_json,
        added_count, removed_count, rephrased_count,
        board_snapshot_json, excerpt, plan_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.swarmRunID,
      input.round,
      JSON.stringify(input.added),
      JSON.stringify(input.removed),
      JSON.stringify(input.rephrased),
      input.added.length,
      input.removed.length,
      input.rephrased.length,
      JSON.stringify(input.boardSnapshot),
      input.excerpt,
      input.planMessageId,
      Date.now(),
    );
}

export function nextRoundForRun(swarmRunID: string): number {
  const row = blackboardDb()
    .prepare(
      `SELECT MAX(round) as max_round FROM plan_revisions WHERE swarm_run_id = ?`,
    )
    .get(swarmRunID) as { max_round: number | null } | undefined;
  const max = row?.max_round ?? 0;
  return max + 1;
}
