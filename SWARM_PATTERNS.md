# Swarm Pattern Catalog

Orchestration patterns we can support in `opencode_swarm`, stated in
opencode's native vocabulary and filtered through the project's
no-role-hierarchy stance.

**Read alongside:**
- `DESIGN.md` §1 "On roles", §4.2 "Dispatch philosophy", §9 "Decisions already made"
- `WHAT_THIS_PROJECT_IS_NOT.md` — "Not a role-assigning system", "Not an imperative routing panel"
- `docs/opencode-vocabulary.md` — canonical primitives (`task`, `subtask`, `todowrite`, `info.agent`, `session.diff`)

**Status legend:**
- `[x]` shipped — a run can be driven this way today
- `[~]` in progress — partial wiring
- `[ ]` designed, no code
- `[✗]` rejected — see `WHAT_THIS_PROJECT_IS_NOT.md` before reviving

---

## Baseline — opencode's native model (one session per run)

A run today is **one opencode session**. `info.agent` discriminates who
spoke. When the lead agent calls the `task` tool, opencode spawns a
sub-agent whose parts stream back into the same session tagged with a
different `agent` name. The UI reflects this 1:1:

- Roster entries = distinct `info.agent` names in the session
- Timeline wires = `task` → `subtask` → follow-up parts
- Plan rail = `todowrite` writes (see DESIGN.md §8)
- Cross-session coordination = none; a run is a session

This is not a "pattern" from the list below — it's the floor. Every
pattern below either runs inside one session using opencode's native A2A,
or requires a coordinator layer above opencode that groups multiple
sessions into one logical run.

---

## Patterns compatible with the project stance

### 1. Blackboard `[x]` — first real implementation target

> **Status 2026-04-22.** Validated end-to-end against a real repo
> (`kBioIntelBrowser04052026`) after the planner-sweep triad fix
> (abort-on-timeout + 5-min deadline + todowrite-first prompt — commit
> `05d2fbe`). A trailing-newline smoke (`run_moaayofk_lvd5br`) produced
> 7 todos, drained all 7 to done in 171s, and committed 403 file edits
> to the workspace (git confirmed exact file-count match). Planner-sweep
> regression fixed: prior attempt burned 5M tokens on 79 orphan turns
> after a 90s timeout left the session uncancelled — now `runPlannerSweep`
> always calls `abortSessionServer` on timeout and forces todowrite as
> the first tool call. **Parallelism fix shipped same day:** pre-fix,
> `auto-ticker.ts` ran ONE ticker per run with an `inFlight` guard and
> `tickCoordinator` awaited `waitForSessionIdle` (5+ min) before
> returning — so only one claim was in flight at any moment, and session 2
> sat idle in every smoke. Replaced with per-session tick fan-out
> (per-session slots, `restrictToSessionID` opt in `tickCoordinator`).
> Validated by `scripts/_blackboard_parallelism_watch.mjs` on
> `run_moachkl8_axhpxe`: 8 todos drained in 121s with work split 5/3
> across sessions and max concurrent owners = 2 observed at multiple polls.
>
> **Status 2026-04-21.** Coordinator loop end-to-end: SQLite board store,
> HTTP API, live preview, planner sweep (3a), per-tick claim-and-work
> (3b + 3c), and auto-ticker with idle auto-stop (3d) all wired.
> `POST /api/swarm/run` now accepts `pattern='blackboard'` — on create it
> spawns N sessions, fires a background `runPlannerSweep`, and once the
> board has items, starts a 10s-cadence auto-ticker (`startAutoTicker`)
> that calls `tickCoordinator` with an in-flight re-entrancy guard and
> auto-stops after 6 consecutive idle ticks. `/board-preview?swarmRun=<id>`
> still polls the live board at 2s cadence. **UI reachable 2026-04-21:**
> blackboard tile is selectable in new-run-modal, and the topbar run-anchor
> popover renders the pattern as a direct link to the board view when
> `meta.pattern === 'blackboard'`. **Inline rail shipped 2026-04-21:**
> `components/board-rail.tsx` renders as a third tab in `LeftTabs`
> (visible only when `meta.pattern === 'blackboard'`), grouping items by
> status with a collapsible `done` section; shares polling with
> `/board-preview` via `lib/blackboard/live.ts::useLiveBoard`. CAS +
> drift verified by `scripts/_blackboard_smoke.mjs` and
> `scripts/_board_api_smoke.mjs`; coordinator pipeline verified by
> driving `POST /board/tick` manually before wiring the auto-ticker;
> end-to-end (create → sweep → ticker → done) verified by
> `scripts/_blackboard_e2e_watch.mjs`. **Ticker-state surface shipped
> 2026-04-21:** the rail footer shows `ticker · running` / `idle N/6`
> (tone escalates to amber past ⅔ of the idle threshold) / `stopped ·
> auto-idle|manual` with an inline `restart` action, backed by `GET`/`POST
> /api/swarm/run/:id/board/ticker` and the shared `useLiveTicker` hook in
> `lib/blackboard/live.ts`. **Board-event SSE shipped 2026-04-22:** new
> endpoint at `GET /api/swarm/run/:id/board/events` streams a
> `board.snapshot` handshake + `board.item.inserted` / `board.item.updated`
> deltas; mutations emit via a process-local bus in
> `lib/server/blackboard/bus.ts` that the store fires from inside
> `insertBoardItem` / `transitionStatus`. `useLiveBoard` swapped from 2s
> polling to EventSource; claim→in-progress transitions now land in the
> rail within one round-trip instead of up to two seconds.


Agents post `claim`, `question`, `todo`, `finding` items to a shared board
keyed to one run. Any idle agent can pick up any unresolved item. No
turn-taking, no coordinator, no pinned role — the board is the only
shared state.

**opencode fit.** The board is a projection over `todowrite` writes plus
`info.agent` deltas across concurrently running sessions. Claims are
`todo.ownerAgentId` writes (DESIGN.md §8.3); findings are completed
`todowrite` items. The canonical A2A primitive is still opencode's `task`
tool — the board coordinates *which session claims which todo*, not how
agents talk inside a session.

**Coordination stack for v1:** optimistic + CAS + re-plan, layered over
small atomic units.

- *Optimistic + CAS.* Each claim records the SHA of the files it intends
  to touch. At commit time the board rejects overwrites where any touched
  file changed underneath; the todo goes back on the board tagged
  `stale_since=<sha>` and gets re-planned before it's reclaimable. Mirrors
  MVCC / `git rebase`. Chosen over pessimistic file locks because locks
  head-of-line-block on shared utility files.
- *Small atomic units.* Todos stay tiny ("extract function X from file
  Y"). After every commit the planner sweeps and regenerates the
  remaining todos from current code state. Staleness barely exists
  because no plan lives long enough to rot. This is the closest
  architecturally honest approximation of stigmergic behavior.

### 2. Stigmergy / pheromone trails `[x]`

> **Status 2026-04-22 (v1 shipped).** `tickCoordinator` in
> `lib/server/blackboard/coordinator.ts` now sorts open todos by
> heat-score (ascending — exploratory bias), tiebreak on oldest
> `createdAtMs`. `scoreTodoByHeat` sums edit counts across every
> `FileHeat` entry whose path or basename appears in the todo's
> content: full-path matches count double, basename-only (length ≥ 4)
> matches count single. Todos with no file attribution score 0 and
> fall back to the oldest-first order — the degenerate case preserves
> pre-stigmergy behavior exactly. Coordinator logs
> `[coordinator] heat-weighted pick: "..."` only when heat actually
> shifted the pick order (score spread > 0), otherwise silent.
>
> v1 reuses the v0 observability substrate: `toFileHeat` is invoked
> inside the tick, fed by the same session-message fetches the
> busy-check already needed, so the incremental per-tick cost is
> just the merge + score pass.
>
> **Status 2026-04-22 (v0 shipped earlier).** Observability
> substrate — a `heat` tab in `LeftTabs` (visible when ≥1 file has
> been touched) aggregates patch parts into per-file edit counts +
> distinct-session counts + last-touched timestamps. Read-only per
> DESIGN.md §4.2: the rail reports convergence, never enables
> reassignment.

Agents leave confidence/interest scores on files they edit. Other agents
prefer unexplored or contentious files. Zero-coordinator emergence —
self-organized repo coverage without a planner.

**opencode fit.** A projection over `file.edited` counts and
`info.agent` annotations, rendered as a heatmap overlay on the tree or
the timeline. Read-only from the human's side, like observed dispatch
(§4.2) — never an assignment, always an observation.

**Layering.** Stigmergy is an additional signal a blackboard worker uses
to pick its next todo. It extends #1, not a separate preset.

### 3. Map-reduce over the repo `[x]`

> **Status 2026-04-22 (v2).** Synthesis phase now routes through a
> **blackboard-claim** instead of a pinned `sessionIDs[0]` post. Once the
> map phase idles and drafts are harvested, `runMapReduceSynthesis`
> inserts a single `synthesize` board item (deterministic id
> `synth_<swarmRunID>` for idempotency; `content` = full synthesis
> prompt with every member draft embedded), then loops `tickCoordinator`
> every 3s against a 5-minute dispatch deadline. The coordinator picks
> the first idle session (no claimed/in-progress board items, no
> in-flight assistant turn), CAS-claims the item open → claimed →
> in-progress, posts the prompt verbatim (`buildWorkPrompt` branches on
> `item.kind === 'synthesize'` to skip the blackboard-edit preamble),
> waits for the session to idle, and transitions to done. Key wiring:
> `BoardItemKind` extended with `'synthesize'` in
> `lib/blackboard/types.ts`; picker in
> `lib/server/blackboard/coordinator.ts::tickCoordinator` accepts
> synthesize items alongside todos and questions. Outcome: which session
> ran synthesis is observable from the board (ownerAgentId +
> completedAtMs), not hidden as dispatcher-state; a double-firing of
> `runMapReduceSynthesis` produces exactly one item + one claim; and the
> synthesis strip's detection heuristic is unchanged because the ticker
> posts `item.content` verbatim — which still starts with the literal
> `"Map-reduce synthesis phase."` prefix the strip matches on. Smoke:
> `scripts/_mapreduce_v2_smoke.mjs`.
>
> **Status 2026-04-21 (v1, superseded).** Shipped end-to-end: `POST
> /api/swarm/run` accepts `pattern='map-reduce'` and, on create, derives
> top-level directory slices (`lib/server/map-reduce.ts::deriveSlices`)
> — one per session, padded with `(whole workspace)` when the repo has
> fewer dirs than sessions, comma-joined round-robin when it has more.
> Each session gets the same base directive plus its own scope
> annotation (`buildScopedDirective`). Route fires a background
> `runMapReduceSynthesis` that waits for every session to idle (25-min
> per-session deadline, skipping any that time out), harvests each
> member's latest completed assistant text, and posts a synthesis prompt
> to `sessionIDs[0]` embedding every sibling draft. UI-side,
> `components/synthesis-strip.tsx` renders above the composer for
> `pattern='map-reduce'` runs and surfaces: per-member draft pills,
> `map N/N` progress, `awaiting synthesis` / `synthesizing…` / `synthesis
> ready`, and an `open synthesis →` jump when the merged output lands.
> Kept for historical context — v2 preserves every behavior except the
> `sessionIDs[0]` pin.

Each agent takes a disjoint slice of the tree with no shared transcript,
produces a report on its slice, then a synthesis phase unifies the
reports.

**Reframe for this project.** The synthesizer is **not a role**. It's a
**phase** — any session in the swarm claims the `synthesize` todo when
it lands on the board. In the UI the synthesis step looks like any other
claim; which agent ran it is observable, not prescribed. This is what
keeps map-reduce inside §1 / §9.

**opencode fit.** Split phase = N parallel sessions each scoped to a
subtree (distinct seed directives). Reduce phase = one board-claimed
synthesis todo that reads each session's `session.diff` and produces the
unified output.

### 4. Council — parallel drafts + reconcile `[x]`

> **Status 2026-04-21.** Shipped end-to-end: `POST /api/swarm/run` accepts
> `pattern='council'` with teamSize 2–8, fans out to N seed-identical
> opencode sessions, aggregates status / tokens / cost across slots,
> multiplexes a single workspace-scoped SSE stream, and rekeys the agent
> transform on sessionID so council members don't collide under one
> agent-config name. The run view merges every slot's messages into one
> chronological transcript; reconcile is surfaced as a read-only iris
> strip above the composer (`ReconcileStrip`) showing `N / N drafts` with
> click-to-focus pills. **Reconcile actions shipped 2026-04-21:** focusing
> a draft enables `copy` (clipboard) and `forward →` (fan-outs a
> ratification of that draft to every council session); `↻ round 2`
> fan-outs a revise-or-accept prompt with every Round-1 draft embedded.
> All three are fired via the existing `postSessionMessageBrowser`
> primitive (serial loop over `sessionIDs` so cost-cap rejections bail
> cleanly on the first failure).

Round 1: N agents answer the seed independently with no shared
transcript. Round 2+: drafts are revealed, agents revise, converge, or
flag hard disagreements.

**Auto-rounds (shipped 2026-04-22).** Council now runs Rounds 2 and 3
automatically via `lib/server/council.ts::runCouncilRounds`, kicked off
as a background task from `POST /api/swarm/run` when `pattern='council'`.
On every round boundary the orchestrator waits for every session to hit
idle, harvests each member's latest assistant text as that member's
draft, then fans a Round-(N+1) prompt embedding every draft to every
session. Round 2 uses the same wording as the existing `ReconcileStrip`
manual action (so an agent can't tell whether the round was human- or
auto-triggered); Round 3 explicitly asks for convergence or flagged
disagreements. Default `maxRounds = 3` — configurable later via request
body / bounds. The `ReconcileStrip` manual `↻ round 2` button is still
wired and can fire additional rounds on top if a human wants more
deliberation than the auto-cadence provides.

**Why this isn't a supervisor.** A phase transition in the protocol is
not a pinned role. Every council member does the same thing every round
(read peers, respond); no agent watches or redirects another. This
matches map-reduce's auto-synthesis phase, which shipped earlier and
sets the same precedent. What we still reject: agent-managing-agent
shapes (see `Orchestrator–worker hierarchy` in the rejected list).

**Reframe for this project.** The reconcile step is **not a judge
role**. V1 options, none of which pin a role:
- Majority vote over token-level or AST-level diff
- Semantic merge (run the diffs through `session.diff` and pick the
  overlap)
- **Human reconcile via the permission strip** — cheapest for v1 since
  the plumbing already exists (this is what `ReconcileStrip` does today)

**opencode fit.** N parallel sessions with the same seed directive;
reconcile = a board-claimed `reconcile` todo or a permission prompt to
the human.

---

## Hierarchical patterns

> **Status 2026-04-23.** The prior stance — "these are role-pinning shapes
> and therefore rejected" — was superseded at the user's direction. All
> four patterns below are legitimate design choices for runs whose work
> benefits from explicit role structure. See DESIGN.md §1 "On roles" and
> `memory/feedback_no_role_hierarchy.md` for the rationale. Implementation
> status ranges from `[ ]` designed-but-not-built through `[~]` partial to
> `[x]` shipped.

### 5. Orchestrator–worker `[~]` — pilot for the hierarchical branch

One "orchestrator" session plans + dispatches; N worker sessions claim
and implement. Shares the blackboard's board-store + ticker machinery;
the only structural difference is a pinned planner role (session 0) and
a worker-only dispatch picker (sessions 1..N). The human can message
the orchestrator directly to re-strategize mid-run — workers don't
receive direct prompts.

Why this shape: long-running missions with a clear "mind-vs-hands" split
benefit from a single reasoning surface owning the strategic layer while
workers focus on focused execution. The 2026-04-23 overnight run
diagnosed this gap — the blackboard's autonomous planner-sweep pass
produced competent-but-unambitious todos because nobody owned the
mission the way a persistent orchestrator would.

**opencode fit.** N+1 sessions under one run. Session 0 seeded with an
orchestrator prompt that explains its authority + the worker roster.
Workers dispatched via the same board-claim mechanics as blackboard.

### 6. Role differentiation `[ ]`

Prescribed system prompts per agent — architect, tester,
security-reviewer, ux, data-modeler, etc. Each worker session carries a
pinned role that shapes its self-introduction and biases what kinds of
todos it prefers to claim. Board items can optionally be tagged with
preferred roles (`role: 'tester'`) so the picker routes accordingly.

Good fit when the work has clear sub-disciplines (frontend/backend,
code/docs/tests). Less useful on uniformly-shaped work where every
agent needs the same toolset.

### 7. Debate + judge `[ ]`

Two or more generator sessions produce competing answers; one judge
session evaluates and selects / merges / rejects. Extends the Council
pattern by adding a decision surface instead of leaving reconcile to
the human. Useful for binary or scored decisions where the quality
signal is legible (choosing between two refactor approaches, picking
an API shape).

The judge role MUST be visible — users need to know which session is
arbitrating. Consider surfacing the judge's rationale as a `reconcile`
item on the board so the decision audit-trails.

### 8. Critic / Reflexion loops `[ ]`

Worker produces a draft → pinned critic reviews → worker revises. N
iterations. The critic is stable across the run (same session each
time) so its feedback accrues context — it's not just a one-shot review.

Trade-off: can loop indefinitely if the critic's bar is unclear.
Always set a max-iterations cap (e.g. 3) and a "ship current draft"
fallback. Best on outputs where quality is non-binary — essays,
architectural decisions, UX copy — and a human wouldn't obviously spot
the right answer on first pass.

### 9. Deliberate → Execute `[ ]` (compositional)

Council phase 1 for divergent drafts → council phase 2 for convergence
→ automatic handoff to a blackboard phase for execution. The
handoff extracts concrete work items from the converged drafts and
seeds a blackboard board; workers then drain them.

Good fit for "think deeply, then build" missions where the initial
framing matters more than implementation speed. Higher token cost than
straight blackboard.

---

## Historical note: patterns once explicitly rejected

Up through 2026-04-22, the four hierarchical patterns above (orchestrator-
worker, role differentiation, debate+judge, critic loops) were listed
here as `[✗]` with rationale tied to the "no supervisor-worker dialectic"
stance. The stance was reversed 2026-04-23; the patterns moved up into
the main catalog. If you find a reference to the rejected list in older
docs or code comments, it's stale — the stance no longer forbids these
shapes.

---

## Preset picker UX (future)

`components/new-run-modal.tsx` today takes source (required) + directive
(optional) + team (optional). A pattern picker would be a fourth field:

| Preset       | Extra knobs                        | Backend needs                      |
|--------------|------------------------------------|------------------------------------|
| `none`       | none                               | none — opencode native             |
| `blackboard` | none at v1                         | board store + multi-session mux    |
| `map-reduce` | tree-slicing strategy              | split-phase + `synthesize` todo    |
| `council`    | round count + reconcile policy     | N seed-identical sessions + vote   |

**Do not add** a "role slots" editor, a "lead model" override, a "judge
model" picker, or any per-agent role-keyed routing — every one of these
violates §1 / §9.

**Advanced knobs** (atomic-unit size, re-plan interval, stale-retry
limit, max concurrent agents) live in the **routing modal** since they
are *bounds*, not *assignments*. They apply run-wide, not per agent.

---

## Backend gap — what "create backend" actually means

Everything above except the baseline needs a coordinator running **above**
opencode. opencode orchestrates inside one session (via `task`); our
swarm patterns span multiple sessions. Missing pieces:

1. **`/api/swarm/run` endpoint.** Accepts
   `{ source, pattern, directive?, teamSize }`; returns a `swarmRunID`.
2. ~~**Server-side state store** for the blackboard — todos, claims, file
   hashes. SQLite vs. per-run JSON is an open question~~ **Done 2026-04-21:**
   SQLite at `.opencode_swarm/blackboard.sqlite`, schema + CRUD + atomic
   CAS transitions in `lib/server/blackboard/`.
3. **SSE multiplexer.** Unions events across the N child sessions into
   one event stream keyed by `swarmRunID`. The existing single-session
   SSE subscriber (`lib/opencode/live.ts`) is the model.
4. **Agent-abstraction translator.** In single-session mode an "agent"
   is one `info.agent` bucket; in multi-session presets an "agent" is
   one child session. The UI should keep the same `Agent` type — the
   coordinator maps sessions to `Agent.id` before the UI sees them.

See DESIGN.md §6 Phase 2 for where this slots into the roadmap.

---

## Open questions

- ~~**Persistence.** Blackboard claims must survive a server restart so
  in-flight work isn't orphaned. SQLite, flat JSON, or an opencode
  extension hook?~~ **Resolved 2026-04-21:** SQLite at
  `.opencode_swarm/blackboard.sqlite` — separate file from `memory.sqlite`
  because board state is authoritative (claims can't be regenerated from
  events.ndjson) while memory is derived. Schema + store at
  `lib/server/blackboard/`.
- **Run-view transcript.** The UI is timeline-first (DESIGN.md §2).
  Blackboard wants a board view; map-reduce wants a tree view. Likely a
  per-preset renderer over the same event stream, not separate screens.
- **Cross-preset metrics.** To compare presets we need wall-clock, token
  cost, and a quality proxy (tests green, diff size, `session.diff`
  conflict rate). Decide before shipping preset #2.
- **Parallel-session ceiling.** How many opencode sessions can one
  instance run concurrently? 2026-04-22 parallelism fix unblocks probing
  — floor is now N-session throughput, ceiling is unknown. Probe before
  committing a `teamSize` bound range in the UI.
- ~~**Blackboard parallelism.**~~ **Resolved 2026-04-22.** Pre-fix
  symptom: `auto-ticker.ts` ran one run-scoped ticker with an `inFlight`
  re-entrancy guard; `tickCoordinator` blocked inside the tick awaiting
  `waitForSessionIdle` (5-min deadline); the picker's "first idle session
  wins" bias locked the same session every tick. Session 2 in 2-session
  runs sat idle through every smoke run. **Fix:** per-session tick
  fan-out — `tickCoordinator` accepts `restrictToSessionID`; the ticker
  maintains a per-session slot map with its own `inFlight` + `consecutiveIdle`
  and `void tickSession(...)`s every slot per interval fire; auto-stop
  fires only when every slot has been idle for the threshold. CAS at the
  store layer handles todo-claim races (loser records `skipped: claim
  lost race` and retries next tick). Snapshot rollup (`inFlight` = any
  in-flight slot, `consecutiveIdle` = min across slots) keeps the UI
  contract unchanged. Validated by `scripts/_blackboard_parallelism_watch.mjs`
  against `kBioIntelBrowser04052026`: `run_moachkl8_axhpxe` drained 8
  todos in 121s with work split 5/3 across sessions; max concurrent
  owners=2 observed at multiple polls.

---

## Roadmap

Ordering changed in practice: council shipped first because the multi-
session mux it required (workspace-scoped SSE, sessionID-keyed agent
transform, registry aggregation across N slots) is strictly a subset of
what blackboard needs. Building council first meant the heavy lifts
landed against a pattern with simpler semantics.

| # | Preset        | Status | Notes                                                                          |
|---|---------------|--------|--------------------------------------------------------------------------------|
| 1 | `council`     | `[x]`  | Multi-session mux + reconcile strip; served as the scaffolding for #2/#3      |
| 2 | `blackboard`  | `[x]`  | Store + HTTP API + live preview + coordinator + auto-ticker (per-session fan-out) + UI picker + inline rail + ticker-state surface + board-event SSE (2026-04-22); 403-file end-to-end and parallelism both validated 2026-04-22 |
| 3 | `map-reduce`  | `[x]`  | v1: auto-slice + scoped directives + background synthesis + synthesis-strip. v2: synthesis routed via blackboard-claim (`synthesize` kind) with deterministic idempotent item id, replacing the `sessionIDs[0]` pin |
| 4 | Stigmergy     | `[x]`  | v0 (observability): per-file edit counts surfaced as `heat` tab in LeftTabs (2026-04-22). v1 (picker weighting in `tickCoordinator` — exploratory bias + oldest tiebreak) shipped 2026-04-22. |

Critic loops, debate, orchestrator-worker, and role differentiation are
**not on this roadmap**. If someone pushes for them, point at DESIGN.md §9
and this file's rejected list.
