# Status — where the project is right now

**What this file is.** A time-scoped snapshot of what has shipped, what
has rough edges, and what's queued. Complements the 5 durable docs
(`CLAUDE.md`, `DESIGN.md`, `SWARM_PATTERNS.md`, `WHAT_THIS_PROJECT_IS_NOT.md`,
`docs/ARCHITECTURE.md`) — those are stable reference material you read
once per task; this file you check when asking "where are we?"

**What this file is NOT.** Not a changelog (`git log` is canonical). Not
a design-decisions log (`DESIGN.md` §9 owns that). Not a roadmap (this is
present-tense). Not a todo list for individual tasks — if it can be done
in < 30 min, put it in the conversation or a commit, not here.

**Maintenance.** Append-only during a work session; rewrite (prune +
reorganize) every couple months. Keep known-limitations and queued items
current — remove when shipped or explicitly abandoned.

---

## Last updated

**2026-04-23** — post-consolidation. Today's 12 incremental shipped
entries folded into one themed block. Next review: ~2026-06-01 or
whenever the file has drifted enough that scanning it doesn't match
the actual state.

---

## Shipped

### 2026-04-23 — ambition-ratchet stack + Go routing + validation

One day, large ship run. Grouped by theme.

**Autonomous-long-run layers (SWARM_PATTERNS.md §"Tiered execution"):**

- **Ambition ratchet / tier escalation** — when a blackboard-family run
  drains its board and would auto-idle-stop, the auto-ticker instead
  fires a planner sweep at the next tier (polish → structural →
  capabilities → research → vision; MAX_TIER=5). Stops only when every
  tier returns empty. TickerSnapshot carries `currentTier` /
  `tierExhausted` / `maxTier`.
- **Anti-busywork critic gate** (opt-in via `enableCriticGate: true`) —
  dedicated critic session spawned at run creation; coordinator
  consults it between "turn completed" and `to: 'done'`. Busywork
  verdict → item stale with `[critic-rejected]` note. Fail-open on
  malfunction. **Validated live 2026-04-23:** 2 busywork rejections
  observed with reasons like *"No file edits produced; the fix was
  already attributed to a prior turn"* — real catch, not rubber stamp.
- **Playwright grounding / verifier gate** (opt-in via
  `enableVerifierGate: true` + `workspaceDevUrl`) — dedicated verifier
  session runs `npx playwright` via bash against the target dev server,
  replies `VERIFIED` / `NOT_VERIFIED` / `UNCLEAR`. Planner flags
  UX-outcome todos with a `[verify]` prefix; `latestTodosFrom` strips
  it and sets `requiresVerification` on the board item. Schema
  extended with `requires_verification` column (idempotent migration).
- **Hierarchical pattern set** (retired the "no role hierarchy"
  stance): `orchestrator-worker`, `role-differentiated`,
  `debate-judge`, `critic-loop`, `deliberate-execute`. Each with its
  own kickoff orchestrator in `lib/server/`.

**Session / process safety:**

- **Non-ticker pattern session cleanup** — council / map-reduce /
  debate-judge / critic-loop orchestrators now wrap their kickoff
  body in a try/finally that calls `finalizeRun(swarmRunID, ctx)`
  (shared helper in `lib/server/finalize-run.ts`). Aborts every
  session on run end, including exception paths. Closes the
  session-leak story across all 9 patterns.

- **`zen-rate-limit` vs `opencode-frozen` distinction.** The
  liveness watchdog now probes the opencode log for recent
  `statusCode":429` entries before declaring a freeze. If found
  → `stopReason: 'zen-rate-limit'` with retry-after logged.
  Otherwise → `stopReason: 'opencode-frozen'` as before. Helper
  in `lib/server/zen-rate-limit-probe.ts`, respects
  `OPENCODE_LOG_DIR` env for non-default log locations.

- **Retry-after countdown chip.** New `RetryAfterChip` in
  `swarm-topbar.tsx` renders next to the tier chip when a run is
  stopped with `stopReason: 'zen-rate-limit'` and a parseable
  retry-after was captured. Ticks once per second showing the
  remaining window (`retry 3h 47m` → `retry 3h 46m` → …) and
  self-terminates once the window elapses. Server-side:
  `TickerState.retryAfterEndsAtMs` set by the watchdog when it
  detects a Zen 429; surfaced on both server + client
  `TickerSnapshot`.

- **Partial SSE-merge in `useLiveSwarmRunMessages`.** When an SSE
  event carries the full `message.part.updated` or `message.updated`
  payload, the hook splices it directly into the local message
  buffer in O(1) instead of triggering a full session-history
  refetch. Falls back to refetch (with the existing 2 s cooldown
  throttle) only when the event doesn't carry enough data or the
  target message isn't yet in the buffer. The cost of an active
  run's stream drops from O(N × total_messages) per interval to
  O(N) — the dominant cost that made the run view slow on busy
  runs. The initial hydrate is still a parallel `Promise.all` of
  full fetches; that's the remaining first-paint cost.

- **Liveness decay when backend vanishes.** New
  `useBackendStale()` hook (in `lib/opencode/live.ts`) wraps
  `useOpencodeHealth` with a 2-consecutive-offline debounce.
  Consumed by `SwarmTopbar` (RunAnchorChip + TierChip fade to
  opacity-50 + grayscale with a "status shown is pre-disconnect
  cache" tooltip) and `SwarmTimeline` (lane status circles drop
  their animation + switch to a neutral fog dot). Fixes the
  "offline badge says offline but blinking circle still blinks"
  mixed-signal problem we saw after dev shutdown.

- **Periodic-mode tier escalation** — `runPeriodicSweep` now tracks
  `consecutiveDrainedSweeps`. When ≥ 2 consecutive sweeps produce
  zero new work AND the board has zero active items (open +
  claimed + in-progress), fires `attemptTierEscalation`. Default
  20-min sweep cadence means ~40 min of drained quiet before the
  ratchet climbs. Resets on any sweep that seeds work or leaves
  active board items.

- **Ambition-ratchet tier state persists.** `attemptTierEscalation`
  writes `currentTier` to `SwarmRunMeta` via a new `updateRunMeta`
  helper; `ensureSlots` reads it back on the first fanout of a
  fresh ticker lifecycle. A ticker restart mid-run now resumes at
  the persisted tier instead of dropping back to 1. Fire-and-forget
  write — a failed persist doesn't stall the ticker; next bump
  overwrites.

- **Demo-log retention now runs on dev boot.** New module
  `lib/server/demo-log-retention.ts::pruneDemoLog()` walks `demo-log/`,
  gzips large `events.ndjson` / `board-events.ndjson` files
  (≥ 64 KB), and — *only when `DEMO_LOG_AUTO_DELETE=1` env is set* —
  rm-rf's run directories older than `DEMO_LOG_RETENTION_DAYS`
  (default 30). Called from auto-ticker's startup pass alongside
  orphan-session cleanup. Compression is always on and
  non-destructive; deletion stays opt-in. Manual
  `scripts/prune_demo_log.mjs` still works for ad-hoc runs.

- **Per-pattern zombie threshold.** `coordinator.ts` now reads
  `meta.pattern` and picks from `ZOMBIE_TURN_THRESHOLDS_MS`: 10 min
  default for blackboard / orchestrator-worker / role-differentiated;
  15 min for deliberate-execute (synthesis phase legitimately takes
  longer). Easy to tune further as real-run data accumulates.

- **Per-pattern turn-timeout.** Same treatment as the zombie
  threshold but on the `waitForSessionIdle` deadline: `TURN_TIMEOUTS_MS`
  map + `turnTimeoutFor(pattern)` helper. `deliberate-execute` gets
  15 min; the rest default to 10 min. Matches the zombie boundary so
  the picker doesn't clip legitimately long turns.

- **Per-todo `preferredRole` soft routing for role-differentiated.**
  Board items gained an optional `preferredRole` field (DB migration
  `preferred_role TEXT` column). Planner parses a `[role:<name>]`
  prefix on todowrite content (symmetric to the `[verify]` prefix)
  and sets the field. Coordinator picker adds role affinity as a
  primary sort key: matching session×item pairs win over heat/age,
  neutrals (no role or no preferredRole) stay in the existing sort,
  mismatches are de-prioritized but still claimable — soft bias, not
  hard routing. Role-differentiated kickoff now persists resolved
  `teamRoles` to meta so `roleNamesBySessionID` sees them even when
  the request omitted them. Planner prompt extended with role-tag
  instructions when `meta.pattern === 'role-differentiated'`.

- **Run chaining / continuity (`continuationOf`).** New optional
  field on `SwarmRunRequest` + `SwarmRunMeta`. When set, the new run
  inherits the prior run's workspace + source + `currentTier`, so
  commits keep landing on the same checkout and the ambition ratchet
  resumes at the prior tier instead of resetting to 1. Validation
  rejects a workspace mismatch (silent-fork prevention). Directive,
  pattern, teamSize, bounds, and roles stay per-run. Unlocks the
  "unleash a swarm on this repo for a week, bouncing through patterns
  as needed" usage. `runPlannerSweep` now reads `meta.currentTier` as
  a fallback when `opts.escalationTier` is unset, so continuation
  runs get tier-appropriate planning on their first sweep without
  touching every kickoff call site.

- **Auto-abort on worker-timeout.** When `tickCoordinator`'s
  `waitForSessionIdle` returns `{ ok: false, reason: 'timeout' }`, the
  coordinator now calls `abortSessionServer` immediately instead of
  leaving the turn in flight for the zombie-picker to catch ≥ 10 min
  later. `'errored'` path skips the abort — opencode already produced
  a terminal signal. Fire-and-forget, same pattern as the zombie
  auto-abort. Saves up to 10 min of dead token consumption per
  timeout.

- **Auto-abort on every stop path** — `stopAutoTicker` aborts all
  session turns (workers + critic + verifier) on auto-idle,
  tier-exhausted, opencode-frozen, and manual stop.
- **Shutdown hook awaits aborts** — SIGTERM/SIGINT/beforeExit run an
  async shutdown that clears timers, awaits all abort HTTP calls
  (5s cap), then `process.exit`. Closes the fire-and-forget race.
- **Startup auto-cleanup** — on first module load the auto-ticker
  iterates recent runs (< 48h) and aborts any still-in-flight turns.
  Covers SIGKILL / crash / reboot gaps.
- **Zombie auto-abort** in the coordinator picker (10-min threshold)
  catches hanging assistant turns.
- **HMR-resilient exports** on `coordinator.ts` / `planner.ts` /
  `auto-ticker.ts` via globalThis stashes — edits take effect on live
  tickers without restart.

**Billing / routing:**

- **`opencode-go/<id>` prefix** is the right default for paid runs —
  routes through Go subscription first, falls through to Zen per the
  user's opencode settings toggle. `opencode/<id>` (bare) goes
  straight to Zen pay-per-use. Distinction cost us ~$2 in Zen credit
  before we figured it out; captured in
  `memory/feedback_zen_model_preference.md`.
- **Per-agent model override** via opencode.json `agent.plan.model`;
  our planner code posts with `agent: 'plan'`. Lets a single config
  run planner on smart paid model + workers on cheap/free.
- **Opencode silent-freeze diagnosis** traced to Zen free-tier 429s,
  not process wedging. `memory/reference_opencode_freeze.md`
  documents diagnosis path + recovery via retry-stale.

**Endpoints:**

- `GET /api/swarm/run/:id/tokens` — per-session + aggregate
  token/cost breakdown; role-labeled for hierarchical patterns.
- `POST /api/swarm/run/:id/board/retry-stale` — bulk reopen of
  stale items; auto-restarts the ticker for ticker-driven patterns.

**UI:**

- **Tier indicator chip** in the run topbar (`tier 3/5 · capabilities`
  live as the ratchet climbs).
- **Topbar de-mocked** — bundle-cost fallback via `derivedCost` so
  big-pickle runs show real $ estimates; fake `goTier` 5h chip
  removed; fake `StatsStream` popover removed from BudgetChip + roster.
- **Pattern-specific affordances**: `JudgeVerdictStrip` (debate-judge),
  `CriticVerdictStrip` (critic-loop), `OrchestratorActionsStrip`
  (orchestrator-worker nudges), phase-aware empty-state + deliberation
  round counter (deliberate-execute), bundle banner on cost-dashboard,
  per-row bundle chip on cost-dashboard.
- **Roster role labels** — coordinator tags worker prompts with
  `agent={role}` so hierarchical runs show role names, not "build."
- **Topbar simplified** — removed `LiveSessionPicker` + duplicate
  `SwarmRunsPicker`. Topbar is run title + anchor chip + tier chip +
  abort chip, nothing duplicated.
- **Timeline scroll fixes** — two-phase rAF snap on fresh load
  (reliable default-to-bottom), 48 px tight stick-threshold,
  56 px padding so the "latest" button no longer overlays the last
  row.
- **Browser `ChunkLoadError` auto-reload** with a brief overlay.

**Tooling + scripts:**

- `scripts/_pattern_benchmark.mjs` — runs coordinator-backed patterns
  sequentially on the same workspace, reports tokens/cost/commits/
  critic-rejections/verifier-rejections per pattern.
- `scripts/prune_demo_log.mjs` — dry-run-by-default pruner; gzips
  ≥ 64 KB events.ndjson; `--delete --days N` removes old run dirs.
- `scripts/_hierarchical_smoke.mjs` — pattern smoke skeleton.

**Tertiary plumbing:**

- SSE shaping (`lib/server/sse-shaping.ts`) — strips redundant diff
  patches, coalesces part.updated at 250 ms, dedupes replay. ~50 %
  byte reduction on real runs.
- Planner prompt rewrite — mission-anchored, auto-embeds README (32 KB
  cap), anti-pattern list bans passive verifications. Todo count
  6-15 with a mix of sizes.
- `useLiveSwarmRunMessages` refetch throttle — 2 s cooldown +
  trailing refresh, cuts server fan-in ~10× on busy runs. (Deeper
  partial-SSE-merge fix tracked below.)

### Earlier (see `git log` for specifics)

- **Blackboard parallelism fix** (2026-04-22) — per-session tick
  fan-out; fixed 1-of-N sessions claiming all work.
- **Council auto-rounds** (2026-04-22) — rounds 2/3 fire server-side.
- **Map-reduce v2** — synthesis as a board-claimed `synthesize` todo.
- **Stigmergy v0 + v1** — per-file edit heat observation + picker
  weighting in `tickCoordinator`.
- **Opencode port isolation** — `:4097` with separate `XDG_DATA_HOME`
  so this app's session list doesn't mix with the ollama-swarm sibling.

---

## Known limitations — things that work but have sharp edges

### Orchestration / runtime

- **HMR covers only 3 server modules** (`coordinator.ts`,
  `planner.ts`, `auto-ticker.ts`). Edits to other `lib/server/`
  files need a dev-server bounce to take effect on live tickers.
  Low priority — those files change rarely.

- **Silent-freeze is now auto-distinguished.** The liveness watchdog
  probes the opencode log for a recent `statusCode":429` before
  declaring a freeze. If found → `stopReason: zen-rate-limit`
  (with retry-after logged). Otherwise → `stopReason:
  opencode-frozen`. UI-side polish (chip showing the retry-after
  countdown) still queued below.

### UI performance

- **Live run view — initial hydration cost on very big runs** (not
  related to SSE now). Partial SSE-merge shipped — `useLiveSwarm-
  RunMessages` now splices `message.part.updated` / `message.updated`
  payloads locally in O(1) instead of full-history refetch. That
  was the dominant cost during active runs. The remaining load
  cost is the initial `Promise.all` of N parallel full-history
  fetches on first mount; still worst-case for a brand-new tab
  opening a run with 100s of messages per session. Mitigations:
  stagger the initial hydrate (first session's data renders before
  the Nth's lands), or range-limit the initial fetch to the last
  K messages (full history on scroll up). Not urgent now.


---

## Queued — designed but not started

### Nice-to-have (lower leverage, bigger effort)

- **Auto-restart opencode on `opencode-frozen`.** Needs external
  control plane (app can't reach the PowerShell launcher). Lower
  priority now that most freezes are rate-limit, not process wedge.

- **Cross-run comparison surface** — `/projects/<repo>/runs` multi-run
  diff viewer pulling from `demo-log/`. Partially unblocked by
  continuationOf — the lineage pointer gives a natural join key.

### Designed but deprioritized

- **Route C "writers-room"** (memory/project_a2a_routes.md). Deferred
  with B/D; Route A covers current needs.

---

## Validation debt

Things we shipped but haven't exercised against real runs.

- **Playwright grounding (`enableVerifierGate: true`)** — schema + code
  wired, never exercised live. Blocked on: user running the target
  repo's dev server + passing `workspaceDevUrl` on a test run. Needs
  observation of whether the planner actually uses the `[verify]`
  prefix appropriately and whether the verifier composes usable
  Playwright scripts.

- **Pattern benchmark script** — `scripts/_pattern_benchmark.mjs`
  works (syntax-checked); never invoked. ~$12 / ~1 h wall-clock for
  the default 3-pattern run.

- **Ambition-ratchet tier escalation** — tier-2 and beyond have never
  fired in anger. Today's runs stopped at tier 1 before the board
  fully drained. Needs a run that either drains naturally or has a
  short directive.

- **Non-ticker patterns (council / map-reduce / debate-judge /
  critic-loop)** — type-checked, but nobody's load-tested them on a
  real repo. Combined with the session-leak gap above.

- **Overnight-safety stack end-to-end.** 2026-04-23 runs reached
  89 % completion across 6 sessions before a Zen quota cliff.
  Zombie-abort validated (9 `[retry:N]` notes fired). What's
  missing: a full 8 h run that *doesn't* hit the quota wall at
  ~35 min, so we can see behavior across the full duration.

---

## How to use this file

**Adding:** shipped → under the current date heading; in-progress /
blocking → "Known limitations"; designed-not-built → "Queued" with
effort estimate.

**Removing:** shipped from Queued → move to Shipped; limitation fixed
→ delete (commit has the record); abandoned → move justification to
`WHAT_THIS_PROJECT_IS_NOT.md` and delete here.

**When in doubt:** durable advice → 5 durable docs. Time-scoped
("right now we have X") → here.
