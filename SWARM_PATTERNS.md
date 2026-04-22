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

### 1. Blackboard `[~]` — first real implementation target

> **Status 2026-04-21.** SQLite board store + HTTP API + live preview wired.
> `/api/swarm/run/:id/board` (list + create) and `/api/swarm/run/:id/board/:itemId`
> (claim / start / commit / block / unblock) both ship, with commit-time SHA
> re-read for drift detection landing the item in `stale` when the workspace
> moved under the claim. `/board-preview?swarmRun=<id>` polls the live board
> at 2s cadence; MOCK_BOARD stays as the design-time showcase path.
> CAS verified by `scripts/_blackboard_smoke.mjs` (store-layer) and
> `scripts/_board_api_smoke.mjs` (HTTP round-trip). Still unwritten:
> coordinator loop that posts claim-prompts to idle sessions, SSE mux across
> N sessions for the board view. `pattern='blackboard'` still returns 501
> until the coordinator lands — runs created through it would spawn sessions
> with nothing driving them.


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

### 2. Stigmergy / pheromone trails `[ ]`

Agents leave confidence/interest scores on files they edit. Other agents
prefer unexplored or contentious files. Zero-coordinator emergence —
self-organized repo coverage without a planner.

**opencode fit.** A projection over `file.edited` counts and
`info.agent` annotations, rendered as a heatmap overlay on the tree or
the timeline. Read-only from the human's side, like observed dispatch
(§4.2) — never an assignment, always an observation.

**Layering.** Stigmergy is an additional signal a blackboard worker uses
to pick its next todo. It extends #1, not a separate preset.

### 3. Map-reduce over the repo `[ ]`

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
> click-to-focus pills — observation + selection only, no auto-accept.
> Real reconcile *actions* (forward accepted draft back to opencode,
> clipboard copy, Round 2 fan-out) are not yet wired.

Round 1: N agents answer the seed independently with no shared
transcript. Round 2: drafts are revealed, agents revise or vote. The
value is in Round 1's forced independence.

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

## Patterns explicitly rejected

These are role-pinning shapes. See `WHAT_THIS_PROJECT_IS_NOT.md` "Not a
role-assigning system" and DESIGN.md §1 / §9 before attempting any.

### Role differentiation `[✗]`

Prescribed system prompts per agent — architect / tester /
security-reviewer / … pinned at spawn. This is the exact
"orchestrator / architect / coder / reviewer" prescription the project
rejects. If you want diversity of perspective, use **Council #4** —
independent drafts without role pinning beat role-prescribed drafts
empirically, and leave the project stance intact.

### Orchestrator–worker hierarchy `[✗]`

One "lead" agent plans and dispatches to workers. User framed as
"reproduction of master-slave dialectic" (see
`memory/feedback_no_role_hierarchy.md`). The related inferred-shape
variant ("planner-shaped" readouts) was also removed from an earlier
DESIGN.md draft. If you want *parallelism with one planner*, use
**Map-reduce #3** — the planner is a phase, not a pinned agent.

### Debate + judge `[✗]`

Two agents argue opposite positions, a judge scores. The judge is a
pinned evaluator role. Use **Council #4** with human reconcile via the
permission strip if you need a binary decision surface.

### Critic / evaluator / Reflexion loops `[✗]`

Worker → critic → worker revise. The critic is a pinned reviewer role.
The same feedback loop runs without pinning inside **Blackboard #1**:
any idle agent can claim a `review` todo posted by the worker — the
reviewer emerges from who's free, not from a role slot.

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
  instance run concurrently? Probe before committing a `teamSize` bound
  range in the UI.

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
| 2 | `blackboard`  | `[~]`  | Store + HTTP API + live preview shipped; coordinator loop + SSE mux remain    |
| 3 | `map-reduce`  | `[ ]`  | Reuses blackboard's mux; synthesize phase claimed from the board, not pinned  |
| 4 | Stigmergy     | `[ ]`  | Layer on blackboard — pheromone scoring as a signal, not a separate preset   |

Critic loops, debate, orchestrator-worker, and role differentiation are
**not on this roadmap**. If someone pushes for them, point at DESIGN.md §9
and this file's rejected list.
