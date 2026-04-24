// Board store primitives. Thin layer over the SQLite schema so API routes
// and the coordinator (when it lands) don't hand-write SQL. Exposes CRUD
// + atomic status transitions; the actual SHA re-read for CAS commits
// belongs one layer up (route handler reads files, calls transitionStatus
// with the expected fromStatus), because filesystem I/O mustn't run inside
// the synchronous better-sqlite3 transaction.
//
// Import only from server code (API routes, scripts). The DB singleton
// enforces this at runtime by the __dirname path resolution.

import { blackboardDb } from './db';
import { emitBoardEvent } from './bus';
import type {
  BoardItem,
  BoardItemKind,
  BoardItemStatus,
} from '@/lib/blackboard/types';

// Shape of a row as it comes back from SQLite. Snake-case + JSON-encoded
// columns; hydrate() turns it into the canonical BoardItem. Kept internal
// so callers never have to think about the wire shape.
interface BoardRow {
  id: string;
  swarm_run_id: string;
  kind: BoardItemKind;
  status: BoardItemStatus;
  content: string;
  owner_agent_id: string | null;
  note: string | null;
  file_hashes_json: string | null;
  stale_since_sha: string | null;
  created_ms: number;
  completed_ms: number | null;
  requires_verification: number;
  preferred_role: string | null;
  expected_files_json: string | null;
}

function hydrate(row: BoardRow): BoardItem {
  const item: BoardItem = {
    id: row.id,
    kind: row.kind,
    content: row.content,
    status: row.status,
    createdAtMs: row.created_ms,
  };
  if (row.owner_agent_id) item.ownerAgentId = row.owner_agent_id;
  if (row.note) item.note = row.note;
  if (row.stale_since_sha) item.staleSinceSha = row.stale_since_sha;
  if (row.completed_ms != null) item.completedAtMs = row.completed_ms;
  if (row.requires_verification) item.requiresVerification = true;
  if (row.preferred_role) item.preferredRole = row.preferred_role;
  if (row.expected_files_json) {
    try {
      const parsed = JSON.parse(row.expected_files_json) as unknown;
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
        item.expectedFiles = parsed as string[];
      }
    } catch {
      // Malformed JSON — drop the field silently, matches fileHashes behavior.
    }
  }
  if (row.file_hashes_json) {
    try {
      const parsed = JSON.parse(row.file_hashes_json) as BoardItem['fileHashes'];
      if (Array.isArray(parsed)) item.fileHashes = parsed;
    } catch {
      // Malformed JSON in a TEXT column is operator-level corruption; drop
      // the field silently so the rest of the row still renders. The
      // coordinator owns the write path and only writes JSON.stringify
      // output, so this should never fire in practice.
    }
  }
  return item;
}

// Board view: every item for a run, newest-first. The UI (board-preview
// today, live view later) does its own column grouping and filtering;
// returning the flat list keeps the API surface narrow.
//
// `id ASC` as the secondary sort breaks ties deterministically — matters
// for the coordinator's "oldest open todo wins" picker, which takes the
// last element of this list. Sweep-inserted batches share a wall-clock
// ms, so without the tiebreaker two ticks could pick different items
// depending on SQLite's internal row order.
export function listBoardItems(swarmRunID: string): BoardItem[] {
  const rows = blackboardDb()
    .prepare(
      `SELECT * FROM board_items
       WHERE swarm_run_id = ?
       ORDER BY created_ms DESC, id ASC`,
    )
    .all(swarmRunID) as BoardRow[];
  return rows.map(hydrate);
}

export function getBoardItem(
  swarmRunID: string,
  itemId: string,
): BoardItem | null {
  const row = blackboardDb()
    .prepare(
      `SELECT * FROM board_items
       WHERE swarm_run_id = ? AND id = ?`,
    )
    .get(swarmRunID, itemId) as BoardRow | undefined;
  return row ? hydrate(row) : null;
}

// Insert a new board item. Kind + content are required; status defaults to
// 'open' for todos/questions, 'in-progress' for claims (which always carry
// an owner at birth). Findings land as 'done' and are immutable thereafter.
// Returns the hydrated item — callers never need a second round-trip.
export function insertBoardItem(
  swarmRunID: string,
  input: Omit<BoardItem, 'createdAtMs' | 'completedAtMs' | 'staleSinceSha'> & {
    createdAtMs?: number;
  },
): BoardItem {
  const createdAtMs = input.createdAtMs ?? Date.now();
  const completedAtMs = input.status === 'done' ? createdAtMs : null;
  blackboardDb()
    .prepare(
      `INSERT INTO board_items
       (id, swarm_run_id, kind, status, content, owner_agent_id, note,
        file_hashes_json, stale_since_sha, created_ms, completed_ms,
        requires_verification, preferred_role, expected_files_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      swarmRunID,
      input.kind,
      input.status,
      input.content,
      input.ownerAgentId ?? null,
      input.note ?? null,
      input.fileHashes ? JSON.stringify(input.fileHashes) : null,
      createdAtMs,
      completedAtMs,
      input.requiresVerification ? 1 : 0,
      input.preferredRole ?? null,
      input.expectedFiles && input.expectedFiles.length > 0
        ? JSON.stringify(input.expectedFiles)
        : null,
    );
  const item = getBoardItem(swarmRunID, input.id);
  if (!item) {
    throw new Error(
      `insertBoardItem: row ${input.id} not found after INSERT — DB invariant broken`,
    );
  }
  emitBoardEvent(swarmRunID, { type: 'item.inserted', item });
  return item;
}

// Atomic status transition. The `from` argument encodes the caller's
// expectation of current state; the SQL `WHERE status = ?` clause makes the
// whole thing CAS-safe. Two sessions racing to claim the same 'open' todo
// will see exactly one succeed and the other come back { ok: false }.
//
// Optional owner + fileHashes are merged into the same UPDATE so the claim
// lands atomically with its CAS anchors. `staleSinceSha` is set when
// transitioning to 'stale' — caller computes it from the current file
// content after noticing drift.
//
// Returns whether the transition succeeded and the hydrated row if it did
// (so routes can echo back the new state without a separate SELECT).
export interface TransitionInput {
  from: BoardItemStatus | BoardItemStatus[];
  to: BoardItemStatus;
  ownerAgentId?: string | null;
  fileHashes?: BoardItem['fileHashes'] | null;
  staleSinceSha?: string | null;
  note?: string | null;
  setCompletedAt?: boolean;
}

export function transitionStatus(
  swarmRunID: string,
  itemId: string,
  input: TransitionInput,
):
  | { ok: true; item: BoardItem }
  | { ok: false; currentStatus: BoardItemStatus | null } {
  const fromList = Array.isArray(input.from) ? input.from : [input.from];
  const placeholders = fromList.map(() => '?').join(', ');

  // Build the SET clause dynamically — only touch columns the caller cares
  // about so stale data on unrelated fields doesn't get clobbered.
  const sets: string[] = ['status = ?'];
  const args: unknown[] = [input.to];
  if (input.ownerAgentId !== undefined) {
    sets.push('owner_agent_id = ?');
    args.push(input.ownerAgentId);
  }
  if (input.fileHashes !== undefined) {
    sets.push('file_hashes_json = ?');
    args.push(input.fileHashes ? JSON.stringify(input.fileHashes) : null);
  }
  if (input.staleSinceSha !== undefined) {
    sets.push('stale_since_sha = ?');
    args.push(input.staleSinceSha);
  }
  if (input.note !== undefined) {
    sets.push('note = ?');
    args.push(input.note);
  }
  if (input.setCompletedAt) {
    sets.push('completed_ms = ?');
    args.push(Date.now());
  }

  args.push(swarmRunID, itemId, ...fromList);

  const result = blackboardDb()
    .prepare(
      `UPDATE board_items
       SET ${sets.join(', ')}
       WHERE swarm_run_id = ?
         AND id = ?
         AND status IN (${placeholders})`,
    )
    .run(...args);

  if (result.changes === 0) {
    // CAS lost or row missing — fetch current status so the caller can
    // distinguish "someone else already claimed it" (wrong status) from
    // "no such item" (status === null).
    const current = blackboardDb()
      .prepare(
        `SELECT status FROM board_items
         WHERE swarm_run_id = ? AND id = ?`,
      )
      .get(swarmRunID, itemId) as { status: BoardItemStatus } | undefined;
    return { ok: false, currentStatus: current?.status ?? null };
  }

  const item = getBoardItem(swarmRunID, itemId);
  if (!item) {
    throw new Error(
      `transitionStatus: row ${itemId} disappeared between UPDATE and SELECT — DB invariant broken`,
    );
  }
  emitBoardEvent(swarmRunID, { type: 'item.updated', item });
  return { ok: true, item };
}

// Prototype-only helper for tests / manual poking. Clears every item for a
// run so a smoke test can replay without stale state. Not exported from any
// index; import directly from '@/lib/server/blackboard/store'.
export function _dangerouslyClearRun(swarmRunID: string): number {
  const result = blackboardDb()
    .prepare('DELETE FROM board_items WHERE swarm_run_id = ?')
    .run(swarmRunID);
  return result.changes;
}
