# opencode_swarm — Design Plan

> Read this before writing backend code, opening a feature PR, or extending the timeline.
> It is the single source of truth for *why* the UI is shaped the way it is.

**Status:** UI prototype only. All data is mocked in `lib/swarm-data.ts`. There is no backend yet. This document is the brief for the team (human or AI) that will wire the real opencode runtime to this surface.

---

## 1. Vision

Run opencode as a **swarm**, not a single chat. Multiple undifferentiated agents work in parallel against one run, free to delegate, research, patch, and review as the work demands. Every tool call, every sub-agent spawn, every dispatch decision is a first-class visual event on a timeline you can actually read — no scrollback hunting, no buried context.

The UI's job is to make a 5-agent run as legible as a 1-agent run. That is the entire premise.

**Project goal.** Surface every inner working of opencode-driven agentic workmanship so that humans and agents alike can inspect, debug, and fine-tune the output of multi-agent runs across many iterations. The app keeps a detailed, durable record of every opencode session and project — not as passive archive, but as a shared substrate that both the human operator and the AI agents draw on to converge on sound-quality results over time.

**On roles.** We reject the supervisor-worker paradigm — *and* we reject the softer move of letting the system label behavior after the fact. No role prescribed by the human ("this agent is the coder"), no role inferred by the system ("this agent is coder-shaped"). The human seeds direction and bounds; agents decide internally who does what, with maximal freedom over toolset and delegation pattern. An agent has a **name** and an optional ephemeral **focus line** it writes itself ("reviewing the router diff") — nothing else identifies it. The human operator scans names, status dots, focus lines, and the actual timeline events to draw their own conclusions; the system does not summarize behavior into labels. This is the single most load-bearing stance in the project — it shapes the routing modal, the spawn modal, the roster, and the inspector.

---

## 2. Mental model

**Timeline-centric, not chat-centric.** The session is a 2-D plane:

- **X axis = agents** (one lane per agent, constant `LANE_WIDTH = 168`).
- **Y axis = time** (events stack downward in dispatch order).

Two event categories share the timeline:

| Category | Visual | Examples |
|---|---|---|
| **Cross-lane (A2A)** | Card on sender lane, wire crossing to receiver lane(s), drop dot on receiver lane | `task` tool delegate, subtask return, user prompt, A2A message |
| **In-lane (tool/internal)** | Compact 16px chip docked under the parent A2A row, on the agent's own lane | `bash`, `read`, `edit`, `grep`, `webfetch`, `reasoning`, `step-start`/`step-finish`, `patch`, `compaction` |

This split keeps the visual budget where it belongs. Swarm communication (the rare, important thing) gets a wire. Tool noise (the frequent, expected thing) gets a chip.

See: `lib/part-taxonomy.ts` for the `isCrossLane()` predicate and the canonical part/tool color map.

---

## 3. Vocabulary — opencode SDK alignment

We deliberately use opencode's canonical names instead of inventing new ones. Source: `github.com/sst/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts`. See also `docs/opencode-vocabulary.md`.

**Identity primitives:**
- **`sessionID`** — the unique runtime handle. Every agent in the roster maps 1:1 to a child sessionID created by `session.create` or by the `task` tool. The agent's display name is a config label, not a stable identifier.
- **Agent config** (in `app.agents`) — name, model, prompt, tools. Static. Reusable across many sessions.

**Message parts** (the atoms of the timeline):
`text` `reasoning` `tool` `file` `agent` `subtask` `step-start` `step-finish` `snapshot` `patch` `retry` `compaction`

**Tool names** (built-in primitives):
`bash` `read` `write` `edit` `list` `grep` `glob` `webfetch` `todowrite` `todoread` `task`

`task` is opencode's native A2A primitive — there is **no separate "agent message" type**. Sub-agent communication happens via `task` invocations and `subtask` parts.

**SSE event stream** (what the UI subscribes to):
`session.{created,updated,deleted,status,idle,compacted,diff,error}`
`message.{updated,removed}`
`message.part.{updated,removed}`
`permission.{updated,replied}`
`file.edited` · `file.watcher.updated` · `vcs.branch.updated`
`lsp.client.diagnostics` · `lsp.updated`
`todo.updated` · `command.executed`
`installation.updated` · server heartbeat every 10s

**Session status:** `idle` `busy` `retry`
**Tool state:** `pending` `running` `completed` `error`

---

## 4. UI surface map

### Layout shell — `app/page.tsx`
- **Topbar** — run title, $ budget chip, go-tier rolling cap chip, agent count, palette/settings/account.
- **Roster** (260px left rail) — collapsed agent rows: accent stripe, status circle, name, attention badge.
- **Timeline** (1fr center) — sticky lane headers + event canvas (see below).
- **Composer** (bottom) — typed message dispatch with target picker (broadcast / specific agent / human).
- **Status rail** (footer) — live websocket dot, palette / routing / glossary / branch-history triggers.
- **Drawer** (right, 380px) — inspector for the focused message OR selected agent.
- **Modals** — palette (⌘K), run dispatch (observation), branch history, spawn agent, glossary.

### Timeline internals — `components/swarm-timeline.tsx` + `components/timeline-flow.tsx`
- Each row = one **lead A2A event** + 0..N **chip events** docked beneath.
- Cards are NODE_WIDTH=164 (just under LANE_WIDTH so they sit inside the lane).
- Wires: SVG paths from sender card right/left edge to receiver lane center; drop dot at receiver lane.
- Lane axis lines are drawn at `i * LANE_WIDTH + LANE_WIDTH/2` (lane center), not at boundaries.
- Playback clock (see `lib/playback-context.tsx`) phases each part: `hidden → streaming → settled`. Future-time events are filtered out, current ones animate in.

### Modals (each has a clear contract — do not mix)
- **Spawn modal** (`spawn-agent-modal.tsx`) — *imperative*. Creates an agent now. Verb: `spawn`.
- **Routing modal** (`routing-modal.tsx`) — *declarative observation + bounds*. Sets run-level caps (spend / tokens / wallclock), per-provider soft ceilings, and surfaces observed dispatch distribution. Verb: `save`. Effect applies to *next dispatch*. **No per-agent assignments live here, and no system-inferred role labels either.** Agents self-select providers within the bounds; humans observe and nudge. The `eyebrow="observation"` tooltip explains this contract in-product. See §4.2.
- **Branch history** (`commit-history.tsx`) — *read-only*. Run log of commits / prompts / tools / reviews.
- **Glossary** (`glossary-modal.tsx`) — *reference*. Canonical opencode parts, tools, events. Actor/transcript vocabulary only — API/config types are intentionally out of scope.
- **Palette** (`command-palette.tsx`) — *imperative*. ⌘K / Ctrl+K. Jump to any timeline node or trigger an action.

### Important conventions
- **Eyebrow tooltips** (`Modal.eyebrowHint`) — attach a wide hover tooltip to a modal's eyebrow when the eyebrow names a concept worth explaining (first use: `observation`).
- **Dense-factory aesthetic** — h-5/h-6 rows, tabular-nums, monospace, `text-micro` (10px) uppercase tracking-widest2 for labels, hairline borders (`hairline-b/t/r/l` from `app/globals.css`).
- **Provider tier vocabulary** — `zen` (pay-per-token marketplace) and `go` (subscription bundle). All dispatch decisions choose between these two. We do *not* expose BYOK in the UI; the user said "all users are assumed to use opencode zen/go".

### 4.2 Dispatch philosophy — observation + bounds, never assignment

The routing modal is the single most opinionated surface in the app. The contract is:

**Humans set bounds. Agents self-select. The system observes.**

Concretely:

| Layer | Who sets it | What it looks like |
|---|---|---|
| **Run bounds** | human | `$ cap` / `token cap` / `wallclock cap` — sliders in the modal |
| **Provider ceilings** | human | soft fraction of run spend allowed per provider tier (`zen ≤ 60%`) |
| **Provider choice per call** | agent | each agent picks cheapest capable model within remaining ceilings |
| **Observed dispatch** | system | stacked bar + per-model breakdown of what actually happened |
| **Focus line** | agent | one-liner each agent self-authors ("patching idempotency guard") — ephemeral, not routed on |

**What this explicitly rejects:** two things, not one. First, the prescriptive form — `if role=X then provider=Y` — which pins an agent's behavior before it has acted. Second, the softer form — system-inferred role labels (`coordinator-shaped`, `implementer-shaped`, etc.) derived from tool mix and shown to the human as a readout. Both reproduce the supervisor-worker dialectic; the inferred form just launders it through statistics. If the human wants to summarize what an agent did, the timeline and commit log are the source of truth, not a system-minted label.

**What survives from the old idea:** humans still want cost discipline, and some runs genuinely need a premium-reasoning tier available. The modal keeps those affordances — as ceilings on the tier, not as assignments to agents. The agent reasons about its own budget within that envelope.

**Focus lines, not shapes.** Each agent carries an optional `focus?: string` — a short, self-authored statement of what it's currently working on. Freely updatable by the agent, visible in the roster and timeline, never computed by the system, never used for routing or filtering. It's the only identity affordance beyond the name.

### 4.3 Initiate philosophy — source is sacred, everything else is a seed

The new-run modal (`new-run-modal.tsx`) is the run's creation event. Contract:

**The human anchors the substrate. The swarm sets its own goals within it.**

| Field | Required? | Owned by |
|---|---|---|
| **source** (repo URL / folder) | yes | human — it's the only thing the swarm cannot invent |
| **branch strategy** | yes (default worktree) | human — touches the file system outside the sandbox |
| **start mode** (dry-run / live / spectator) | yes (default dry-run) | human — governs whether writes land |
| **directive** | **no** | human *or* the swarm (inference from README / commits / issues) |
| **team** | **no** | human-picked roster + fresh spawns; zero is fine — agents spawn peers as work demands |
| **bounds** (spend / wallclock) | **no** | human; `unbounded` toggle surrenders the ceiling |

**Why the optionals are truly optional.** The project's stance (§1) is that agents should be allowed to set their own goals when humans don't have strong preferences. The modal must not smuggle that stance back out through required fields. A run with only a source is a valid run.

**Creative affordance: substrate inference.** When the directive is blank and the source is set, the preview panel shows what the swarm *would* infer — likely focus, file hotspots, open work. This is a readout, not a commitment. The swarm can revise goals mid-run; the directive is a seed, not a contract.

**Dry-run is the default.** Because "let the swarm figure it out" is a strong claim, the first launch shouldn't mutate the working tree. Dry-run plans, spawns tasks, and populates L1 without writing to disk. Promote to `live` once the plan looks right.

**Single contract.** The modal is imperative (`launch run`) but holds declarative preferences (bounds, strategy). Per §12 this coexistence is allowed because there is no kill switch and no live policy edit — the entire modal is the setup for one dispatch event. Once the run is launched, all further policy lives in the routing modal (declarative) and composer (imperative) — not here.

---

## 5. State the UI expects (data contracts)

All shapes live in `lib/swarm-types.ts` and `lib/types.ts`. Today they're populated from `lib/swarm-data.ts` (mock). When wiring real opencode, these are the structures the backend must produce.

### `Agent`
```ts
{
  id: string,           // → child sessionID at runtime
  name: string,         // display name (config label) — the only identity affordance
  accent: 'molten' | 'mint' | 'iris' | 'amber' | 'fog',
  status: 'idle' | 'thinking' | 'working' | 'waiting' | 'paused' | 'done' | 'error',
  model: { provider: 'zen' | 'go', label: string },
  tools: ToolName[],
  focus?: string,       // agent-authored ephemeral one-liner; never routed on
  tokensUsed: number, tokensBudget: number,
  costUsed: number,
  messagesSent: number, messagesRecv: number,
}
```
No `role` field. See §1 — role labels (prescribed *or* inferred) are rejected.

### `AgentMessage` (= one part on the timeline)
```ts
{
  id: string,                      // → message part id
  fromAgentId: string | 'human',
  toAgentIds: string[],            // ['human'] for assistant→user, etc.
  part: PartType,                  // 'text' | 'reasoning' | 'tool' | 'subtask' | ...
  toolName?: ToolName,             // when part === 'tool'
  toolKind?: string, toolSubtitle?: string, toolPreview?: string,
  title: string, body?: string,
  timestamp: string,               // 'mm:ss' for now; ISO when real
  duration?: number,               // seconds
  status: 'pending' | 'running' | 'completed' | 'error',
  tokens?: number,
}
```

### `RunMeta`, `ProviderSummary` — see `swarm-types.ts`.

---

## 6. Mock → real: the wiring plan

The UI is intentionally state-shaped, not request-shaped. To make it real, do this in order:

### Phase 1 — read-only mirror
1. **Subscribe to opencode SSE** (`event.subscribe` / `event.listen`). One websocket per opencode instance.
2. **Materialize sessions into agents.** Each child session of the parent run becomes an `Agent` row. Map `session.status` → `Agent.status`. Initial config (name, model, tools) comes from `app.agents` for the agent definition referenced by the session.
3. **Materialize message parts into `AgentMessage`s.** Stream `message.part.updated` → append/update rows. Map opencode part types → our `PartType`. The `task` tool's invocation → `AgentMessage` with `part: 'tool'`, `toolName: 'task'`, and `toAgentIds` populated from the task's target agent.
4. **Wire run meta.** Sum tokens/cost across child sessions → `RunMeta.totalCost / totalTokens`. Window-roll for `goTier.used`.

At this point the UI shows a real run live, but cannot drive it.

### Phase 2 — control plane
5. **Composer dispatch** → `session.prompt` to the root session (the session the human is addressing). Target picker (specific agent) → `session.prompt` directly to that child session.
6. **Spawn modal** → `session.create` with the chosen agent config; immediately appears in roster.
7. **Routing modal save** → persist run-level bounds (`costCap`, `tokenCap`, `minutesCap`, `zenCeiling%`, `goCeiling%`) to a config endpoint. Each agent's dispatch loop reads the current bounds and picks its own provider — cheapest capable within remaining ceiling. The **observed dispatch** readout comes from aggregating `message.part.updated` events by `model.provider` + `model.label`; **observed shapes** come from aggregating tool-call counts per agent, classified by the rubric in §4.2. Neither is a config value — both are derived projections over the L1 part index (§7.1).
8. **Permission flow** — when `permission.updated` fires, surface in the agent's attention badge; clicking jumps to inspector with accept/reject buttons that call `permission.replied`.

### Phase 3 — branch history (real VCS)
9. Replace `lib/commits-data.ts` with `vcs.branch.updated` + `file.edited` + `session.diff` aggregation. The current "branch history" modal shape already matches.

### Phase 4 — multi-tenant / multi-instance
10. Account chip in topbar becomes real (current `kk` placeholder). Run picker. Cross-run cost dashboard.

---

## 7. Session memory & logging (backend)

The app's durable value is not the live UI — it's the **record of every multi-agent run**, shaped so both humans (for playback) and agents (for the *next* run) can reason over it. This section is the brief for whoever wires persistence.

### 7.1 Three-layer model

Session memory is a pyramid. The base lives on disk; only the summit enters an agent's context window.

| Layer | Storage | Purpose | Size per run |
|---|---|---|---|
| **L0 — Event log** | Append-only NDJSON (exact SSE stream, verbatim) | Human playback, replay, debug | Unbounded (MBs) |
| **L1 — Part index** | SQLite / DuckDB, one row per message-part | Query: "what did agent X do to file Y?", cross-run analytics | ~10–50 KB per run |
| **L2 — Rollups** | Per-agent summary + per-run retro, written at session close | Agent consumption in the *next* run | ~2–10 KB per run |

**Budget target.** For multi-reasoning LLMs (e.g. GLM-5.1 @ 234k ctx), spend no more than ~50% (≈117k tokens) on recalled history. That means **L2 only by default**, with selective L1 slices fetched on demand via a `recall(sessionID, filter)` tool. L0 never enters context; it's for humans and for regenerating L1/L2 after schema changes.

**Content-addressing.** Diffs, file snapshots, and tool outputs >N bytes are stored once by `sha256(content)` and referenced by hash everywhere. A run that touches the same 30-line patch ten times stores it once.

### 7.2 What to collect (the menu)

**Swarm-run level** (one record per run)
- `swarmSessionID`, `createdAt`, `endedAt`, `durationMs`, `outcome` (`completed` / `aborted` / `failed`)
- `directive` (verbatim prompt, may be null — agents can run unseeded), `rootWorkspace` (repo path, branch, HEAD sha start/end)
- `participants[]` — per agent: `name`, `model`, `promptHash`, `toolPermissions`
- `routingPolicy` snapshot (the declarative rules in force at start)
- `budget`: `tokensIn`, `tokensOut`, `costUSD`, wallclock
- `artifacts`: patches produced, files touched, commits, PR URLs

**Per-agent-session** (one per opencode child sessionID)
- `sessionID`, `agentConfig`, `parentTaskID` (who spawned it — forms the task tree)
- Part counters: `bash`, `read`, `edit`, `grep`, `webfetch`, `task` (fan-out), `retry`, `compaction`
- `tokensIn / tokensOut`, `toolCallsCount`, `errorsCount`
- `firstDispatchAt`, `lastDispatchAt`

**Per-part** (the atoms of L1)
- `partID`, `messageID`, `partType`, `createdAt`, `latencyMs`
- Tool parts: `toolName`, `argsHash`, `resultHash`, `resultSize`, `exitCode`, `durationMs`
- `task` parts: `childSessionID`, `promptHash`, `resultSummary` (generated at close)
- `patch` parts: `filePath`, `+lines / -lines`, `diffHash`

**Quality signals** (what makes iteration work)
- Review approvals / rejections per patch (the *act* of review, not a reviewer identity — any agent may review any patch)
- User interventions — permission replies, manual routing overrides, composer corrections
- Retries, rollbacks, test / lint / typecheck results
- **Diffs merged vs. diffs discarded** — the ground truth for "did this agent produce value?"

**Routing trace** (makes the policy itself debuggable)
- Every dispatch decision: `sender → receiver`, which rule matched, timestamp

### 7.3 Key tradeoff

The budget pressure is not L0 size — disk is cheap. It's the **quality of the L2 rollup**. If summaries are lossy in the wrong way, the next run repeats the same mistakes. Spend engineering on *structured* rollups (per-file outcome, per-tool failure modes, review feedback verbatim) rather than free-form prose. A good rollup is a schema, not an essay.

### 7.4 Rollup schema (L2)

Two rollup shapes, written once at session close. Schema > prose — structured fields survive summarization better than free text.

**Per-agent rollup** (one per child session)

```ts
type AgentRollup = {
  sessionID: string;
  agent: { name: string; model: string };
  runId: string;
  outcome: 'merged' | 'discarded' | 'partial' | 'aborted';
  counters: { tokensIn: number; tokensOut: number; toolCalls: number; retries: number; compactions: number };
  artifacts: Array<{
    type: 'patch' | 'file' | 'commit';
    filePath?: string;
    addedLines?: number;
    removedLines?: number;
    diffHash?: string;
    status: 'merged' | 'discarded' | 'superseded';
    reviewNotes?: string;  // verbatim, not summarized — from whichever agent reviewed
  }>;
  failures: Array<{
    tool: string;
    argsHash: string;
    exitCode?: number;
    stderrHash?: string;
    resolution: 'retried' | 'abandoned' | 'routed-to' | 'user-intervened';
    routedTo?: string;
  }>;
  decisions: Array<{ at: number; choice: string; rationaleHash: string }>;
  deps: { spawnedBy?: string; spawned: string[] };
};
```

**Per-run retro** (one per swarm run)

```ts
type RunRetro = {
  runId: string;
  directive: string | null;               // verbatim prompt; null if run started unseeded
  outcome: 'completed' | 'aborted' | 'failed';
  timeline: { start: number; end: number; durationMs: number };
  cost: { tokensTotal: number; costUSD: number };
  participants: string[];                 // AgentRollup.sessionIDs
  artifactGraph: { filesFinal: string[]; finalDiffHash?: string; commits: string[]; prURLs: string[] };
  lessons: Array<{
    tag: 'tool-failure' | 'routing-miss' | 'good-pattern' | 'user-correction';
    text: string;
    evidencePartIDs: string[];            // pointers into L1, so an agent can pull details on demand
  }>;
};
```

Lessons are the load-bearing field — they're what a future agent *wants*. Tagged, terse, evidence-linked.

### 7.5 The `recall` tool

Recall is how agents pull L1/L0 detail into context on demand. Default is cheap (L2 summary only); callers pay tokens explicitly by upgrading `shape`.

```ts
recall({
  runId?: string;                     // this OR sessionID
  sessionID?: string;
  workspace?: string;                     // opt-in cross-run recall (same repo)
  filter: {
    agents?: string[];                    // ['ember', 'forge'] — filter by handle, not label
    partTypes?: PartType[];               // ['edit', 'patch']
    toolNames?: string[];                 // ['bash', 'grep']
    filePath?: string;                    // glob: 'src/auth/**'
    outcome?: 'merged' | 'discarded';
    timeRange?: [number, number];
  };
  shape: 'summary' | 'parts' | 'diffs';   // token cost rises left→right
  limit?: number;
}) => {
  items: RecallItem[];
  tokenEstimate: number;                  // caller decides whether to paginate
  truncated: boolean;
};
```

Design notes:
- **Default `shape: 'summary'`** — forces agents to explicitly request heavier payloads.
- **`tokenEstimate` in response, not request** — the tool knows sizes; agents shouldn't guess.
- **Cross-run recall is opt-in** (`workspace` param). Default is this run only, to avoid context bleed between unrelated runs on the same repo.

### 7.6 Open wiring questions

- **Where does rollup generation run?** A dedicated "librarian" agent at session close, or a deterministic reducer over L1?
- **Schema evolution.** L0 is immutable; L1/L2 must be regenerable from L0 after schema changes. Budget for a migration tool from day one.
- **Cross-run recall.** Should an agent in run B see L2 from run A on the same repo? Opt-in per run, or scoped by workspace?

---

## 8. Planning & delegation wiring (backend)

Opencode gives each session a private todo list but no notion of a **shared, run-level plan**. A swarm UI where "the plan-holding agent's todos are visibly driving child agents" is an app-layer construction on top of SDK primitives. This section is the contract for building it. Any agent can hold the plan; it's not a role, it's a position in the delegation graph.

### 8.1 What opencode provides (native)

| Primitive | Used for |
|---|---|
| `todowrite` / `todoread` tools | Per-session plans — one list per `sessionID` |
| `task` tool | Delegation — spawns child session, runs prompt, returns `subtask` part |
| `session.create` + `session.prompt` | Lower-level; what `task` wraps |
| `subtask` part | Child's final result, surfaced in parent's message stream |
| `todo.updated` SSE event | Fires when any session's list changes |

None of these know about each other. A `todowrite` call and a `task` call are independent events from the SDK's point of view.

### 8.2 What the app layer invents

Three things the backend owns on top of the native primitives:

1. **Binding** — link each plan-holder todo item to the `task` call that executes it. The SDK won't tell you "this task call is item B"; the app has to establish correspondence.
2. **Aggregation** — if a child agent writes its own sub-plan via `todowrite`, optionally expose it as a collapsible sub-list under the parent's item. Opt-in; flattening is often clearer.
3. **Persistence** — write the todo↔task mapping into L2 rollups (§7.4) so the next run can see *"item B was delegated to `forge`, took 3 retries, eventually succeeded."*

### 8.3 The `todoID ↔ taskID` binding

Two viable mechanisms:

**(a) App-injected ID — recommended.** When an agent writes a todo, the app mints a stable `todoID`. When it delegates, the app injects the ID into the `task` description (e.g. `[todo:abc123] research JWT library options`). Backend parses on observation. Simple, explicit, robust to re-ordering or content edits.

**(b) Prompt-hash match — fallback.** Hash the todo content, hash the `task` prompt, match on overlap. Fragile — an agent may reword between plan and delegation, and near-duplicates across items collide.

Prefer (a). Implementation path: a thin tool wrapper around `task` that auto-injects the ID, plus a system-prompt pattern that teaches any plan-holding agent to preserve it.

### 8.4 What this lights up in the UI

- **Roster badge.** "`forge` is working on *item B*" — currently the roster only shows status.
- **Timeline affordance.** A `task` delegation card surfaces the originating todo item inline, not just the prompt text.
- **Inspector drawer.** Selecting an item in the plan view scrolls the timeline to the corresponding `task`/`subtask` pair.
- **L2 rollup field.** `AgentRollup.artifacts[].originTodoID` closes the loop from memory back to intent.

### 8.5 Open questions

- **Sub-plan depth.** If a child agent spawns its own sub-plan via its own `task` calls, render a tree view or flatten to depth=1?
- **Re-planning mid-run.** If the plan-holding agent rewrites its todo list while tasks are in flight, what happens to tasks bound to deleted items? Abandon, reparent, or flag for user?
- **Human edits.** Can the operator check off an item in the sidebar, or is the plan strictly agent-owned (read-only for humans)? The §11 "single contract" rule pushes toward read-only here.

---

## 9. Decisions already made (do not re-litigate)

These are recorded so future contributors don't burn cycles re-asking:

- **Timeline drop-on-lane routing.** Wires terminate at the receiver *lane column*, not the receiver card. Intentional — it keeps the receiver lane free of visual debt and lets multiple incoming wires stack cleanly.
- **Tool/internal events dock as chips.** Not full timeline rows. Keeps cross-lane communication visually dominant, which is the entire point of the timeline.
- **A2A model = circuit board / typed pins.** We considered bounty-board, writers-room, and subpoena models. Circuit-board won because it preserves direct sender→receiver topology.
- **Glossary scope = actor/transcript vocabulary only.** API surface, config schemas, plumbing types are out of scope — they belong in code docs, not the user-facing glossary.
- **Provider universe = zen + go only.** No BYOK / local-model UI. Agents are configured by name only, never by source.
- **Agent name and directive are optional at spawn.** Frontier models don't need narrow scoping; directives matter for *coordination*, not capability. Spawn modal dims optional inputs to signal this.
- **Inspector dismissal = click-outside.** No "show inspector" footer button. Modern users dismiss via outside-click; the button was removed.
- **No roles. Not prescribed, not inferred.** Agents self-select providers within run bounds; humans observe and nudge. There is no `role` field on `Agent`, no role-keyed routing, and no system-minted "shape" readout either. Identity is a name + an optional self-authored focus line. Anyone tempted to reintroduce `if role=X → provider=Y` — *or* a derived shape readout "for legibility" — should re-read §1 ("On roles") and the `observation` eyebrow tooltip before writing code. This is the single hardest-won architectural stance in the project.

---

## 10. Open questions

These are explicitly *not* decided yet. Backend implementer is invited to propose:

- **Cost ceiling enforcement.** Where does the spend cap actually live? Root-session gate, or per-session middleware?
- **Branch / fork semantics.** Palette has a "branch from current node" action. Maps to `session.children` + revert? Or a new git branch + new run?
- **Compaction trigger.** Manual via palette, or automatic at token threshold? UI assumes both.
- **A2A typed pins.** We assumed `task`-tool dispatch is the sole A2A primitive. If opencode introduces a richer A2A schema, the timeline needs a second wire style.
- **Authentication.** No auth UI exists. `auth.set` is the SDK method but not surfaced.

---

## 11. Files worth knowing

| Path | Purpose |
|---|---|
| `app/page.tsx` | Top-level layout shell, modal orchestration, keyboard shortcuts |
| `components/swarm-timeline.tsx` | Timeline scroll container + sticky lane headers + filter bar |
| `components/timeline-flow.tsx` | Card / wire / drop / chip layout math + SVG rendering |
| `components/agent-roster.tsx` | Left rail, attention badges, expanded agent panel |
| `components/inspector.tsx` | Right drawer content for focused message OR selected agent |
| `components/routing-modal.tsx` | Observation panel (run bounds + observed dispatch); see §4.2 for the philosophy |
| `components/spawn-agent-modal.tsx` | Imperative agent creation; family picker |
| `components/new-run-modal.tsx` | Run initiation; source required, directive/team/bounds optional; see §4.3 |
| `components/command-palette.tsx` | ⌘K palette with grouped jump targets and chip-formatted line items |
| `lib/swarm-types.ts` | Canonical TS types for Agent, AgentMessage, RunMeta, etc. |
| `lib/swarm-data.ts` | **Mock data** — the seed for everything you see today |
| `lib/part-taxonomy.ts` | Part/tool color map + `isCrossLane()` predicate |
| `lib/playback-context.tsx` | Run clock + per-part phase machine |
| `docs/opencode-vocabulary.md` | Detailed canonical vocab from opencode SDK |

---

## 12. The one rule

**Ship surfaces with single contracts.** A panel is either declarative (rules / config / state) or imperative (actions / events / commands). Never both. The `observation` eyebrow tooltip on the routing modal explains why — read it before adding a "force redispatch" or "halt all" button there, or a "save preset" to the spawn modal. Declarative bounds and derived readouts can coexist in one panel; declarative bounds and an imperative kill switch cannot.
