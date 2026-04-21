# opencode_swarm — Design Plan

> Read this before writing backend code, opening a feature PR, or extending the timeline.
> It is the single source of truth for *why* the UI is shaped the way it is.

**Status:** Live-data prototype. Mock fixtures were purged in April 2026 — the UI reads exclusively from opencode via `lib/opencode/live.ts` + `lib/opencode/transform.ts`, with `EMPTY_VIEW` as the zero-state when no run is active. This document is the brief for anyone extending the runtime surface or adding new panels.

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
`permission.{asked,replied,updated}`
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

All shapes live in `lib/swarm-types.ts` and `lib/types.ts`. At runtime they're populated by the transforms in `lib/opencode/transform.ts` from opencode's session + message payloads. When adding a new surface, derive the view shape from these contracts — don't reinvent.

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
5. **Composer dispatch** → `session.prompt` to the root session. Target picker (specific agent) → same session, `agent` field set to the agent-config name (e.g. `"build"`) so opencode routes within the session. Child-session fan-out (when an agent-config runs in its own session) is a later step — agent-name routing is enough while the agent map is a single session's `info.agent` projection.
6. **Spawn modal** → `session.create` with the chosen agent config; immediately appears in roster.
7. **Routing modal save** → persist run-level bounds (`costCap`, `tokenCap`, `minutesCap`, `zenCeiling%`, `goCeiling%`) to a config endpoint. Each agent's dispatch loop reads the current bounds and picks its own provider — cheapest capable within remaining ceiling. The **observed dispatch** readout comes from aggregating `message.part.updated` events by `model.provider` + `model.label`; **observed shapes** come from aggregating tool-call counts per agent, classified by the rubric in §4.2. Neither is a config value — both are derived projections over the L1 part index (§7.1).
8. **Permission flow** — when `permission.asked` fires, surface in a permission strip above the composer (`components/permission-strip.tsx`) with once / always / reject actions that POST to `/permission/{id}/reply`. The `permission.replied` event confirms and clears the strip. Attention-badge variant on the roster is a future iteration.

### Phase 3 — branch history (real VCS)
9. **Shipped.** `LiveCommitHistory` renders per-turn entries from `patch` parts with `session.diff` scoped to each turn's files (via `filterDiffsForTurn`). Every agent edit is a row; the "sha" column shows the synthetic turn id. Real `vcs.branch.updated` events are intentionally unused — they only fire on actual `git commit`, which most swarm runs never do, and the per-turn view answers the real human question ("what did the agent touch on this branch?") more directly. The mock `commits-data.ts` + `CommitHistory` fallback was removed — `LiveCommitHistory` is the single path.

### Phase 4 — cross-run analytics (single-user)

This app is personal-use only (never SaaS). **Multi-tenant and multi-instance work is explicitly out of scope** — no auth UI, no account switching, no tenant isolation. The `kk` chip in the topbar is a cosmetic placeholder, not an unfinished feature. What remains:

10. **Cross-run cost dashboard.** Aggregate `$` and tokens across every persisted run; group by workspace + rolling window. Data already exists in `meta.json` plus each session's messages — no new collection, just projection. First-class panel for answering *"where's my spend going this week?"* once the run count grows past ~20.
11. **Run picker** (shipped as Tier 4, reads local `.opencode_swarm/`).

GitHub integration (agent clones a repo, opens a PR, reads issues) is a **Phase 2 tool-capability concern**, not a Phase 4 identity concern — the user provides a classic PAT via env var; there is no sign-in flow.

### 6.5 HTTP API quirks discovered through probing

Probed against opencode's live HTTP API (2026-04-21). Documented here because the SDK type names imply behavior that doesn't match what the wire actually does — anyone implementing Phase 1/2 will hit these in order.

**Session scoping is bimodal.** Every session is either per-project (`projectID` = repo's first-commit SHA, `directory` = worktree) or global (`projectID` = `"global"`, `directory` = wherever opencode was invoked outside a registered repo). Bare `GET /session` returns **only globals** — per-project sessions are filtered out. To enumerate everything, fan out across `GET /project` and call `GET /session?directory=<worktree>` for each real project, then merge + dedupe. `GET /session/{id}` works regardless of scope, so URL-jumped sessions resolve even if the picker never listed them. See `getAllSessionsBrowser` in `lib/opencode/live.ts`.

**Session list ordering drifts between polls.** Two `GET /session` calls 3s apart, with identical session sets, returned different orders starting around index 235. The backend makes no stability guarantee. Any list component that polls must apply its own immutable tiebreak — we sort by `session.id` (reverse-time-encoded hex, so id-ascending ≈ newest-first) in `components/live-session-picker.tsx` for a stable "none" sort. Without this the picker reshuffles on every 3s tick.

**Assistant messages can become zombies.** When the opencode process dies mid-turn (e.g. because the session's `directory` doesn't exist on disk), the assistant message is left with `time.completed` missing AND `info.error` missing. Naive liveness checks (`!time.completed` = running) render these as active with an abort button forever. `toRunMeta` in `lib/opencode/transform.ts` now requires all three: no `completed`, no `error`, AND created within `ZOMBIE_THRESHOLD_MS` (10 min). Past 10 min with no terminal signal = stale.

**The diff endpoint is session-aggregate only.** `GET /session/{id}/diff` returns one unified diff of all committed edits in the session. It accepts `?messageID=` and `?hash=` query params, but they are **ignored** — the response is identical regardless. Per-turn granularity lives exclusively in each assistant message's `patch` parts, which carry `files: string[]` (files touched that turn) but no diff text. To render per-turn diffs (as the live commit history drawer does), fetch the session-aggregate diff once and filter hunks client-side by the turn's file list.

Each of these was an active blocker while wiring the real backend; none are visible in the SDK type definitions.

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
- `swarmRunID`, `createdAt`, `endedAt`, `durationMs`, `outcome` (`completed` / `aborted` / `failed`)
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

Two rollup shapes, written once at session close. Schema > prose — structured fields survive summarization better than free text. Both shipped as `AgentRollup` / `RunRetro` in `lib/server/memory/types.ts`; both persist into the `rollups` table keyed on `(swarm_run_id, session_id)` where the retro uses `session_id=''`.

**Per-agent rollup** (one per child session)

```ts
type AgentRollup = {
  kind: 'agent';                          // discriminator vs. RunRetro
  swarmRunID: string;
  sessionID: string;
  workspace: string;                      // resolved absolute path; scopes cross-run recall
  agent: { name: string; model?: string };
  closedAt: number;                       // epoch ms — authoritative "when was this written"
  outcome: 'merged' | 'discarded' | 'partial' | 'aborted';
  counters: { tokensIn: number; tokensOut: number; toolCalls: number; retries: number; compactions: number };
  artifacts: Array<{
    type: 'patch' | 'file' | 'commit';
    filePath?: string;
    addedLines?: number;
    removedLines?: number;
    diffHash?: string;
    status?: 'merged' | 'discarded' | 'superseded';
    reviewNotes?: string;                 // verbatim, not summarized — from whichever agent reviewed
    originTodoID?: string;                // sha256(todo.content)[:16] — intent anchor back to plan; §8.4
  }>;
  failures: Array<{
    tool: string;
    argsHash?: string;
    exitCode?: number;
    stderrHash?: string;
    resolution: 'retried' | 'abandoned' | 'routed-to' | 'user-intervened';
    routedTo?: string;
  }>;
  decisions: Array<{ at: number; choice: string; rationaleHash?: string }>;
  deps: { spawnedBy?: string; spawned: string[] };
  plan?: Array<{                          // final todowrite snapshot; omitted when agent never planned
    id: string;                           // sha256(content)[:16] — matches originTodoID on artifacts
    content: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'abandoned';
  }>;
};
```

**Per-run retro** (one per swarm run)

```ts
type RunRetro = {
  kind: 'retro';
  swarmRunID: string;
  workspace: string;
  directive: string | null;               // verbatim prompt; null if run started unseeded
  outcome: 'completed' | 'aborted' | 'failed';
  timeline: { start: number; end: number; durationMs: number };
  cost: { tokensTotal: number; costUSD: number };
  participants: string[];                 // sessionIDs with an AgentRollup row
  artifactGraph: { filesFinal: string[]; finalDiffHash?: string; commits: string[]; prURLs: string[] };
  lessons: Array<{
    tag: 'tool-failure' | 'routing-miss' | 'good-pattern' | 'user-correction';
    text: string;
    evidencePartIDs: string[];            // pointers into L1 (parts.part_id)
  }>;
};
```

Lessons are the load-bearing field — they're what a future agent *wants*. Tagged, terse, evidence-linked. The v1 reducer only emits `tool-failure` lessons (threshold: 3+ errors from the same tool in one run). The richer tags — `routing-miss`, `good-pattern`, `user-correction` — are reserved for a future librarian agent that reads the same L0+L1 and produces prose; until that ships, a mechanical tag is better than none.

### 7.5 The `recall` tool

Recall is how agents pull L1/L0 detail into context on demand. Default is cheap (L2 summary only); callers pay tokens explicitly by upgrading `shape`. Shipped as `POST /api/swarm/recall` backed by `lib/server/memory/query.ts`.

```ts
recall({
  swarmRunID?: string;                    // at least one of these three must be set
  sessionID?: string;
  workspace?: string;                     // opt-in cross-run recall (same repo)
  filter?: {
    agents?: string[];                    // ['ember', 'forge'] — filter by handle, not label
    partTypes?: string[];                 // ['edit', 'patch']
    toolNames?: string[];                 // ['bash', 'grep']
    filePath?: string;                    // shell-style glob: 'src/auth/**', '**/*.test.ts' — anchored to the full path; shipped 2026-04-21 (§7.5 below)
    outcome?: 'merged' | 'discarded';     // summary-shape only
    timeRange?: { startMs: number; endMs: number };
    query?: string;                       // FTS5 MATCH expression (parts-shape only)
  };
  shape?: 'summary' | 'parts' | 'diffs';  // token cost rises left→right; default 'summary'
  limit?: number;                         // server caps at 50
}) => {
  items: RecallItem[];
  tokenEstimate: number;                  // caller decides whether to paginate
  truncated: boolean;
  shape: 'summary' | 'parts' | 'diffs';
};
```

Design notes:
- **Default `shape: 'summary'`** — forces agents to explicitly request heavier payloads.
- **`tokenEstimate` in response, not request** — the tool knows sizes; agents shouldn't guess.
- **Scope guardrail** — the endpoint 400s if none of `swarmRunID`, `sessionID`, `workspace` is set. Unscoped "search the whole ledger" queries are almost always a malformed agent plan; require an explicit choice.
- **Cross-run recall is opt-in** via the `workspace` param. Default is this run only, to avoid context bleed between unrelated runs on the same repo.
- **`shape: 'diffs'`** currently falls through to `parts` filtered to `part_type='patch'`. Full-hunk expansion from L0 by `diffHash` is deferred — needs content-addressed resolution that isn't built yet.
- **`filter.filePath` (shipped 2026-04-21)** is a shell-style glob anchored to the full path — `**` crosses `/`, `*` does not, `?` is a single non-`/` char, `[abc]` is a character class. Matching is a hybrid: ingest stores a `|`-delimited `file_paths` column on patch/file parts, SQL pre-filters on `file_paths IS NOT NULL` + a `LIKE` on the pattern's fixed prefix, then JS post-filters with the compiled glob regex. Summary shape ignores the filter (rollup payloads aren't indexed for paths — callers should issue a parts/diffs query and look up the resolved `swarmRunID`s if they want rollup follow-through). Existing installs auto-migrate the column on next `memoryDb()` open; old rows read as NULL until reindexed (or the sqlite file is wiped and rebuilt from L0).

### 7.6 Open wiring questions

- ~~**Where does rollup generation run?**~~ **Resolved (2026-04-21):** deterministic reducer over L1+L0, not a librarian agent. See `lib/server/memory/rollup.ts`. A prose-producing librarian may layer on later; until then, mechanical rollups are the floor, not the ceiling.
- ~~**Schema evolution.**~~ **Resolved (2026-04-21):** L0 stays immutable; L1 rebuilds from L0 via `npm run swarm:reindex` (resumes per-run from `ingest_cursors.last_seq`, so re-runs are cheap). L2 rebuilds from `POST /api/swarm/memory/rollup` — upserts by `(swarm_run_id, session_id)`, so a schema bump is "drop `memory.sqlite`, re-POST". No dedicated migration tool; the two idempotent endpoints cover it.
- **Cross-run recall.** Still open as a policy question. The endpoint enforces *one* of `swarmRunID / sessionID / workspace` but doesn't isolate by workspace when a caller sets only `swarmRunID`. Agents that want "runs on this repo, not that repo" must pass `workspace` explicitly. Consider adding a config knob (`recallWorkspaceIsolation: 'strict' | 'permissive'`) when the cross-repo question shows up in practice — don't pre-build it.

### 7.7 Retention lifecycle

Runs are durable training signal — deletion is the wrong default. Three states, not four:

| State | Trigger | Disk effect |
|---|---|---|
| **active** | run created | `meta.json` + uncompressed `events.ndjson` |
| **compressed** | status ∈ {idle, error} for >24h | `events.ndjson` → `events.ndjson.gz`; `meta.json` untouched |
| **archived** | *deferred — only if disk pressure actually appears* | move dir to `.opencode_swarm/archive/` (or S3) |

**Why compression beats archiving at this stage.** Compression is reversible, cheap, and keeps the "grep across all runs" affordance intact (`zcat events.ndjson.gz | jq`). Archiving introduces a second "where does a run live?" question for no current payoff.

**Implementation (shipped 2026-04-21).**
- `readEvents()` in `lib/server/swarm-registry.ts` falls back to `events.ndjson.gz` via a `createGunzip()` pipeline when the plain file is missing — consumers don't know or care which state a run is in.
- `npm run swarm:compress` (`scripts/compress.mjs`) walks every run, uses `events.ndjson` mtime as the idle signal (≥24h), gzips via atomic `.gz.tmp → rename`, then unlinks the plain. A partial crash is recoverable on the next sweep: both files coexisting means the gzip finished but the unlink didn't, so the sweep removes the plain and reports `cleanup`.
- The runs picker stays read-only (no delete/archive buttons). Retention is a backend concern; the picker is pure discovery. See the comment at the top of `components/swarm-runs-picker.tsx`.

**Dev-stage cleanup.** `rm -rf .opencode_swarm/runs/<id>/` is fine. `listRuns()` already skips malformed/missing meta, so partial deletes don't break the list endpoint.

Decided 2026-04-21.

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

- **Roster badge (shipped).** `ActiveTodoChip` in `components/agent-roster.tsx` shows every in-progress todo an agent owns; popover lists the full set and click-to-focus jumps to the Plan tab + flashes the row.
- **Timeline affordance (shipped).** A `task` delegation card surfaces the originating todo item inline as a `todo·X` button (`components/timeline-flow.tsx`); hover shows the full content, click jumps to the Plan tab.
- **Inspector drawer (partial).** Plan → timeline hop still TODO — clicking a todo in the plan rail should scroll the timeline to the bound `task` card. The reverse hop (timeline → plan) is live.
- **L2 rollup field (shipped).** `AgentRollup.artifacts[].originTodoID` closes the loop from memory back to intent. The reducer attributes each patch temporally to the todo that was `in_progress` at patch time — keyed on `sha256(todo.content)[:16]` so the ID survives plan edits as long as the content is stable. The retro viewer resolves back to todo text by re-hashing the final plan's todos.

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
- **Cost ceiling enforcement = hybrid (per-session model selection + root gate).** Per-session dispatch loops read `bounds.costCap` to pick the cheapest capable model within remaining headroom (§6 step 7). The root-session **gate** is the hard wall: before the `/api/opencode` proxy forwards a `/prompt` or `/prompt_async` for a swarm-managed session, the server compares the run's accumulated `$` against `bounds.costCap` and returns 402 if exceeded. Direct `?session=` flows (no swarmRunID) are ungated — they're opting out of swarm management by construction. Shipped (2026-04-21): gate lives in `app/api/opencode/[...path]/route.ts`; the session→swarmRunID lookup is `findRunBySession` in `lib/server/swarm-registry.ts`, a process-local Map seeded by `createRun()` and lazily refilled from disk on miss. Runs without `bounds.costCap` declared are ungated for the same reason as direct flows — no cap, no wall. Probe failures (opencode unreachable, session vanished) let the prompt through; availability beats false-positive blocks when the cost signal is missing. The 402 surfaces in the browser via `CostCapError` (thrown by `postSessionMessageBrowser`) → `CostCapBanner` above the composer, with a `raise cap` action that opens the routing modal. Dismissal is local-state only; the block re-appears on the next send if the cap hasn't moved.
- **Branch / fork = `session.children` + `session.revert`, not new git branches.** A "branch from here" action maps to: create a child session via `session.create({ parentID })`, then if the user picked a non-tail node, `session.revert({ messageID })` to rewind. Git-branch-per-run was considered and rejected — it puts repo-level cost behind a UI action that's meant to be cheap exploration. The palette's aspirational `branch` / `detach` action stubs were **removed** until a concrete UI story for "pick a node and branch" exists; reintroduce them wired, not as placeholders.
- **Compaction = both manual and automatic.** Manual: a palette action that calls `session.summarize`. Automatic: the dispatch loop watches `info.tokens.total` vs. the model's context window and fires `summarize` around 80% utilization (configurable per-model). Both produce a `compaction` part that renders as a timeline marker. The palette's aspirational `compact` stub was **removed** until the summarize call + context-window lookup are wired.
- **A2A typed pins = `task`-tool dispatch only, for now.** opencode has no richer A2A schema today (`docs/opencode-vocabulary.md` line 160). The timeline has exactly one wire style (`task` → `subtask`) and that's the correct count. If opencode later ships typed pins, the timeline grows a second wire style — not a rewrite. This item is closed as *reactive* — we don't decide before opencode does.
- **Authentication = out of scope, not deferred.** Personal-use deployment only (never SaaS, never multi-tenant, never multi-instance — see the `deployment-scope` memory). `auth.set` exists in the SDK but is never surfaced; there is no login screen, no token UI, no account switcher. The `kk` chip in the topbar is a cosmetic placeholder, not a feature stub. If this ever changes, it changes in response to a new product direction, not a missing piece.

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
| `lib/opencode/live.ts` | Browser-side hooks that poll opencode (session / messages / diff / permissions / health / runs) |
| `lib/opencode/transform.ts` | opencode payload → `Agent`, `AgentMessage`, `RunMeta`, `ProviderSummary`, `LiveTurn`, `TodoItem` |
| `lib/part-taxonomy.ts` | Part/tool color map + `isCrossLane()` predicate |
| `lib/playback-context.tsx` | Run clock + per-part phase machine |
| `docs/opencode-vocabulary.md` | Detailed canonical vocab from opencode SDK |

---

## 12. The one rule

**Ship surfaces with single contracts.** A panel is either declarative (rules / config / state) or imperative (actions / events / commands). Never both. The `observation` eyebrow tooltip on the routing modal explains why — read it before adding a "force redispatch" or "halt all" button there, or a "save preset" to the spawn modal. Declarative bounds and derived readouts can coexist in one panel; declarative bounds and an imperative kill switch cannot.
