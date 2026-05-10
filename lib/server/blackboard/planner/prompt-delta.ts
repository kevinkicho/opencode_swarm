//
// Planner prompt delta — sends only changed board items between sweeps.
// First sweep gets the full 8K-char context. Subsequent sweeps get only
// items added/changed since the last sweep, reducing board-context
// tokens by ~60% on re-sweeps.
//
// Combined with Fix 1's session isolation (fresh session per sweep),
// the planner's total token budget per re-sweep drops from ~25K to ~8K.

import 'server-only';

import { listBoardItems } from '../store';
import type { BoardItem } from '../../../blackboard/types';

// ─── Snapshot types ──────────────────────────────────────────────────

interface BoardSnapshot {
  itemIDs: Set<string>;          // all item IDs present at last sweep
  criteriaVerdicts: Map<string, string>;  // itemID → verdict (open|done|blocked|stale)
  createdAt: number;
}

const SNAPSHOT_KEY = Symbol.for('opencode_swarm.planner.boardSnapshots');

function snapshots(): Map<string, BoardSnapshot> {
  const g = globalThis as { [SNAPSHOT_KEY]?: Map<string, BoardSnapshot> };
  if (!g[SNAPSHOT_KEY]) g[SNAPSHOT_KEY] = new Map();
  return g[SNAPSHOT_KEY]!;
}

export function saveBoardSnapshot(swarmRunID: string): void {
  const items = listBoardItems(swarmRunID);
  const verdictLabel: Record<string, string> = {
    open: 'pending', done: 'MET', blocked: 'UNMET', stale: 'wont-do',
  };
  const snapshot: BoardSnapshot = {
    itemIDs: new Set(items.map((i) => i.id)),
    criteriaVerdicts: new Map(
      items
        .filter((i) => i.kind === 'criterion')
        .map((i) => [i.id, verdictLabel[i.status] ?? i.status]),
    ),
    createdAt: Date.now(),
  };
  snapshots().set(swarmRunID, snapshot);
}

// ─── Delta interface ─────────────────────────────────────────────────

export interface BoardDelta {
  // Items NEW since last sweep (not in the snapshot's itemIDs set).
  // Null on first sweep (no prior snapshot) — caller uses full context.
  isDelta: boolean;
  newDone: string[];
  newActive: string[];
  // Criteria whose verdict CHANGED since last sweep.
  changedCriteria: string[];
  // Always fresh — stale items and failure patterns are new each sweep.
  failurePatterns: string[];
}

const TRUNCATE = 120;

function trunc(s: string): string {
  return s.length > TRUNCATE ? s.slice(0, TRUNCATE - 3).trimEnd() + '…' : s;
}

export function computeBoardDelta(swarmRunID: string): BoardDelta | null {
  const prior = snapshots().get(swarmRunID);
  if (!prior) return null; // first sweep — use full context

  const all = listBoardItems(swarmRunID);
  const verdictLabel: Record<string, string> = {
    open: 'pending', done: 'MET', blocked: 'UNMET', stale: 'wont-do',
  };

  const newDone: string[] = [];
  const newActive: string[] = [];
  const changedCriteria: string[] = [];

  for (const item of all) {
    const isNew = !prior.itemIDs.has(item.id);

    if (item.kind === 'criterion') {
      const currentVerdict = verdictLabel[item.status] ?? item.status;
      const priorVerdict = prior.criteriaVerdicts.get(item.id);
      if (isNew || currentVerdict !== priorVerdict) {
        changedCriteria.push(`[${currentVerdict}] ${trunc(item.content)}`);
      }
    } else if (item.status === 'done' && isNew) {
      newDone.push(trunc(item.content));
    } else if (
      (item.status === 'open' || item.status === 'claimed' || item.status === 'in-progress') &&
      isNew
    ) {
      newActive.push(trunc(item.content));
    }
  }

  return {
    isDelta: true,
    newDone,
    newActive,
    changedCriteria,
    // Failure patterns are always computed fresh — stale items change each sweep
    failurePatterns: [],
  };
}
