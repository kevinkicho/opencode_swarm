# DESIGN.md

Vision, mental model, UI contracts, and backend wiring for `opencode_swarm`.
Single source of truth for *why* the UI is shaped the way it is. Read before
extending the runtime surface or adding a new panel.

---

## 1. Vision

Run opencode as a **swarm**, not a single chat. Multiple agents work in
parallel against one run, free to delegate, research, patch, and review as
the work demands. Every tool call, every sub-agent spawn, every dispatch
decision is a first-class visual event on a timeline you can actually read —
no scrollback hunting, no buried context.

The UI's job is to make a 5-agent run as legible as a 1-agent run. That is
the entire premise.

**On roles.** Roles are a per-run choice, not a project-level ideology.
Self-organizing patterns (blackboard, council) have no pinned roles —
agents self-select. Hierarchical patterns (orchestrator-worker,
debate-judge, critic-loop) carry implicit roles when the work needs them
(orchestrator vs worker, judge vs generator, critic vs worker). The
pattern picks the role model; the human picks the pattern.

Every agent has a **name** and an optional self-authored **focus line**
(`"reviewing the router diff"`). Hierarchical patterns may add a **role**
(`orchestrator`, `worker`, `judge`, …). The human scans names, status dots,
focus lines, and the timeline.

---

## 2. Mental model

**Timeline-centric, not chat-centric.** The session is a 2-D plane:

- **X axis = agents** (one lane per agent, `LANE_WIDTH = 168`).
- **Y axis = time** (events stack downward in dispatch order).

Two event categories share the timeline:

| Category | Visual | Examples |
|---|---|---|
| **Cross-lane (A2A)** | Card on sender lane, wire crossing to receiver, drop dot | `task` delegate, `subtask` return, user prompt, A2A message |
| **In-lane (tool/internal)** | 16px chip docked under the parent A2A row | `bash`, `read`, `edit`, `grep`, `webfetch`, `reasoning`, `step-start`/`step-finish`, `patch`, `compaction` |

This split keeps the visual budget where it belongs. Swarm communication
(rare, important) gets a wire. Tool noise (frequent, expected) gets a chip.

The predicate `isCrossLane()` and the canonical part/tool color map live in
`lib/part-taxonomy.ts`.

---

## 3. UI surface map

### Layout shell — `app/page.tsx`
- **Topbar** — run anchor chip (title · pattern · session count), tier chip
  (`1/5..5/5`), $ budget chip, agent count, retry-after countdown when a
  Zen 429 is active, provider-stats popover, metrics + projects opener
  buttons (open as modals, not full-page nav), palette/diagnostics/account.
- **View toolbar** (above the main viewport) — all 10 view tabs render
  always: `chat → timeline → cards` (universal trio) | divider |
  `board · contracts · iterations · debate · map · council · strategy`
  (pattern-specific). Non-applicable tabs render dim and lead to an
  `EmptyViewState` with a 7×10 patterns × views availability matrix.
  Default landing view is `chat`.
- **Roster** (260px left rail, `components/agent-roster.tsx`) — collapsed
  agent rows: accent stripe, status circle, name, attention badge,
  `+` icon to spawn a new agent.
- **Left-rail tabs** — `plan` (always on), `roster`, `heat` (file-edit
  heatmap; mounts when ≥1 file has been touched), `board` (visible only
  when the run has a `boardSwarmRunID`).
- **Main viewport** (1fr center) — renders the active view; defaults to
  ChatView (per-turn cards with inline tool pills).
- **Pattern-specific strips** under the timeline view:
  - `SynthesisStrip` (map-reduce), `ReconcileStrip` (council),
    `JudgeVerdictStrip` (debate-judge), `CriticVerdictStrip` (critic-loop),
    `OrchestratorActionsStrip` (orchestrator-worker).
- **Cost-cap banner** — surfaces above the composer when `/api/opencode`
  returns 402; `raise cap` opens the routing modal.
- **Permission strip** — above the composer when `permission.asked` fires.
- **Composer** (bottom) — typed dispatch with target picker (broadcast /
  specific agent / human).
- **Status rail** (footer) — websocket dot, palette / routing / glossary /
  diagnostics / branch-history triggers.
- **Drawer** (right, 380px) — inspector for the focused message OR agent.
- **Modals** — palette (⌘K), new-run (⌘N), routing, branch history, spawn,
  glossary, diagnostics, metrics, projects.

### Standalone routes
Bookmark / new-tab fallbacks. The primary in-app entry for the first
two is the topbar modal, but the routes still resolve so a middle-click
"open in new tab" works for sharing a URL.

- `/metrics` — cross-preset cost dashboard (groups runs by `meta.pattern`).
- `/projects` — run picker grouped by source/workspace.
- `/board-preview?swarmRun=<id>` — full-screen blackboard view.
- `/retro/[swarmRunID]` — L2 rollup playback.
- `/debug/opencode/**` — dev harness for probing endpoints.

### Timeline internals
`components/swarm-timeline.tsx` + `components/timeline-flow.tsx`:
- Each row = lead A2A event + 0..N chip events docked beneath.
- Cards are `NODE_WIDTH=164` (just under `LANE_WIDTH` so they sit inside).
- Wires: SVG paths from sender card edge to receiver lane center; drop dot
  at receiver lane.
- Lane axis lines drawn at lane center (`i * LANE_WIDTH + LANE_WIDTH/2`).
- Playback clock (`lib/playback-context.tsx`) phases each part:
  `hidden → streaming → settled`.

### Modal contracts (each has one — do not mix)
- **New-run** — *imperative*. `launch`. Source required; everything else
  seeds. Team picker has provider-tier filter chips (`go / zen / ollama
  / byok`) above the model rows so picking a model implicitly picks a
  billing path.
- **Spawn** — *imperative*. `spawn`. Creates an agent now. Same provider-
  tier filter chips and 3-layer ollama help (footer hint + popover
  checklist + live `/api/tags` diagnostic) as new-run, shared via
  `lib/swarm-provider-tiers.ts`.
- **Routing** — *declarative*. `save`. Run-level bounds + observed dispatch
  readout. **No per-agent assignments. No system-inferred role labels.**
  Agents self-select; humans set bounds. The `eyebrow="observation"` tooltip
  explains this in-product.
- **Branch history** — *read-only*.
- **Glossary** — *reference*. Actor/transcript vocabulary only.
- **Diagnostics** — *read-only*. Live opencode daemon state — tool catalog,
  MCP servers, effective `opencode.json`, user-defined commands — with a
  drift indicator vs. the static `ToolName` union.
- **Metrics** — *read-only*. Cross-preset cost dashboard, opens from
  topbar (matches `/metrics` route).
- **Projects** — *read-only*. Run picker grouped by source/workspace +
  GitHub-style projects matrix (rows = repos, columns = days, cell hue
  = dominant run status, opacity = activity intensity). Drill-down stays
  inside the modal.
- **Palette** — *imperative*. ⌘K. Jump or trigger.

### Conventions
- **Eyebrow tooltips** (`Modal.eyebrowHint`) — wide hover tooltip on a modal
  eyebrow when the eyebrow names a concept worth explaining.
- **Dense-factory aesthetic** — h-5/h-6 rows, tabular-nums, monospace,
  `text-micro` (10px) uppercase tracking-widest2 for labels, hairline borders.
- **Provider tier vocabulary** — `zen` (pay-per-token marketplace), `go`
  (opencode subscription bundle), `ollama` (ollama.com max subscription —
  `:cloud` models), `byok` (when `opencode.json` carries a BYOK provider
  block). All routed through opencode. Both new-run team picker and
  spawn modal expose tier filter chips with per-tier counts; the model
  ID prefix encodes the routing (`opencode-go/...` vs `opencode/...` vs
  `ollama/...`), so picking a row implicitly picks the billing path.
  `lib/swarm-provider-tiers.ts` is the shared source of truth for both
  surfaces.

---

## 4. Dispatch philosophy — observation + bounds, never assignment

The routing modal is the most opinionated surface. The contract:

**Humans set bounds. Agents self-select. The system observes.**

| Layer | Who sets it | What it looks like |
|---|---|---|
| **Run bounds** | human | `$ cap` / `token cap` / `wallclock cap` |
| **Provider ceilings** | human | soft fraction of run spend allowed per tier (`zen ≤ 60%`) |
| **Provider choice per call** | agent | each agent picks cheapest capable model within ceilings |
| **Observed dispatch** | system | stacked bar + per-model breakdown of what actually happened |
| **Focus line** | agent | one-liner each agent self-authors — ephemeral, never routed on |

What this rejects: **prescriptive routing** (`if role=X then provider=Y`) and
**system-inferred role labels** (`coordinator-shaped`, `implementer-shaped`).
Both reproduce the supervisor-worker dialectic; the inferred form just
launders it through statistics. If the human wants to summarize what an agent
did, the timeline and commit log are the source of truth, not a system label.

---

## 5. Initiate philosophy — source is sacred

The new-run modal is the run's creation event:

**The human anchors the substrate. The swarm sets its own goals within it.**

| Field | Required? | Owned by |
|---|---|---|
| **source** (repo URL / folder) | yes | human — the only thing the swarm cannot invent |
| **branch strategy** | yes (default worktree) | human |
| **start mode** (dry-run / live / spectator) | yes (default dry-run) | human |
| **directive** | no | human *or* the swarm (inferred from README / commits / issues) |
| **team** | no | human-picked roster + fresh spawns; zero is fine |
| **bounds** (spend / wallclock) | no | human; `unbounded` toggle surrenders the ceiling |

A run with only a source is a valid run.

**Substrate inference.** When the directive is blank and the source is set,
the preview panel shows what the swarm *would* infer. Readout, not a
commitment.

---

## 6. State contracts

All shapes live in `lib/swarm-types.ts` and `lib/types.ts`. Runtime
materialization happens in `lib/opencode/transform.ts`.

### `Agent`
```ts
{
  id: string,           // → child sessionID
  name: string,
  accent: 'molten' | 'mint' | 'iris' | 'amber' | 'fog',
  status: 'idle' | 'thinking' | 'working' | 'waiting' | 'paused' | 'done' | 'error',
  model: { provider: 'zen' | 'go' | 'ollama', label: string },
  tools: ToolName[],
  focus?: string,       // self-authored, never routed on
  tokensUsed: number, tokensBudget: number,
  costUsed: number,
  messagesSent: number, messagesRecv: number,
  role?: AgentRole,     // hierarchical patterns only; absent on self-organizing
  sessionID?: string,
}
```

### `AgentMessage` (= one part on the timeline)
```ts
{
  id: string,                      // → message part id
  fromAgentId: string | 'human',
  toAgentIds: string[],            // ['human'] for assistant→user
  part: PartType,                  // 'text' | 'reasoning' | 'tool' | 'subtask' | …
  toolName?: ToolName,
  title: string, body?: string,
  timestamp: string,
  duration?: number,
  status: 'pending' | 'running' | 'completed' | 'error',
  tokens?: number,
}
```

### `SwarmRunStatus` (run-level, derived)
```ts
'live' | 'idle' | 'error' | 'stale' | 'unknown'
```
- `live` — ticker running + ≥1 session producing tokens.
- `idle` — ticker running but no session producing (between dispatches; alive
  but quiet — flag-flavor of live).
- `error` — at least one session reported a real error. Wins over live/stale.
- `stale` — ticker stopped (cap-stop, manual stop, normal completion).
- `unknown` — couldn't probe.

Reconciliation lives in `lib/server/swarm-registry/derive.ts::reconcileWithTicker`.

`RunMeta`, `ProviderSummary`, `RunTokensBreakdown` — see `swarm-types.ts` and
`lib/server/swarm-registry/derive.ts`.

---

## 7. Backend persistence — three-layer memory

Session memory is a pyramid. The base lives on disk; only the summit enters
an agent's context window.

| Layer | Storage | Purpose | Size per run |
|---|---|---|---|
| **L0 — Event log** | Append-only NDJSON (verbatim SSE stream) | Human playback, replay, debug | Unbounded |
| **L1 — Part index** | SQLite, one row per message-part | Reducer input for L2 rollup generation | ~10–50 KB |
| **L2 — Rollups** | Per-agent summary + per-run retro at session close | Agent consumption in next run | ~2–10 KB |

**Budget target.** For multi-reasoning LLMs (~234k ctx), spend no more than
~50% on recalled history. **L2 only by default** — agents in the next run
consume the prior run's `RunRetro` + per-agent `AgentRollup` blobs. L0/L1
never enter context; they exist for human playback (L0) and as the reducer
input for L2 generation (L1).

**Content-addressing.** Diffs, file snapshots, and tool outputs >N bytes are
stored once by `sha256(content)` and referenced by hash everywhere.

### Rollup schema (L2)

`AgentRollup` (one per child session) and `RunRetro` (one per run) — both in
`lib/server/memory/types.ts`. Persist into the `rollups` table keyed on
`(swarm_run_id, session_id)`.

Lessons (in `RunRetro.lessons`) are the load-bearing field — what a future
agent *wants*. Tagged, terse, evidence-linked. v1 reducer emits
`tool-failure` lessons (3+ same-tool errors per run); richer tags
(`routing-miss`, `good-pattern`, `user-correction`) reserved for a future
librarian agent.

### Retention

Three states:

| State | Trigger | Disk effect |
|---|---|---|
| **active** | run created | `meta.json` + uncompressed `events.ndjson` |
| **compressed** | status terminal for >24h | `events.ndjson` → `events.ndjson.gz` |
| **archived** | deferred — only if disk pressure appears | move to `.opencode_swarm/archive/` |

`readEvents()` in `lib/server/swarm-registry/fs.ts` falls back to
`events.ndjson.gz` via `createGunzip()` — consumers don't know which state
a run is in.

`npm run swarm:compress` walks every run, gzips ones idle ≥24h. Auto-prune
on dev startup is opt-in via `DEMO_LOG_AUTO_DELETE=1` +
`DEMO_LOG_RETENTION_DAYS` (default 30). Off by default so routine boots
don't lose history.

`rm -rf .opencode_swarm/runs/<id>/` is fine — `listRuns()` skips malformed.

---

## 8. Planning & delegation

opencode gives each session a private todo list (`todowrite`/`todoread`)
and a `task` tool for delegation. None of these know about each other —
shared run-level plans are an app-layer construction.

### What the app invents

1. **Binding** — link each plan-holder todo to the `task` call that
   executes it.
2. **Aggregation** — optionally expose a child agent's sub-plan as a
   collapsible sub-list under the parent's item (opt-in; flattening is
   often clearer).
3. **Persistence** — write the todo↔task mapping into L2 rollups so the
   next run can see *"item B was delegated to forge, took 3 retries,
   succeeded."*

### `todoID ↔ taskID` binding

Two mechanisms in priority order:

**(a) App-injected ID.** When an agent writes a todo, the app mints
`todoID = sha256(content)[:16]`. When it delegates, the dispatcher
prefixes the `task` description with `[todo:<16-hex>]`. Memory ingest
catches both sides:
- `extractOriginTodoID` parses the prefix from `part.input.description`
- `extractChildSessionID` captures `part.state.sessionID`
- Both land in `parts` columns (`origin_todo_id`, `child_session_id`)
- `lookupSessionOrigin` resolves the pairing at rollup time

**(b) Prompt-hash match / temporal attribution — fallback.** Without
the prefix, the reducer attributes patches to whichever todo was
`in_progress` in the same session's `planState` at patch time.

Attribution precedence in `reducePart` (patch branch):
1. In-session `planState.inProgressHash`
2. `sessionOriginTodoID` (inherited from parent task's prefix)
3. `undefined`

### What this lights up

- **Roster badge** — `ActiveTodoChip` shows in-progress todos per agent.
- **Timeline** — `task` cards surface origin-todo as `todo·X` button
  (click jumps to plan tab).
- **Inspector** — plan↔timeline hop via `focusedId` ↔ `setFocusTodoId`.
- **L2 rollup** — `AgentRollup.artifacts[].originTodoID` closes the
  intent loop.

---

## 9. Cost ceiling enforcement

Hybrid: per-session model selection + root-session HTTP gate.

- **Per-session.** Each agent's dispatch loop reads `bounds.costCap` and
  picks the cheapest capable model within remaining headroom.
- **Root gate.** Before the `/api/opencode` proxy forwards a `/prompt` /
  `/prompt_async` for a swarm-managed session, the server compares
  accumulated $ against `bounds.costCap` and returns 402 if exceeded.
  Direct `?session=` flows (no swarmRunID) are ungated — opt-out by
  construction. Probe failures let the prompt through.

The 402 surfaces in browser as `CostCapError` → `CostCapBanner` above the
composer, with `raise cap` opening the routing modal. Block re-appears on
next send if the cap hasn't moved.

---

## 10. The one rule

**Ship surfaces with single contracts.** A panel is either declarative
(rules / config / state) or imperative (actions / events / commands).
Never both.

The `observation` eyebrow tooltip on the routing modal explains the
deeper why — read it before adding a "force redispatch" or "halt all"
button there, or a "save preset" to the spawn modal. Declarative bounds
and derived readouts can coexist; declarative bounds and an imperative
kill switch cannot.

---

## 11. Files worth knowing

| Path | Purpose |
|---|---|
| `app/page.tsx` | Layout shell, modal orchestration, ⌘K / ⌘N |
| `components/swarm-timeline.tsx` | Timeline scroll + sticky lane headers |
| `components/timeline-flow.tsx` | Card / wire / drop / chip layout math |
| `components/swarm-topbar.tsx` | Topbar: anchor, tier, $, retry-after |
| `components/agent-roster.tsx` | Left rail: agents, attention badges |
| `components/board-rail.tsx` | Blackboard items (visible only on `pattern='blackboard'`) |
| `components/{plan,heat}-rail.tsx` | Always-on left-rail tabs |
| `components/inspector/*.tsx` | Right drawer for focused message / agent |
| `components/cost-cap-banner.tsx` | 402 surface; opens routing modal |
| `components/{cost-dashboard,cross-preset-metrics}.tsx` | `/metrics` route |
| `components/{routing,spawn-agent,new-run}-modal.tsx` | Modals |
| `components/command-palette.tsx` | ⌘K palette |
| `lib/swarm-types.ts` | Canonical TS types |
| `lib/swarm-run-types.ts` | Run-level types (`SwarmRunMeta`, `SwarmRunStatus`) |
| `lib/opencode/live/*.ts` | Browser-side polling/SSE hooks |
| `lib/opencode/transform/*.ts` | opencode payload → app shapes |
| `lib/part-taxonomy.ts` | Part/tool color map + `isCrossLane()` |
| `lib/playback-context.tsx` | Run clock + per-part phase machine |
| `lib/server/swarm-registry/{fs,derive}.ts` | Persistence + liveness derivation |
| `lib/server/blackboard/coordinator/*.ts` | Tick coordinator + watchdogs |
| `lib/server/memory/*.ts` | L0 → L1 → L2 ingest + rollup |
