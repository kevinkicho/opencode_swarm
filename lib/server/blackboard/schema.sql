-- Blackboard preset authoritative state. One row per board item; a swarm run
-- is a set of rows sharing swarm_run_id.
--
-- Why its own DB (not memory.sqlite):
--   * memory.sqlite is regenerable from L0 events.ndjson — drop and reindex.
--   * The board is authoritative: claim ownership and CAS-committed findings
--     can't be rebuilt from opencode's event stream alone.
-- Different data gravity → different file. See lib/server/blackboard/db.ts.
--
-- Schema kept narrow on purpose (SWARM_PATTERNS.md §"Preset picker UX": anything
-- that becomes policy moves to the routing modal, not the board row). The
-- `fileHashes` and `note` columns are JSON-encoded TEXT so the row stays flat
-- and SQL queries don't need joins.

CREATE TABLE IF NOT EXISTS board_items (
  -- Stable within a run. Coordinator mints these; agent-authored items use
  -- the same format. No uniqueness across runs — swarm_run_id scopes them.
  id TEXT NOT NULL,
  swarm_run_id TEXT NOT NULL,

  -- taxonomy (see lib/blackboard/types.ts)
  kind TEXT NOT NULL,        -- claim | question | todo | finding
  status TEXT NOT NULL,      -- open | claimed | in-progress | done | stale | blocked
  content TEXT NOT NULL,

  owner_agent_id TEXT,       -- set when status moves past 'open'
  note TEXT,                 -- human-readable annotation; e.g. "blocked on t_003"

  -- CAS anchors: file_hashes_json is a JSON array of {path, sha} recorded at
  -- claim time. stale_since_sha is populated on the 'stale' transition when
  -- a commit attempt sees drift — 7-char hex of the new content so the UI
  -- can render "moved under you @ d8e10c4".
  file_hashes_json TEXT,
  stale_since_sha TEXT,

  created_ms INTEGER NOT NULL,
  completed_ms INTEGER,

  -- Playwright grounding flag. When 1 and the run has
  -- enableVerifierGate set, the coordinator consults the verifier
  -- session after the critic gate approves, before marking done.
  -- 0 for board items that don't claim a user-observable outcome
  -- (refactors, internal cleanup, etc.). See SWARM_PATTERNS.md
  -- "Tiered execution" companion layer #2.
  requires_verification INTEGER NOT NULL DEFAULT 0,

  -- Soft role affinity for hierarchical-pattern runs. Set by the
  -- planner when it tags a todo with a [role:<name>] prefix. NULL
  -- on self-organizing runs. The coordinator picker biases toward
  -- role-matching session×item pairs but still allows any session
  -- to claim — see SWARM_PATTERNS.md §6.
  preferred_role TEXT,

  PRIMARY KEY (swarm_run_id, id)
);

-- Hot path: list items for a run, usually filtered + sorted by status column.
-- A compound (run, status) index covers both the board view and the
-- "open items any idle agent can claim" scan.
CREATE INDEX IF NOT EXISTS board_items_run
  ON board_items(swarm_run_id);
CREATE INDEX IF NOT EXISTS board_items_run_status
  ON board_items(swarm_run_id, status);

-- Agents can only claim what they see as 'open'; the CAS transition
-- `UPDATE … WHERE status = 'open'` relies on this + the PK for atomicity.
-- No other code should UPDATE board_items.status without a matching
-- `WHERE status = <expected>` — see store.ts transitionStatus().
