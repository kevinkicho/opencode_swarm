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

### 2026-04-24 — blackboard declared-roles Stage 2 (Auditor + contract + hard caps)

Completes the ollama-swarm spec alignment started in Stage 1. Closes
P0 gaps from the 2026-04-24 declared-roles audit: no auditor role, no
criterion contract, no "all criteria met" feedback loop, no hard-cap
enforcement. Four self-contained commits (3ffb9c9, 3cb09c0, a68d824,
this one), smoke-tested between each.

**Stage 2.1 — Criterion as BoardItemKind (3ffb9c9).**
- New `kind='criterion'` on `BoardItem`; status values reused per-kind
  (open=pending, done=met, blocked=unmet, stale=wont-do).
- `stripCriterionTag` parser for `[criterion]` content prefix;
  composes with existing tags.
- Planner prompt teaches the LLM to author 3-6 criteria at boot + add
  new ones on later sweeps (never rewrite existing ones — frozen
  contract text).
- `buildPlannerBoardContext` surfaces criteria with verdict labels
  (`[MET]` / `[UNMET]` / `[pending]`) so re-sweeps target unmet.
- UI: new diamond glyph `◆` for kind='criterion' in board-rail +
  board-preview (amber).
- Coordinator picker already filtered by kind — criteria safely
  excluded from worker dispatch without code change.

**Stage 2.2 — Auditor session + batch review (3cb09c0).**
- `lib/server/blackboard/auditor.ts` — mirror of critic.ts; per-run
  mutex; batch audit (N criteria → N verdicts in one prompt/reply).
- `auditCriteria({ swarmRunID, auditorSessionID, criteria,
  recentDoneSummaries, currentTier })` → verdicts `met|unmet|
  wont-do|unclear`.
- Opt-in `enableAuditorGate` + `auditEveryNCommits` on
  `SwarmRunRequest` + `SwarmRunMeta`. Blackboard-family only.
- Route Step 2.7 spawns dedicated auditor session at run creation;
  fail-open on spawn failure (same as critic/verifier).
- finalize-run + auto-ticker cleanup paths all abort the auditor
  session on run end.

**Stage 2.3 — Audit cadence in auto-ticker (a68d824).**
- Three triggers: every K commits (fire-and-forget), on tier
  escalation (AWAITED so verdicts are in the next sweep's prompt
  context), on run-end (fire-and-forget).
- `maybeRunAudit(state, reason)` applies verdicts via
  `transitionStatus`:
    - MET → done (from 'open'|'blocked')
    - UNMET → blocked (criteria can oscillate)
    - WONT_DO → stale
    - unclear → no transition (retry next audit)
- `TickerState`: `commitsSinceLastAudit`, `auditInFlight`,
  `auditEveryNCommits` (lazy-synced from meta).

**Stage 2.4 — Hard caps + MAX_TIER continuity (this commit).**
- User's 2026-04-24 termination precedence: ratchet wins over
  "all criteria met"; run continues until a hard cap or manual stop.
- `SwarmRunBounds` extended: `commitsCap` (default 200),
  `todosCap` (default 300). `minutesCap` already existed, now
  enforced (default 480 = 8h).
- `StopReason` gains `'hard-cap'`.
- `checkHardCaps(state)` runs on every commit (via tickSession) and
  every liveness tick (60s — catches wall-clock on quiet runs).
- `attemptTierEscalation`: MAX_TIER NO LONGER stops the ticker —
  caps `nextTier` at MAX_TIER and re-sweeps there. Subsequent
  cascades re-sweep at MAX_TIER again (throttled by
  MIN_MS_BETWEEN_SWEEPS). `tierExhausted` stays as a diagnostic
  flag but no longer feeds into any stop path.
- Deleted the `if (state.tierExhausted) stopAutoTicker('auto-idle')`
  branch from the idle-cascade tick logic.
- Route validator accepts `bounds.commitsCap` + `bounds.todosCap`
  as positive integers.

Design decisions pending (from 2026-04-24 design conversation):
- ✅ #1 Criterion shape: BoardItemKind='criterion' + free-text content
- ✅ #2 Authorship timing: refine-as-you-go (planner can add on later
       sweeps; auditor can also add; neither rewrites existing)
- ✅ #3 Termination precedence: ratchet wins; at MAX_TIER keep going
       until hard cap or manual stop
- ✅ #4 Audit cadence default: K=5; audit on tier escalation (yes);
       audit at run-end (yes)

Typecheck clean through all four commits. Smoke tests green:
- _parser_smoke.mjs         — 30 passed
- _stage1_smoke.mjs         — 20 passed
- _ollama_smoke.mjs         — 55 passed
- _team_models_smoke.mjs    — 11 passed

### 2026-04-24 — blackboard declared-roles Stage 1 (CAS hardening)

Stance revision: user rescinded "blackboard is self-organizing, no
declared roles" after practical testing with ollama-swarm. The
blackboard pattern now carries declared roles and proper CAS
protection on file claims — closer alignment with the ollama-swarm
spec that proved out in production. Stage 1 is the CAS-hardening
bundle; Stage 2 (auditor + criterion contract + hard caps) designed
separately.

- **Declared blackboard roles.** `roleNamesBySessionID` now returns
  `{session[0]: 'planner', sessions[1..N]: 'worker-<N>'}` for
  `pattern='blackboard'`. Visible in roster chips, board chips,
  tokens drill-down. NEW helper `opencodeAgentForSession` keeps
  dispatch routing scoped to hierarchical patterns only — blackboard
  roles are DISPLAY-ONLY so users aren't forced to add synthetic
  `planner` / `worker-<N>` agents to their opencode.json.
- **`expectedFiles[]` on BoardItem.** New `expected_files_json`
  column (idempotent migration); `BoardItem.expectedFiles?: string[]`
  field. Planner emits via a `[files:<path>[,<path>]]` prefix capped
  at 2 paths per todo (smaller = smaller CAS contention surface).
  Third tag in the family alongside `[verify]` and `[role:X]`;
  composes with both in spec order.
- **Planner prompt updated** with the `[files:...]` instruction block
  directly above the `[verify]` instruction. Old todos (no prefix)
  remain valid — empty expectedFiles preserves pre-Stage-1 behavior
  (no CAS protection, worker unconstrained).
- **Work prompt now scopes worker to expectedFiles** when declared.
  Adds "DO NOT edit files outside this list" section with the
  per-todo file scope so workers know the contract. Soft instruction
  today; hard CAS-drift rejection at commit makes it effectively
  binding.
- **Claim-time hash anchoring.** Coordinator reads + SHAs each
  `expectedFile` BEFORE transitioning `open → claimed`; stores
  `(path, sha)` pairs in `fileHashes`. Empty-sha sentinel marks
  files absent at claim (worker expected to create them). Todos
  without expectedFiles get `fileHashes: null` as before.
- **Commit-time CAS drift rejection.** Before the critic gate, re-
  hash every expectedFile; if any file's current hash differs from
  claim-time AND the file is NOT in this worker's edited paths,
  the commit is rejected as stale with `[cas-drift:<path>]` note.
  Self-edits (file in editedPaths) pass through — own hash changes
  are expected. Matches ollama-swarm spec's "1. Re-hash claimed
  files → reject if any changed" commit-gate step.
- **Smoke tests.** `scripts/_stage1_smoke.mjs` — 20 assertions over
  role declaration + opencodeAgentForSession + pure drift logic.
  `scripts/_parser_smoke.mjs` extended with `stripFilesTag` cases
  (+9 assertions, 25 total). All four smokes green end-to-end.

**Stage 2 (designed, not started):** Auditor role + Criterion contract
+ hard-cap enforcement (wall-clock / 200 commits / 300 todos). Design
conversation needed before code — decisions pending on contract
shape, audit cadence default, termination precedence.

### 2026-04-24 — team-picker → dispatch wiring

Made the team picker actually pin per-session models. Prior state: the
new-run-modal picker set `teamSize` but the selected models were
cosmetic — opencode used its default agent per session. Now every
session index carries its own `model` through the dispatch path.

- **`SwarmRunRequest.teamModels?: string[]`** — per-session model list,
  length === resolved teamSize. Validator enforces length; unset keeps
  current default-agent behavior.
- **`SwarmRunMeta.teamModels?: string[]`** — persisted survivor-remap.
  Partial spawn failures reindex to surviving slots before persist, so
  `meta.teamModels[j]` is always the model for `meta.sessionIDs[j]`.
- **`postSessionMessageServer({ model? })`** — gains a `model` opt
  passed as `body.model` on opencode's `/prompt_async`. When agent
  AND model are both set, opencode's agent-config takes precedence.
- **Blackboard fully wired:** `coordinator.ts::tickCoordinator` looks
  up `meta.teamModels[sessionIDs.indexOf(sessionID)]` on every worker
  dispatch. `planner.ts::runPlannerSweep` passes `meta.teamModels[0]`
  on the planner prompt; pinned model overrides the default
  `agent: 'plan'` override so "this run runs on ollama" actually
  sticks through the planner too.
- **Route directive broadcast wired:** the broadcast-directive path
  in `app/api/swarm/run/route.ts` (council / map-reduce /
  deliberate-execute) carries `teamModels[s.idx]` into each
  session's first directive.
- **new-run-modal flattens teamCounts → teamModels** via deterministic
  catalog-order iteration — counts expand to per-slot model IDs.
- **Known limitation (follow-up).** Non-ticker orchestrators' follow-up
  rounds don't yet consume `meta.teamModels`: council Rounds 2/3,
  critic-loop iterations, debate rounds, orchestrator-worker intros,
  role-differentiated post-intro dispatch. Each is a mechanical one-
  line addition (`model: meta.teamModels?.[i]` on the
  `postSessionMessageServer` call). Tracked; not blocking blackboard
  testing.
- **Smoke test:** `scripts/_team_models_smoke.mjs` — 11 assertions
  over the flatten logic + survivor remap + catalog roundtrip. Green.

### 2026-04-24 — ollama tier (three-tier reversal)

Stance reversal. `zen + go only` → `zen + go + ollama`. Motivated by
cost: opencode-go usage ceilings cap below sustained runs' needs, and
opencode-zen pay-per-token is affordable but not subscription-cheap;
ollama-max's monthly-flat shape is strictly better for hours-long
autonomous runs.

- **`Provider` union extended** to include `'ollama'`. `providerOf()`
  in `lib/opencode/transform.ts` buckets any `providerID` containing
  `ollama` into the new tier.
- **5 ollama-max models in catalog** (`lib/model-catalog.ts` +
  `lib/zen-catalog.ts`): `nemotron-3-super:cloud`, `gemma4:31b-cloud`,
  `kimi-k2.6:cloud`, `glm-5.1:cloud`, `mistral-large-3:675b-cloud`.
  All with pricing 0 (subscription-billed) and `limitTag: 'ollama max'`.
- **Pricing lookup precedence.** Ollama pattern (`/ollama[/_-]/`) lands
  first in `LOOKUP` so `ollama/kimi-k2.6:cloud` doesn't accidentally
  hit the zen `kimi-k2-6` row and get charged per-token.
- **UI surfaces extended:** `ProviderBadge`, `ProviderStats`,
  `RoutingModal` (ollama ceiling slider + dispatch-stack row),
  `RoutingBounds` (new `ollamaCeiling` field, defaults to 100 because
  subscription = no runaway). The new-run-modal + spawn-agent-modal
  pickers list the 5 ollama models via `zenModels[]` with
  `family: 'ollama'` (overloaded family marker).
- **Docs cascade:** DESIGN.md §4 + §9 rewritten with history note,
  CLAUDE.md "Never" updated, WHAT_THIS_PROJECT_IS_NOT.md's
  "multi-provider" section rewritten around the three-tier scope,
  README's design-stance bullet + Prerequisites updated,
  docs/ARCHITECTURE.md gains §1.5.0 Provider tiers block.
- **Prerequisite:** user must configure opencode's `opencode.json`
  with a provider block routing `ollama/*:cloud` IDs to ollama. The
  `github.com/kevinkicho/ollama_swarm` sibling repo is the reference
  implementation for the ollama provider shape.

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

- **Opt-in opencode auto-restart** on `stopReason: 'opencode-frozen'`.
  New `OPENCODE_RESTART_CMD` env var; when set, the frozen watchdog
  spawns it via `child_process.spawn({ shell, detached, stdio:
  'ignore' })` so the user's launcher (PowerShell, systemd, Docker
  restart) brings opencode back without human intervention. Module-
  level 10-min debounce prevents restart hammering on still-broken
  opencode. Zero-config behavior unchanged — ticker stays stopped
  when the env var is unset. `lib/server/opencode-restart.ts`.

- **Cross-run comparison surface** at `/projects/[slug]`. Repo-leaf
  slug lands on a page that lists every run targeting the workspace,
  grouped into continuation chains built from `continuationOf`
  pointers. Per-run row: pattern, status, tier (with `↗` marker for
  inherited runs), duration, tokens, cost, age. Chain header
  aggregates total tokens/cost/duration so "this lineage burned $X
  over Y hours" is visible at a glance. Existing `/projects` matrix
  rows now link through. `app/projects/[slug]/page.tsx` +
  `components/repo-runs-view.tsx`.

- **Validation runbook** at `docs/VALIDATION.md`. Consolidates every
  validation-debt item (Playwright gate, pattern benchmark, tier
  escalation, non-ticker patterns, overnight safety) with setup /
  invocation / pass-fail signals so a real-run pass can execute
  without re-deriving the plan each time. Plus `scripts/_parser_smoke.mjs`
  — 16 assertions over `stripVerifyTag` / `stripRoleTag`, run with
  `npx tsx scripts/_parser_smoke.mjs`, exits 0 on pass.

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

### Pattern reliability under GEMMA defaults (2026-04-25 validation)

Empirical findings from the 8-pattern × 60-min validation run. The
governing structural property: **patterns where work concentrates in
one critical session crash on a single silent turn; patterns where
work is parallel-redundant survive**.

**Pattern reliability tiers:**

- **Robust** — `blackboard`, `council`, `role-differentiated`
  (post-fix). Distributed work, no single point of failure. Use
  these for important runs.
- **Fragile** — `orchestrator-worker` (orchestrator critical),
  `critic-loop` (2 sessions sequential), `debate-judge` (judge
  critical). Reach partial completion (~8-12 done items) before
  F1 declares opencode-frozen.
- **Asymmetric fragility** — `map-reduce` MAP phase robust,
  REDUCE phase brittle (synthesizer reading ~30K tokens of N
  mapper drafts produces silent turns under GEMMA reliably).
- **Uniquely broken** — `deliberate-execute` reproducibly silent
  on initial deliberation directive (both fresh and replay
  spawns). Investigation queued (#66).

**Specific failure modes observed:**

1. **F1 silent-turn aborts iterative loops mid-flow.** When an
   orchestrator/critic/judge hits a silent turn, the
   `waitForSessionIdle` returns reason='silent', loop aborts,
   no recovery. Fix queued as #73 (silent-turn cascade hardening).
2. **map-reduce REDUCE single-synthesizer bottleneck.** Synth
   item bounces forever. Workaround queued as #72 (pin synth to
   stronger model).
3. **opencode silently drops POSTs with `agent` param outside
   built-ins** (build/compaction/explore/general/plan/summary/title).
   Returns HTTP 204 but never persists. 4 patterns silently broken
   for unknown duration before fix on 2026-04-25 (commits 0c79175 +
   23a21f7). See `docs/POSTMORTEMS/2026-04-25-agent-name-silent-drop.md`
   when written (#69).

Pattern reliability is captured in `memory/reference_pattern_reliability_ranking.md`
for cross-session use. When picking a pattern for a real run, prefer
the robust tier unless the work specifically benefits from a fragile
shape (debate divergence, critic iteration).

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

### Closed since this section was last revised (audit 2026-04-25)

The audit found six items in this list that had silently shipped without
the doc catching up. Removed from the "Next-up" block below; recording
here so anyone re-reading old context knows what landed:

- Lane meter `out — in —` fallback → SHIPPED (transform.ts emits
  `tokensIn` / `tokensOut`; swarm-timeline.tsx LaneMeter falls back to
  `compact(tokensOut)` when both rates are zero)
- `latest ↓` 4-phase synchronous snap → SHIPPED (`scroll-to-bottom.tsx`
  uses sync + rAF + 120 ms + 400 ms passes)
- Auto-ticker startup-cleanup recent-activity guard → SHIPPED
  (`STARTUP_CLEANUP_RECENT_ACTIVITY_MS` skip + `skippedAlive` log)
- board/ticker `stopReason` SQLite persistence → SHIPPED as
  PATTERN_DESIGN/blackboard.md I3 (`persistTickerSnapshot` /
  `readTickerSnapshot`)
- Tokens endpoint `lastActivityTs` zombie-threshold guard → SHIPPED
  (`deriveSessionStatus` user-trailing branch checks
  `ZOMBIE_THRESHOLD_MS`)
- `item.note` retry chip on board rows → SHIPPED (board-rail.tsx
  surfaces `retried Nx` chip with note tooltip)

Pattern-design ledgers (PATTERN_DESIGN/*.md) for the per-pattern tabs +
mechanics gaps are also nearly fully closed: only map-reduce I1
(synthesis-critic gate), role-differentiated I4 (per-role token
budgets), and stigmergy heat-picked-timeline-chip remain PROPOSED — all
need a live run to validate before shipping.

### Next-up (high leverage, < 1 day each)

- **Cold-load 30s+ delay on first navigation in dev (artifact, not
  bug).** Next.js compiles each route + each lazy modal chunk on the
  first request, serially. Measured 27s per modal chunk, ~38s
  user-perceived "first populated data" in dev (perf:cold benchmark
  2026-04-24). NOT a real performance problem — `npm run prod`
  serves all pre-compiled chunks in <1s. Documented for future-me
  who'll wonder why dev feels slow.

- **30-minute project review checklist** (`docs/REVIEW_CHECKLIST.md`)
  — structured walkthrough of every major surface in 7 phases. Run
  this whenever bugs feel like they're piling up; capture findings
  as new entries here. First run not yet completed.

- **Dev wrapper SIGTERM 143 → SHIPPED 2026-04-25.** The
  `npm run dev` wrapper would survive after next-server died,
  hanging in the task tracker. Root cause: dev.mjs's signal
  handlers called `killGroup(signal)` but never scheduled an
  exit fallback — if `killGroup` failed, throws, or the child was
  already dead before our SIGCHLD landed, `child.on('exit')` would
  never fire and dev.mjs would wait forever. Fix: shutdown handler
  now schedules a 5s force-exit timeout (.unref() so it doesn't
  block clean shutdowns); double-signal protected via
  `shutdownInFlight` flag.

- **Heat tab: file-tree toggle (VSCode-style).** Button in the heat-rail
  header flips between the current heat-list view and a tree view of
  the workspace files. Files in the tree show heat chips (edit counts)
  so the value add over the list is "navigate by structure instead of
  by heat score." Click a file → same file-heat inspector opens. Shape
  A from the 2026-04-24 design exchange. Needs `GET /api/swarm/run/:id/tree`
  (or a workspace-scoped variant) for the filesystem enumeration,
  gitignore-aware, short cache. ~2-3 h scope.

- **Run-health surfacing (2026-04-24 audit) — 4 of 5 sub-items shipped.**
  Audit found 5 places the app masked opencode signals. The ones
  shipped are listed in the "Closed since this section was last
  revised" block above (lastActivityTs zombie-threshold guard,
  persistTickerSnapshot, item.note retry chip, deriveSilentSessions).
  All 5 sub-items are now closed:
  - **Retry-exhausted → ticker stalls without re-kick** → SHIPPED
    (audit 2026-04-25). Coordinator picker now filters
    `[retry:N≥MAX_STALE_RETRIES]` opens out of the candidate queue —
    matches the predicate the periodic-sweep path (auto-ticker.ts
    ~L1252) already uses for the ambition-ratchet drained-board
    check. Before this fix the standard auto-idle path saw twice-
    refused items as active work and the ratchet stayed dormant
    indefinitely (run_mob31bx6_jzdfs2 stranded at 22.33M).

- **Nemotron-through-opencode → GEMMA across all 6 default seats.**
  Two retests 2026-04-25 with `--log-level DEBUG` reproduced a
  step-loop cost behaviour that affects every nemotron seat in
  opencode's wrapper:
  1. **run_modx3mv5_cpwh93** (orchestrator-worker): 18 turns in
     200s, each calling `todowrite` and re-emitting the same 10
     items, board never seeded.
  2. **run_modxga1j_kh4j8k** (council, 3 nemotron drafters): real
     output produced (drafts were good) but in 20+ tiny step-finish
     turns per session, each re-reading 47K input tokens to emit
     ~150 output tokens — **~50× more expensive than necessary**
     for a 3-sentence directive.
  Same root cause: opencode's wrapper handling of step-tool-step
  loops on nemotron specifically. Direct ollama `/api/generate` +
  `/v1/chat/completions` work normally for the same model.
  Swapped NEMOTRON → GEMMA in `patternDefaults` for orchestrator-
  worker, council, map-reduce, role-differentiated, debate-judge,
  and deliberate-execute. The `auditorModel: NEMOTRON` on the
  blackboard pattern's optional auditor gate is left — non-default,
  user-opted-in, distinct role from drafting/planning seats.

### Designed but deprioritized

- **Route C "writers-room"** (memory/project_a2a_routes.md). Deferred
  with B/D; Route A covers current needs.

---

## Validation debt

Things we shipped but haven't exercised against real runs. See
`docs/VALIDATION.md` for the per-item runbook (setup / invocation /
pass-fail signals).

**Audit 2026-04-25 partial coverage:**
- Council pattern partially exercised in run_modxga1j_kh4j8k
  during the nemotron retest above — drafts produced correctly,
  per-member content scaled to teamSize=3. Cost was the bottleneck,
  not correctness. After the GEMMA swap a fresh council run
  should validate at <10× the prior cost; not yet re-run.
- Other validation areas (Playwright grounding, pattern benchmark,
  ambition-ratchet tier-2+, overnight-safety stack) all need
  dedicated runs that cost real money. Each is documented in
  VALIDATION.md with the exact curl invocation; ready to fire
  when someone wants to spend the budget.

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
