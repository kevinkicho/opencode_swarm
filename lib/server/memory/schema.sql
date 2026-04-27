-- Swarm-run persistence: registry + L2 rollups.
--
-- Three tables:
--   `runs`    — one row per swarm run (replaces .opencode_swarm/runs/<id>/meta.json)
--   `rollups` — per-session AgentRollup + per-run RunRetro
--   `diffs`   — per-session per-file unified diff text
--
-- Run events still live on disk as per-run events.ndjson files (the L0
-- replay record); only run METADATA moved into SQLite. Rollups/diffs
-- are regenerable from L0 via generateRollup.

-- Run registry. The meta payload lives in `payload` as a JSON blob;
-- workspace/source/pattern/created_at are promoted to columns so
-- listRuns + WHERE-by-workspace queries don't have to parse JSON.
CREATE TABLE IF NOT EXISTS runs (
  swarm_run_id TEXT PRIMARY KEY,
  workspace    TEXT NOT NULL,
  source       TEXT,
  pattern      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,    -- epoch ms
  payload      TEXT NOT NULL        -- JSON: SwarmRunMeta (lib/swarm-run-types.ts)
);

CREATE INDEX IF NOT EXISTS runs_workspace  ON runs(workspace);
CREATE INDEX IF NOT EXISTS runs_created_at ON runs(created_at);
CREATE INDEX IF NOT EXISTS runs_pattern    ON runs(pattern);

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
