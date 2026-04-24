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

  -- Pre-announced expected file scope (2026-04-24 declared-roles
  -- alignment). JSON array of paths; planner emits via a
  -- [files:a.ts,b.tsx] prefix capped at 2 paths. Empty/NULL for
  -- un-tagged todos preserves pre-Stage-1 behavior (no CAS
  -- protection, worker unconstrained). Coordinator hashes these at
  -- claim time for drift detection at commit. See
  -- lib/blackboard/types.ts BoardItem.expectedFiles.
  expected_files_json TEXT,

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

-- Plan revisions log — one row per planner sweep that produced new
-- items. Backs the orchestrator-worker `strategy` tab
-- (PATTERN_DESIGN/orchestrator-worker.md §3, item I2). Logged at the
-- end of runPlannerSweep so re-plans on any pattern get tracked
-- (the strategy tab itself only renders for orchestrator-worker, but
-- the data is pattern-agnostic).
--
-- Delta semantics:
--   added_json     — todos in this sweep but NOT in the prior sweep
--   removed_json   — todos in the prior sweep but NOT in this one
--                    (the orchestrator dropped them; the planner can
--                    decide a previously-proposed item is no longer
--                    worth doing)
--   rephrased_json — fuzzy-matched edits: an item the prior sweep had
--                    in slightly different wording. Each entry is
--                    {before, after}. Jaccard ≥ 0.6 over tokenized
--                    content is the match threshold.
-- All three are JSON-encoded TEXT so the row stays flat. Counts are
-- redundantly cached in *_count for quick chips without parsing.
CREATE TABLE IF NOT EXISTS plan_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  swarm_run_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  added_json TEXT NOT NULL,
  removed_json TEXT NOT NULL,
  rephrased_json TEXT NOT NULL,
  added_count INTEGER NOT NULL,
  removed_count INTEGER NOT NULL,
  rephrased_count INTEGER NOT NULL,
  -- Snapshot of the board's open/claimed/in-progress/done counts at
  -- the moment this sweep landed, encoded as JSON
  -- ({open,claimed,inProgress,done,stale,blocked,total}). Lets the
  -- strategy tab show "12/40 · 3ip · 2stale" without rejoining
  -- against board_items at query time.
  board_snapshot_json TEXT NOT NULL,
  -- First 200 chars of the orchestrator's assistant text — the row's
  -- excerpt column. Truncation at write time keeps the SELECT cheap.
  excerpt TEXT,
  -- opencode message ID of the assistant turn that produced this
  -- sweep — lets the UI link from a strategy row directly to the
  -- transcript turn.
  plan_message_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS plan_revisions_run
  ON plan_revisions(swarm_run_id, round DESC);

-- Persistent ticker stop record — backs PATTERN_DESIGN/blackboard.md
-- I3. The in-memory `tickers` map is process-local; on dev-server
-- restart we lose every run's stop reason. This table lets
-- getTickerSnapshot reconstruct a stopped-state snapshot after
-- restart so the UI doesn't go from "stopped: hard-cap" → "no ticker
-- ever ran" across an HMR or a Node process recycle.
--
-- Written on stopAutoTicker firing (one INSERT-or-REPLACE per run).
-- Read by getTickerSnapshot when no in-memory state exists. Active
-- runs DON'T touch this table — running snapshots come from
-- in-memory state only; persistence is for terminal state only.
CREATE TABLE IF NOT EXISTS ticker_snapshots (
  swarm_run_id TEXT PRIMARY KEY,
  stopped_at INTEGER NOT NULL,
  stop_reason TEXT NOT NULL,
  -- Full TickerSnapshot at stop time, JSON-encoded. Lets the read
  -- path return the same shape the live in-memory cache returns —
  -- including currentTier, retryAfterEndsAtMs, etc. — without
  -- inventing partial reconstructions.
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
