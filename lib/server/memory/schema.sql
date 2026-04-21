-- L1 part index for swarm-run memory.
--
-- Ingests events.ndjson (L0) and projects message-parts into a single wide
-- table for SQL + FTS queries. Schema is intentionally flat — the source of
-- truth is L0; this table is regenerable and can be dropped/rebuilt from
-- scratch on schema change.
--
-- Primary use cases:
--   1. "what did agent X do to file Y?"                      (SQL WHERE)
--   2. "find parts mentioning <phrase>"                       (FTS MATCH)
--   3. rollup reducer input (§7.4 AgentRollup / RunRetro)    (SQL SELECT)
--
-- See DESIGN.md §7.1-§7.2 for the durability model.

CREATE TABLE IF NOT EXISTS parts (
  -- opencode-native part id; globally unique across sessions
  part_id TEXT PRIMARY KEY,

  -- anchoring
  swarm_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  message_id TEXT,

  -- taxonomy
  part_type TEXT NOT NULL,         -- text | reasoning | tool | file | agent | subtask | patch | retry | compaction | step-start | step-finish | snapshot
  tool_name TEXT,                  -- populated when part_type='tool' (bash, grep, task, …)
  tool_state TEXT,                 -- pending | running | completed | error

  -- authorship / direction
  agent TEXT,                      -- agent-config name at time of emit, if attributable

  -- content (first N chars only; full content stays in L0)
  text TEXT,

  -- file attribution: |-delimited list of paths touched by this part, with
  -- leading + trailing | so LIKE anchors on whole-segment matches. Populated
  -- for part_type='patch' (from part.files[]) and part_type='file' (from
  -- part.filename). NULL for every other part type. Added 2026-04-21 to
  -- back filter.filePath queries (DESIGN.md §7.5).
  file_paths TEXT,

  -- timing
  created_ms INTEGER NOT NULL,     -- epoch ms of the originating opencode event
  event_seq INTEGER NOT NULL       -- 0-based line number in events.ndjson (replay anchor)
);

CREATE INDEX IF NOT EXISTS parts_swarm_run ON parts(swarm_run_id);
CREATE INDEX IF NOT EXISTS parts_session   ON parts(session_id);
CREATE INDEX IF NOT EXISTS parts_workspace ON parts(workspace);
CREATE INDEX IF NOT EXISTS parts_agent     ON parts(agent);
CREATE INDEX IF NOT EXISTS parts_kind      ON parts(part_type, tool_name);
CREATE INDEX IF NOT EXISTS parts_time      ON parts(created_ms);
-- Partial index: only patch/file rows have file_paths populated, so we skip
-- the NULL majority. Speeds up "which parts touched any file?" pre-filters.
CREATE INDEX IF NOT EXISTS parts_file_paths
  ON parts(file_paths) WHERE file_paths IS NOT NULL;

-- FTS5 companion. contentless virtual table syncs via triggers — keeps the
-- FTS rowid aligned with parts.rowid without duplicating text at read time.
CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts USING fts5(
  text,
  content='parts',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 1'
);

CREATE TRIGGER IF NOT EXISTS parts_ai AFTER INSERT ON parts BEGIN
  INSERT INTO parts_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS parts_ad AFTER DELETE ON parts BEGIN
  INSERT INTO parts_fts(parts_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS parts_au AFTER UPDATE ON parts BEGIN
  INSERT INTO parts_fts(parts_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO parts_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- Ingest bookkeeping: remember how far each run has been indexed so
-- reindex is incremental (events.ndjson line offset).
CREATE TABLE IF NOT EXISTS ingest_cursors (
  swarm_run_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL,       -- highest event_seq ingested
  last_ts  INTEGER NOT NULL,       -- epoch ms of that event
  updated_at INTEGER NOT NULL
);

-- L2 rollups. Persisted as JSON for portability; queryable via the top-level
-- columns for pagination without parsing the blob.
CREATE TABLE IF NOT EXISTS rollups (
  -- One row per (swarm_run_id, session_id). swarm-run-level retro is written
  -- with session_id = '' so it stays in the same table and a single query
  -- like `WHERE swarm_run_id = ?` returns per-agent + retro together.
  swarm_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'agent' | 'retro'
  workspace TEXT NOT NULL,
  closed_at INTEGER NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,           -- JSON: AgentRollup | RunRetro (see memory/types.ts)
  PRIMARY KEY (swarm_run_id, session_id)
);

CREATE INDEX IF NOT EXISTS rollups_workspace ON rollups(workspace);
CREATE INDEX IF NOT EXISTS rollups_closed_at ON rollups(closed_at);
