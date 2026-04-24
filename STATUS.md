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

### Cost / billing

- **`costTotal` is always `0` for `big-pickle` (Zen bundle).** Working
  as intended — bundle models don't report per-token cost. Cost-
  dashboard shows banner + per-row chip when `$0 + tokens > 0` so the
  zero reading isn't mistaken for "actually free."

### Orchestration / runtime

- **"Silent freeze" ≈ Zen free-tier 429, not process wedging.** The
  liveness watchdog still stops the ticker with `stopped ·
  opencode-frozen`; distinguishing "quota burnt" from "process dead"
  is queued below. Recovery path via retry-stale works once quota
  clears.

- **Zombie threshold is global 10 min.** Per-pattern tuning is
  queued; 10 min is a defensible compromise for now.

- **HMR-resilient exports cover only 3 modules** (`coordinator.ts`,
  `planner.ts`, `auto-ticker.ts`). Other server modules
  (`opencode-server.ts`, `swarm-registry.ts`, pattern-specific
  orchestrators) need dev-server restart to pick up edits. Low
  priority — those files change rarely.

- **Ambition-ratchet tier state is in-memory only.** `currentTier`
  resets to 1 on ticker restart. If we see runs lose tier progress
  often, persist on `SwarmRunMeta` via a new `updateRun` helper.

- **Periodic-mode (`persistentSweepMinutes > 0`) skips tier
  escalation.** Those runs' auto-idle branch is disabled, so the
  ratchet never fires for them. Would need "tier up after N drained
  periodic cycles" to participate.

- **Non-ticker pattern runs leak sessions at end-of-life.** Council /
  map-reduce / debate-judge / critic-loop don't route through
  `stopAutoTicker`. Narrow window (those patterns are short-lived)
  but it's still a real gap. Small per-orchestrator hook fixes it.

### UI

- **Cross-run comparisons live only in `demo-log/` markdown.**
  `/projects` shows activity-by-repo but no "compare these two runs"
  surface.

### UI performance

- **Live run view (`/?swarmRun=<id>`) is slow to load on big runs.**
  Today's refetch throttle was a partial fix. The deeper problem:
  SSE events trigger full session-history refetches. Proper fix is
  partial SSE-merge (parse `message.part.updated` payloads and
  splice into the local buffer). Nontrivial; a known-state profiling
  pass would confirm the actual bottleneck.

- **No liveness decay when dev server vanishes.** After dev shutdown,
  an open run-view tab shows mixed state (`offline` badge correctly,
  but run-anchor "live" + blinking status circle keep rendering
  stale). React in-memory state from before the disconnect stays
  live-looking until hard-refresh. Cleaner UX: gray stale chips
  after N seconds of no SSE heartbeat.

### Infra / dev workflow

- **Dev restart on server-module edits is manual.** HMR covers client
  components and the 3 HMR-resilient server modules; others need a
  bounce. No automation reminds.

- **Demo-log retention** — pruner script exists but isn't scheduled.
  Run manually when disk pressure matters.

- **Overnight-safety stack partially validated.** 2026-04-23 runs
  reached 89 % completion across 6 sessions before a Zen quota cliff.
  Zombie-abort validated (9 `[retry:N]` notes fired). What's still
  missing: a full 8 h run that *doesn't* hit the quota wall at
  ~35 min.

---

## Queued — designed but not started

### Next-up (high leverage, < 1 day each)

- **`zen-rate-limit` vs `opencode-frozen` in the watchdog.** A probe
  that greps the opencode log for recent `statusCode":429` lines
  would let the footer show `stopped · zen-rate-limit · retry 5h`
  instead of a generic freeze. Implementation notes in
  `memory/reference_opencode_freeze.md`.

- **Non-ticker pattern session cleanup.** Council / map-reduce /
  debate-judge / critic-loop each get a small `finalizeRun()`-style
  hook that aborts worker + coordinator sessions at orchestration
  end. Closes the session-leak story across all patterns.

- **Per-todo `preferredRole` routing for role-differentiated** (~ 1-2 h).
  Today roles bias self-selection via the intro prompt; the coordinator
  picker doesn't route by role. Add an optional `preferredRole` field
  on board items + a picker bias.

- **Run chaining / continuity.** New `continuationOf?: string` field on
  `SwarmRunRequest` — a new run inherits prior workspace + prior tier +
  prior escalation history. Unlocks the "unleash a swarm on this repo
  for a week" usage pattern.

### Nice-to-have (lower leverage, bigger effort)

- **Partial SSE-merge** in `useLiveSwarmRunMessages` (deeper fix for
  the page-load slowness; today's 2 s throttle was the MVP).

- **Liveness decay chips** that gray when the SSE heartbeat stops.

- **Auto-restart opencode on `opencode-frozen`.** Needs external
  control plane (app can't reach the PowerShell launcher). Lower
  priority now that most freezes are rate-limit, not process wedge.

- **Per-pattern zombie / turn-timeout tuning.**

- **Cross-run comparison surface** — `/projects/<repo>/runs` multi-run
  diff viewer pulling from `demo-log/`.

- **Tier state persistence on `SwarmRunMeta`** — survive ticker
  restarts instead of resetting to tier 1.

- **Periodic-mode tier escalation** — "tier up after N drained
  periodic cycles."

### Designed but deprioritized

- **Route C "writers-room"** (memory/project_a2a_routes.md). Deferred
  with B/D; Route A covers current needs.

- **Preset picker UX** — richer tile previews in new-run modal.

- **Auto-abort opencode turn inside worker-timeout path.** Zombie
  auto-abort catches it 10 min later anyway.

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
