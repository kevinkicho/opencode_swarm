//
// BoardView — a single-scan board snapshot cached per tick cycle.
// Replaces 5+ redundant full board scans per tick with one shared view.
//
// Invalidated at every board mutation point (claim, commit, retry, stale,
// planner insert). Consumers read pre-filtered slices instead of scanning
// and filtering the full board independently.
//
// globalThis-keyed so it survives HMR. TTL set to tick interval (10s) so
// stale views expire naturally if an invalidation is missed.

import 'server-only';

import { listBoardItems } from './store';
import type { BoardItem } from '../../blackboard/types';

export interface BoardView {
  openTodos: BoardItem[];
  inProgress: BoardItem[];
  doneTodos: BoardItem[];
  staleTodos: BoardItem[];
  criteria: BoardItem[];
  all: BoardItem[];
}

const VIEW_KEY = Symbol.for('opencode_swarm.boardView.v1');

interface CacheEntry {
  view: BoardView;
  at: number;
}

function cache(): Map<string, CacheEntry> {
  const g = globalThis as { [VIEW_KEY]?: Map<string, CacheEntry> };
  if (!g[VIEW_KEY]) g[VIEW_KEY] = new Map();
  return g[VIEW_KEY]!;
}

function build(swarmRunID: string): BoardView {
  const items = listBoardItems(swarmRunID);
  return {
    openTodos: items.filter(
      (i) => i.status === 'open' && (i.kind === 'todo' || i.kind === 'question' || i.kind === 'synthesize'),
    ),
    inProgress: items.filter((i) => i.status === 'claimed' || i.status === 'in-progress'),
    doneTodos: items.filter((i) => i.status === 'done' && i.kind !== 'criterion'),
    staleTodos: items.filter((i) => i.status === 'stale' && i.kind !== 'criterion'),
    criteria: items.filter((i) => i.kind === 'criterion'),
    all: items,
  };
}

// TTL: one tick interval (10s). Views that outlive this are stale and
// must be rebuilt. The TTL acts as a safety net — proper invalidation
// at mutation points should keep views fresh within a single tick.
const VIEW_TTL_MS = 15_000;

export function getBoardView(swarmRunID: string): BoardView {
  const entry = cache().get(swarmRunID);
  if (entry && Date.now() - entry.at < VIEW_TTL_MS) {
    return entry.view;
  }
  const view = build(swarmRunID);
  cache().set(swarmRunID, { view, at: Date.now() });
  return view;
}

export function invalidateBoardView(swarmRunID: string): void {
  cache().delete(swarmRunID);
}
