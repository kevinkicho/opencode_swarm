// L0 → L1 ingest. Scans events.ndjson for a swarm run and projects each
// opencode `message.part.updated` event into a row in the `parts` table.
// Idempotent via `ingest_cursors`: a re-run resumes from the last indexed
// event_seq, so calling this from a cron (or after every live event) is safe.
//
// Why only `message.part.updated`? That event is the atom of opencode's
// stream — every text chunk, tool call, patch, reasoning block flows through
// it. Other event types (session.updated, permission.asked, etc.) are status
// transitions, not content, and don't belong in a part index. If future
// recall needs to answer "when was permission X granted?", add a targeted
// table — don't bolt it into `parts`.

import path from 'node:path';

import { memoryDb } from './db';
import { readEvents, getRun, listRuns } from '../swarm-registry';
import type { SwarmRunEvent, SwarmRunMeta } from '../../swarm-run-types';

// A part-updated event carries the opencode MessagePart inline. We only
// unpack the fields we store; the rest is discarded. See
// docs/opencode-vocabulary.md for the authoritative part shape.
interface PartUpdatedProps {
  part?: {
    id?: string;
    messageID?: string;
    sessionID?: string;
    type?: string;
    tool?: string;
    // Task-tool state carries the spawned child sessionID in addition to
    // status — we capture it into child_session_id for §8.3 binding.
    state?:
      | { status?: string; sessionID?: string; childSessionID?: string }
      | string
      | null;
    text?: string;
    // Task-tool input carries the description/prompt the agent delegated.
    // When the dispatcher injects `[todo:<id>]` per DESIGN.md §8.3 (a),
    // we parse the hash out here so rollup can bind child sessions back
    // to the originating todo.
    input?: {
      description?: string;
      prompt?: string;
      subagent_type?: string;
    };
    // variant shapes carry distinct content locations — we coalesce below.
    filename?: string;
    source?: string;
    reasoning?: string;
    snippet?: string;
    // patch parts expose a file list + content hash. We capture `files` into
    // the denormalized file_paths column so filter.filePath glob queries
    // (DESIGN.md §7.5) can pre-filter cheaply in SQL and post-filter with a
    // shell-style glob in JS.
    files?: string[];
  };
}

// §8.3 option (a): agents (or an app-side wrapper) prefix task descriptions
// with `[todo:<16-hex>]` so the child session inherits the originating todo.
// 16 hex chars = sha256(todo.content)[:16], matching rollup.ts's sha256()
// helper — both sides must agree on the slice length.
const TODO_PREFIX_RE = /^\s*\[todo:([0-9a-f]{16})\]/;

// Bounded text slice stored in the row. L0 already has the full content;
// L1 is a *searchable* projection, not a full copy. 4 KB is enough for
// useful FTS matching while keeping the DB size small.
const TEXT_CAP = 4096;

function extractText(part: NonNullable<PartUpdatedProps['part']>): string {
  // Opencode uses different field names for different part kinds. Coalesce
  // into one text blob for the FTS index; the exact source doesn't matter
  // for matching, only for display, and display can pull the original
  // event back out of L0.
  const candidates = [
    part.text,
    part.reasoning,
    part.snippet,
    part.source,
    part.filename,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) {
      return c.length > TEXT_CAP ? c.slice(0, TEXT_CAP) : c;
    }
  }
  return '';
}

function extractToolState(part: NonNullable<PartUpdatedProps['part']>): string | null {
  const s = part.state;
  if (!s) return null;
  if (typeof s === 'string') return s;
  if (typeof s === 'object' && typeof s.status === 'string') return s.status;
  return null;
}

// §8.3 option (a): pull the 16-hex todo ID out of a task call's description
// or prompt. Returns null on non-task parts or when no prefix is present.
// Only the *first* match across candidates wins — description beats prompt
// so agents can put the ID on the human-facing label without polluting the
// model input.
function extractOriginTodoID(
  part: NonNullable<PartUpdatedProps['part']>
): string | null {
  if (part.type !== 'tool' || part.tool !== 'task') return null;
  const input = part.input;
  if (!input || typeof input !== 'object') return null;
  const candidates = [input.description, input.prompt];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const m = TODO_PREFIX_RE.exec(c);
    if (m) return m[1];
  }
  return null;
}

// §8.3 option (a): capture the child session a task call spawned. Opencode
// writes this into `part.state.sessionID` (the SDK has used both names over
// time — check both to be resilient). Returns null for non-task parts or
// states that haven't landed a child session yet.
function extractChildSessionID(
  part: NonNullable<PartUpdatedProps['part']>
): string | null {
  if (part.type !== 'tool' || part.tool !== 'task') return null;
  const s = part.state;
  if (!s || typeof s !== 'object') return null;
  const id =
    (typeof s.sessionID === 'string' && s.sessionID) ||
    (typeof s.childSessionID === 'string' && s.childSessionID) ||
    null;
  return id || null;
}

// Serializes a part's file attribution into a |-delimited column value. The
// leading + trailing | are intentional — they anchor LIKE/GLOB matches on
// whole-segment boundaries (e.g. `%|src/auth/foo.ts|%` matches exactly that
// file, not `src/auth/foo.ts.bak`). Returns null for parts that don't touch
// files so the partial index stays sparse.
function extractFilePaths(part: NonNullable<PartUpdatedProps['part']>): string | null {
  if (part.type === 'patch' && Array.isArray(part.files) && part.files.length > 0) {
    const cleaned = part.files
      .filter((f): f is string => typeof f === 'string' && f.length > 0)
      .map((f) => f.replace(/\n/g, ''));
    if (cleaned.length === 0) return null;
    return `|${cleaned.join('|')}|`;
  }
  if (part.type === 'file' && typeof part.filename === 'string' && part.filename.length > 0) {
    return `|${part.filename.replace(/\n/g, '')}|`;
  }
  return null;
}

// Ingest every untried event for a single swarm run. Returns the number of
// rows inserted plus the new cursor position. Safe to call against a run
// with no events file yet (returns 0, 0).
export async function reindexRun(
  meta: SwarmRunMeta
): Promise<{ inserted: number; lastSeq: number }> {
  const db = memoryDb();
  const cursorRow = db
    .prepare('SELECT last_seq FROM ingest_cursors WHERE swarm_run_id = ?')
    .get(meta.swarmRunID) as { last_seq: number } | undefined;
  const fromSeq = cursorRow?.last_seq ?? -1;

  const insert = db.prepare(
    `INSERT OR REPLACE INTO parts
      (part_id, swarm_run_id, session_id, workspace, message_id,
       part_type, tool_name, tool_state, agent, text, file_paths,
       origin_todo_id, child_session_id, created_ms, event_seq)
     VALUES
      (@part_id, @swarm_run_id, @session_id, @workspace, @message_id,
       @part_type, @tool_name, @tool_state, @agent, @text, @file_paths,
       @origin_todo_id, @child_session_id, @created_ms, @event_seq)`
  );
  const upsertCursor = db.prepare(
    `INSERT INTO ingest_cursors (swarm_run_id, last_seq, last_ts, updated_at)
     VALUES (@swarm_run_id, @last_seq, @last_ts, @updated_at)
     ON CONFLICT(swarm_run_id) DO UPDATE SET
       last_seq   = excluded.last_seq,
       last_ts    = excluded.last_ts,
       updated_at = excluded.updated_at`
  );

  let seq = -1;
  let inserted = 0;
  let lastTs = 0;

  // Transactional batching — better-sqlite3's `transaction()` wrapper is
  // ~100× faster than one INSERT per event and gives us atomic cursor
  // updates. We buffer 500 rows at a time so memory stays flat on runs with
  // millions of events.
  const BATCH = 500;
  let buffer: Array<Record<string, unknown>> = [];

  const flush = db.transaction((rows: Array<Record<string, unknown>>) => {
    for (const r of rows) insert.run(r);
  });

  for await (const ev of readEvents(meta.swarmRunID)) {
    seq += 1;
    if (seq <= fromSeq) continue;
    lastTs = ev.ts;

    const row = buildRow(ev, seq, meta);
    if (!row) continue;

    buffer.push(row);
    inserted += 1;
    if (buffer.length >= BATCH) {
      flush(buffer);
      buffer = [];
    }
  }

  if (buffer.length) flush(buffer);

  if (seq > fromSeq) {
    upsertCursor.run({
      swarm_run_id: meta.swarmRunID,
      last_seq: seq,
      last_ts: lastTs,
      updated_at: Date.now(),
    });
  }

  return { inserted, lastSeq: seq };
}

function buildRow(
  ev: SwarmRunEvent,
  seq: number,
  meta: SwarmRunMeta
): Record<string, unknown> | null {
  if (ev.type !== 'message.part.updated') return null;
  const props = (ev.properties && typeof ev.properties === 'object'
    ? (ev.properties as PartUpdatedProps)
    : {}) as PartUpdatedProps;
  const part = props.part;
  if (!part?.id || !part?.type) return null;

  // Opencode's part.id is globally unique; a replayed event will rehydrate
  // the same part_id which INSERT OR REPLACE handles cleanly.
  return {
    part_id: part.id,
    swarm_run_id: meta.swarmRunID,
    session_id: part.sessionID ?? ev.sessionID,
    workspace: normalizeWorkspace(meta.workspace),
    message_id: part.messageID ?? null,
    part_type: part.type,
    tool_name: part.type === 'tool' ? (part.tool ?? null) : null,
    tool_state: part.type === 'tool' ? extractToolState(part) : null,
    agent: null,                   // opencode doesn't expose agent-name on the part; populate later from session info
    text: extractText(part),
    file_paths: extractFilePaths(part),
    origin_todo_id: extractOriginTodoID(part),
    child_session_id: extractChildSessionID(part),
    created_ms: ev.ts,
    event_seq: seq,
  };
}

// Normalizing workspace paths lets "/repo" and "/repo/" land in the same
// bucket for workspace-scoped queries. Keep it minimal — just trailing slash
// + path.resolve for case/sep normalization on the current OS.
function normalizeWorkspace(ws: string): string {
  return path.resolve(ws);
}

// Reindex every run in the ledger. Used by `scripts/reindex.mjs` and by the
// reindex HTTP route when no swarmRunID is supplied. Returns a per-run
// tally so callers can surface progress.
export async function reindexAllRuns(): Promise<
  Array<{ swarmRunID: string; inserted: number; lastSeq: number }>
> {
  const runs = await listRuns();
  const results: Array<{ swarmRunID: string; inserted: number; lastSeq: number }> = [];
  for (const meta of runs) {
    const r = await reindexRun(meta);
    results.push({ swarmRunID: meta.swarmRunID, ...r });
  }
  return results;
}

// Convenience: reindex one run by ID. Returns null when the run doesn't
// exist — callers decide whether to 404 or treat as soft-miss.
export async function reindexRunById(
  swarmRunID: string
): Promise<{ inserted: number; lastSeq: number } | null> {
  const meta = await getRun(swarmRunID);
  if (!meta) return null;
  return reindexRun(meta);
}
