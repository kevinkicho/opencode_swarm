-- L2 rollup store for swarm-run memory.
--
-- Two tables: `rollups` (per-session AgentRollup + per-run RunRetro)
-- and `diffs` (per-session per-file unified diff text). Both are
-- regenerable from L0 (events.ndjson) via generateRollup; deleting
-- memory.sqlite is a supported "wipe" — schema applies idempotently.
--
-- Read by: lib/server/memory/reader.ts (retro page).
-- Written by: lib/server/memory/rollup.ts (auto-fired on run end).

-- L2 rollups. Persisted as JSON for portability; queryable via the
-- top-level columns for pagination without parsing the blob.
CREATE TABLE IF NOT EXISTS rollups (
  -- One row per (swarm_run_id, session_id). swarm-run-level retro is
  -- written with session_id = '' so it stays in the same table and a
  -- single query like `WHERE swarm_run_id = ?` returns per-agent + retro
  -- together.
  swarm_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'agent' | 'retro'
  workspace TEXT NOT NULL,
  closed_at INTEGER NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,           -- JSON: AgentRollup | RunRetro (memory/types.ts)
  PRIMARY KEY (swarm_run_id, session_id)
);

CREATE INDEX IF NOT EXISTS rollups_workspace ON rollups(workspace);
CREATE INDEX IF NOT EXISTS rollups_closed_at ON rollups(closed_at);

-- Per-session per-file unified-diff store. Populated at rollup time by
-- fetching /session/{id}/diff and splitting on file. Keyed by (session_id,
-- file_path) rather than the patch part's hash because opencode's diff
-- endpoint is session-aggregate — a single file's hunk covers every patch
-- that landed in the session. Rows are replaced on rollup re-run so later
-- patches are reflected without accumulating stale blobs.
CREATE TABLE IF NOT EXISTS diffs (
  swarm_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  patch TEXT NOT NULL,             -- unified-diff text for this file
  captured_ms INTEGER NOT NULL,    -- server clock at capture
  PRIMARY KEY (session_id, file_path)
);
CREATE INDEX IF NOT EXISTS diffs_swarm_run ON diffs(swarm_run_id);
CREATE INDEX IF NOT EXISTS diffs_file_path ON diffs(file_path);
