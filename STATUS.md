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
reorganize) every couple months. Date each entry in the shipped section.
Known limitations and queued items live across session boundaries —
keep them current, remove items when they're shipped or explicitly
abandoned.

---

## Last updated

**2026-04-23** — after the overnight-safety + hierarchical-patterns
ship run. Next review: ~2026-06-01 or whenever this file has drifted
enough that scanning it doesn't match the actual state.

---

## Shipped

### 2026-04-23 — follow-up cleanup

- **Roster role labels** propagate to the left-sidebar roster via the
  coordinator (`063d13c`). Worker sessions now carry `info.agent={role}`
  on their assistant turns, so hierarchical runs show "orchestrator" /
  "judge" / "critic" / named roles in the roster, not default "build."
- **`scripts/prune_demo_log.mjs`** — dry-run-by-default pruner for the
  accreted demo-log directory. `--compress` gzips events.ndjson files
  ≥ 64 KB (keeps everything else in place; replay readers accept the
  .gz variant). `--delete --days N` removes run dirs older than N
  days. Requires `--yes` to actually modify.
- **Phase-aware empty-state** for the board views: deliberate-execute
  runs during their deliberation phase now read "deliberating —
  council is exchanging drafts before execution" instead of the
  blackboard-flavored "waiting for planner sweep" message. Applied
  to both the main-view `BoardFullView` and the sidebar `BoardRail`.
- **Bundle-pricing banner** on cost-dashboard: when `$ spent` is $0
  but `tokens` is > 0, a subtle note clarifies that the zero reading
  is expected for Zen subscription bundle models (`big-pickle`),
  not a broken aggregation.
- **JudgeVerdictStrip** for `debate-judge` runs. Parses the judge
  session's latest text reply for `WINNER:` / `MERGE:` / `REVISE:`;
  renders a colored strip above the composer (mint / iris / amber).
  Click jumps timeline to the verdict message.
- **CriticVerdictStrip** for `critic-loop` runs. Parses the critic
  session for `APPROVED:` / `REVISE:` + shows the worker's iteration
  counter ("round N of M"). Click jumps to the verdict message.
- **OrchestratorActionsStrip** for `orchestrator-worker` runs. Three
  canned-prompt buttons (status report · re-strategize · focus check)
  that post to session 0 with `agent='orchestrator'`. Visible only
  after the orchestrator has produced its first completed text turn
  so nudges don't race the initial planner sweep.

### 2026-04-23 — hierarchical patterns + overnight safety

**Patterns.** Retired the "no role hierarchy" stance
(`memory/feedback_no_role_hierarchy.md`). Five hierarchical patterns
shipped alongside the existing self-organizing set:

- `orchestrator-worker` — session 0 plans + re-strategizes; workers
  claim off board. `persistentSweepMinutes` accepted.
- `role-differentiated` — N workers with pinned `agent={role}`;
  `teamRoles[]` or rotated defaults.
- `critic-loop` — worker / critic 2-party loop, APPROVED / REVISE
  verdict parsing, `criticMaxIterations` cap.
- `debate-judge` — N generators + 1 judge, WINNER / MERGE / REVISE
  verdict parsing, `debateMaxRounds` cap.
- `deliberate-execute` — compositional: council rounds → synthesis
  (todowrite) → blackboard execution on the same session pool.

**Overnight-safety stack.** Diagnosed during an 8-hour run that went
dead at ~1 h of 8 h productive. Shipped:

- Zombie auto-abort in the coordinator picker (10-min threshold)
- Turn timeout raised 5 min → 10 min
- Eager re-sweep when board drains (30-s idle + 2-min MIN floor)
- Periodic planner sweep (`persistentSweepMinutes` opt)
- Opencode-frozen liveness watchdog (stops ticker with distinct reason)
- HMR-resilient module exports via globalThis stashes
- Browser `ChunkLoadError` auto-reload

**SSE plumbing.** `lib/server/sse-shaping.ts` strips redundant
`summary.diffs` patches from frames, coalesces part-update firehoses
at 250 ms per part.id, dedupes historical replay. Measured ~50 % byte
reduction on captured real runs.

**Planner prompt rewrite.** Mission-anchored instead of
verification-biased; auto-embeds workspace `README.md` (32 KB cap);
anti-pattern list ("verify X still works" banned without evidence).
Todo count raised to 6-15 with mix of sizes.

**UI polish.**
- Runs-picker SESS / CAPS column alignment fix
- Board chips show role labels on hierarchical patterns
- Collapsible `API RECIPES` block in new-run modal
- Dev tab auto-reload on ChunkLoadError with brief overlay

### Earlier (rough groupings — see `git log` for specifics)

- **Blackboard parallelism fix** (2026-04-22) — per-session tick fan-out,
  `restrictToSessionID` opt. Fixed 1-of-N sessions claiming all work.
- **Council auto-rounds** (2026-04-22) — Rounds 2 and 3 fire server-side
  after Round 1 idle; `ReconcileStrip`'s manual button still works.
- **Map-reduce v2** (earlier in April) — synthesis as a board-claimed
  todo instead of a pinned session 0 post.
- **Stigmergy v0 + v1** (earlier in April) — file-heat observation,
  heat-weighted todo picker in `tickCoordinator`.
- **Opencode port isolation** (2026-04-22) — `:4097` with separate
  `XDG_DATA_HOME` so this app's session list doesn't mix with the
  ollama-swarm sibling.

---

## Known limitations — things that work but have sharp edges

### Cost / billing

- **`costTotal` is always `0` for `big-pickle` (Zen bundle).** Working as
  intended — bundle models don't report per-token cost, and
  `lib/opencode/pricing.ts` has hardcoded zeros. Cost-dashboard now
  shows a 🏷️ banner clarifying this when `$0 spent + tokens > 0` is
  detected (shipped 2026-04-23). Per-row bundle chips in the expensive-
  runs list still not done — banner covers the summary-level optics.

### Orchestration / runtime

- **Opencode silent freeze is detectable but not auto-recoverable.** The
  liveness watchdog stops the ticker with `stopped · opencode-frozen`
  and logs a loud warning. Recovery requires a user-side opencode
  process restart — the Next.js app has no control over opencode's
  lifecycle. PowerShell launcher at `C:\Users\kevin\bin\restart-4097.ps1`.

- **Zombie threshold is a global 10 min.** Per-pattern tuning would be
  better (a critic-loop turn is legitimately shorter than a blackboard
  refactor), but 10 min is a defensible compromise.

- **HMR-resilient exports cover only three modules.** `coordinator.ts`,
  `planner.ts`, `auto-ticker.ts` propagate edits without a ticker
  restart. Other server-module edits (`opencode-server.ts`,
  `swarm-registry.ts`, pattern-specific orchestrators) still require
  a dev-server restart or ticker stop+start to take effect for in-flight
  runs. Low priority — those modules change rarely.

- **Stale session state across opencode restarts is manual cleanup.**
  An in-flight run whose opencode process died will have stuck sessions
  from its view; we don't reconcile. User workflow: stop the ticker,
  maybe fire a fresh run.

### UI

- ~~Roster doesn't label session 0 for hierarchical patterns~~ — shipped
  2026-04-23 via `063d13c`. Coordinator now tags worker prompts with
  `agent={role}`, which flows through `info.agent` into the roster.

- **Pattern-specific UI affordances — most shipped.** Coverage as of
  2026-04-23:
  - ✓ Council: ReconcileStrip (human-reconcile + manual R2)
  - ✓ Phase-aware empty-state for deliberate-execute
  - ✓ JudgeVerdictStrip for debate-judge
  - ✓ CriticVerdictStrip for critic-loop
  - ✓ OrchestratorActionsStrip for orchestrator-worker
  - Still missing: round-of-M counter for deliberate-execute DURING
    deliberation (phase state not persisted)

- **Cross-run comparisons only exist in `demo-log/` markdown.** The
  `/projects` matrix route shows activity by repo × day, but there's no
  "compare these two runs" surface. When present, comparison is a
  manual `demo-log/battle-<date>/COMPARISON.md` file.

### Infra / dev workflow

- **Dev-server restart on code edits is manual.** HMR mostly works but
  has blind spots (see above). No automation reminds the developer;
  `scripts/dev.mjs` has WATCHPACK_POLLING tuned for WSL but not
  auto-restart on server-module edits.

- **Demo-log directory grows unbounded** — partially addressed. Ships
  `scripts/prune_demo_log.mjs` (dry-run by default; `--compress` gzips
  > 64 KB events.ndjson files, `--delete --days N` removes old run
  dirs). Not on a schedule yet — run manually when disk pressure
  matters.

- **Battle test with the overnight-safety stack hasn't been re-run.** The
  2026-04-23 overnight run died pre-stack; haven't validated the stack
  end-to-end against a real 8 h run yet.

- **Smoke runner hasn't been executed against real opencode.** Ships in
  `scripts/_hierarchical_smoke.mjs`; first run blocked on confirming
  opencode is healthy after last night's freeze.

---

## Queued — designed but not started

### Next-up (high leverage, < 1 day each)

- **Remaining pattern-specific UI** (~ 2-3 h):
  - Round-of-N counter for deliberate-execute DURING deliberation
    (needs phase state persisted server-side or inferred from
    message counts)

- **Per-todo `preferredRole` routing for role-differentiated** (~ 1-2 h).
  Today roles bias self-selection via the intro prompt; the picker does
  no role routing. Add an optional `preferredRole` field on board
  items; when set, the coordinator prefers to dispatch to a session
  with that role. Natural v2 of the role-differentiated pattern.

### Nice-to-have (lower leverage, bigger effort)

- **Auto-restart opencode on `opencode-frozen` detection.** Needs an
  external control plane (the Next.js app can't reach the PowerShell
  launcher). Could ship via a local HTTP endpoint the launcher exposes
  + a client in the watchdog.

- **Per-pattern zombie / turn-timeout tuning.** Global 10-min for both
  is a compromise. Some patterns could use shorter (critic-loop turns
  should be fast) or longer (deliberate-execute synthesis can be slow).

- **Cross-run comparison surface.** First step: a `/projects/<repo>/runs`
  page with a multi-run diff viewer that pulls from `demo-log/`.

- **Cost visibility for bundle models.** A 🏷️ chip or similar on the
  runs-picker row indicating "bundle-priced, token cost is subscription-
  metered" instead of bare `$0.00`.

### Designed but deprioritized

- **Route C "writers-room" communication pattern** (from
  `memory/project_a2a_routes.md`). Deferred along with Route B
  (bounty-board) and Route D (subpoena). May never ship — Route A
  (circuit-board / typed pins) covers current needs.

- **Preset picker UX** for the new-run modal — richer tile previews,
  inline pattern descriptions. Exists as an outline in
  `SWARM_PATTERNS.md` §"Preset picker UX (future)".

- **Auto-abort opencode turn inside worker timeout.** `waitForSessionIdle`
  hits a timeout, transitions the board item to stale, but doesn't
  actively abort the opencode turn. The zombie auto-abort will catch it
  10 min later. Closing the loop directly inside the timeout path would
  save those 10 min. Small change; not prioritized.

---

## How to use this file

**Adding an item:**
- Shipped → append to "Shipped" under the right date heading, one-liner
  + link to commit or durable doc if the context matters.
- In-progress, blocking, or partially done → move to "Known limitations"
  with honest framing about what's rough.
- Designed but not built → add to "Queued" with a rough effort
  estimate.

**Removing an item:**
- Shipped item from "Queued" → move to "Shipped" under today's date.
- Limitation fixed → remove entirely (commit has the record).
- Decision to abandon something → move to `WHAT_THIS_PROJECT_IS_NOT.md`
  with the justification, delete from here.

**When in doubt:** if the entry would be durable advice to future
implementers, it belongs in one of the 5 durable docs. If it's
time-scoped ("right now we have X limitation"), it belongs here.
