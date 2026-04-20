# opencode_swarm — Design Plan

> Read this before writing backend code, opening a feature PR, or extending the timeline.
> It is the single source of truth for *why* the UI is shaped the way it is.

**Status:** UI prototype only. All data is mocked in `lib/swarm-data.ts`. There is no backend yet. This document is the brief for the team (human or AI) that will wire the real opencode runtime to this surface.

---

## 1. Vision

Run opencode as a **swarm**, not a single chat. Multiple specialist agents (orchestrator, architect, coder, researcher, reviewer) work in parallel against one mission. Every tool call, every sub-agent spawn, every routing decision is a first-class visual event on a timeline you can actually read — no scrollback hunting, no buried context.

The UI's job is to make a 5-agent run as legible as a 1-agent run. That is the entire premise.

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
- **Topbar** — mission title, $ budget chip, go-tier rolling cap chip, agent count, palette/settings/account.
- **Roster** (260px left rail) — collapsed agent rows: accent stripe, status circle, name, attention badge.
- **Timeline** (1fr center) — sticky lane headers + event canvas (see below).
- **Composer** (bottom) — typed message dispatch with target picker (broadcast / specific agent / human).
- **Status rail** (footer) — live websocket dot, palette / routing / glossary / branch-history triggers.
- **Drawer** (right, 380px) — inspector for the focused message OR selected agent.
- **Modals** — palette (⌘K), routing policy, branch history, spawn agent, glossary.

### Timeline internals — `components/swarm-timeline.tsx` + `components/timeline-flow.tsx`
- Each row = one **lead A2A event** + 0..N **chip events** docked beneath.
- Cards are NODE_WIDTH=164 (just under LANE_WIDTH so they sit inside the lane).
- Wires: SVG paths from sender card right/left edge to receiver lane center; drop dot at receiver lane.
- Lane axis lines are drawn at `i * LANE_WIDTH + LANE_WIDTH/2` (lane center), not at boundaries.
- Playback clock (see `lib/playback-context.tsx`) phases each part: `hidden → streaming → settled`. Future-time events are filtered out, current ones animate in.

### Modals (each has a clear contract — do not mix)
- **Spawn modal** (`spawn-agent-modal.tsx`) — *imperative*. Creates an agent now. Verb: `spawn`.
- **Routing modal** (`routing-modal.tsx`) — *declarative policy*. Edits per-role rules. Verb: `save`. Effect applies to *next dispatched subtask*. The `eyebrow="policy"` tooltip explains this contract in-product.
- **Branch history** (`commit-history.tsx`) — *read-only*. Mission log of commits / prompts / tools / reviews.
- **Glossary** (`glossary-modal.tsx`) — *reference*. Canonical opencode parts, tools, events. Actor/transcript vocabulary only — API/config types are intentionally out of scope.
- **Palette** (`command-palette.tsx`) — *imperative*. ⌘K / Ctrl+K. Jump to any timeline node or trigger an action.

### Important conventions
- **Eyebrow tooltips** (`Modal.eyebrowHint`) — attach a wide hover tooltip to a modal's eyebrow when the eyebrow names a concept worth explaining (first use: `policy`).
- **Dense-factory aesthetic** — h-5/h-6 rows, tabular-nums, monospace, `text-micro` (10px) uppercase tracking-widest2 for labels, hairline borders (`hairline-b/t/r/l` from `app/globals.css`).
- **Provider tier vocabulary** — `zen` (pay-per-token marketplace) and `go` (subscription bundle). All routing decisions choose between these two. We do *not* expose BYOK in the UI; the user said "all users are assumed to use opencode zen/go".

---

## 5. State the UI expects (data contracts)

All shapes live in `lib/swarm-types.ts` and `lib/types.ts`. Today they're populated from `lib/swarm-data.ts` (mock). When wiring real opencode, these are the structures the backend must produce.

### `Agent`
```ts
{
  id: string,           // → child sessionID at runtime
  name: string,         // display name (config label)
  role: string,         // orchestrator/architect/coder/researcher/reviewer
  accent: 'molten' | 'mint' | 'iris' | 'amber' | 'fog',
  status: 'idle' | 'thinking' | 'working' | 'waiting' | 'paused' | 'done' | 'error',
  model: { provider: 'zen' | 'go', label: string },
  tools: ToolName[],
  currentTask?: string,
  tokensUsed: number, tokensBudget: number,
  costUsed: number,
  messagesSent: number, messagesRecv: number,
}
```

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

### `MissionMeta`, `ProviderSummary` — see `swarm-types.ts`.

---

## 6. Mock → real: the wiring plan

The UI is intentionally state-shaped, not request-shaped. To make it real, do this in order:

### Phase 1 — read-only mirror
1. **Subscribe to opencode SSE** (`event.subscribe` / `event.listen`). One websocket per opencode instance.
2. **Materialize sessions into agents.** Each child session of the parent mission becomes an `Agent` row. Map `session.status` → `Agent.status`. Initial config (name, model, tools) comes from `app.agents` for the agent definition referenced by the session.
3. **Materialize message parts into `AgentMessage`s.** Stream `message.part.updated` → append/update rows. Map opencode part types → our `PartType`. The `task` tool's invocation → `AgentMessage` with `part: 'tool'`, `toolName: 'task'`, and `toAgentIds` populated from the task's target agent.
4. **Wire mission meta.** Sum tokens/cost across child sessions → `MissionMeta.totalCost / totalTokens`. Window-roll for `goTier.used`.

At this point the UI shows a real run live, but cannot drive it.

### Phase 2 — control plane
5. **Composer dispatch** → `session.prompt` to the orchestrator session. Target picker (specific agent) → `session.prompt` directly to that child session.
6. **Spawn modal** → `session.create` with the chosen agent config; immediately appears in roster.
7. **Routing modal save** → write rules to a config endpoint; orchestrator agent reads them on next `task` dispatch. (Opencode does not have a routing-policy primitive natively; this layer is ours.)
8. **Permission flow** — when `permission.updated` fires, surface in the agent's attention badge; clicking jumps to inspector with accept/reject buttons that call `permission.replied`.

### Phase 3 — branch history (real VCS)
9. Replace `lib/commits-data.ts` with `vcs.branch.updated` + `file.edited` + `session.diff` aggregation. The current "branch history" modal shape already matches.

### Phase 4 — multi-tenant / multi-instance
10. Account chip in topbar becomes real (current `kk` placeholder). Mission picker. Cross-mission cost dashboard.

---

## 7. Decisions already made (do not re-litigate)

These are recorded so future contributors don't burn cycles re-asking:

- **Timeline drop-on-lane routing.** Wires terminate at the receiver *lane column*, not the receiver card. Intentional — it keeps the receiver lane free of visual debt and lets multiple incoming wires stack cleanly.
- **Tool/internal events dock as chips.** Not full timeline rows. Keeps cross-lane communication visually dominant, which is the entire point of the timeline.
- **A2A model = circuit board / typed pins.** We considered bounty-board, writers-room, and subpoena models. Circuit-board won because it preserves direct sender→receiver topology.
- **Glossary scope = actor/transcript vocabulary only.** API surface, config schemas, plumbing types are out of scope — they belong in code docs, not the user-facing glossary.
- **Provider universe = zen + go only.** No BYOK / local-model UI. Agents are configured by name only, never by source.
- **Agent name and directive are optional at spawn.** Frontier models don't need narrow scoping; directives matter for *coordination*, not capability. Spawn modal dims optional inputs to signal this.
- **Inspector dismissal = click-outside.** No "show inspector" footer button. Modern users dismiss via outside-click; the button was removed.

---

## 8. Open questions

These are explicitly *not* decided yet. Backend implementer is invited to propose:

- **Cost ceiling enforcement.** Where does the spend cap actually live? Orchestrator-side gate, or per-session middleware?
- **Branch / fork semantics.** Palette has a "branch from current node" action. Maps to `session.children` + revert? Or a new git branch + new mission?
- **Compaction trigger.** Manual via palette, or automatic at token threshold? UI assumes both.
- **A2A typed pins.** We assumed `task`-tool dispatch is the sole A2A primitive. If opencode introduces a richer A2A schema, the timeline needs a second wire style.
- **Authentication.** No auth UI exists. `auth.set` is the SDK method but not surfaced.

---

## 9. Files worth knowing

| Path | Purpose |
|---|---|
| `app/page.tsx` | Top-level layout shell, modal orchestration, keyboard shortcuts |
| `components/swarm-timeline.tsx` | Timeline scroll container + sticky lane headers + filter bar |
| `components/timeline-flow.tsx` | Card / wire / drop / chip layout math + SVG rendering |
| `components/agent-roster.tsx` | Left rail, attention badges, expanded agent panel |
| `components/inspector.tsx` | Right drawer content for focused message OR selected agent |
| `components/routing-modal.tsx` | Policy panel; eyebrow tooltip explains declarative contract |
| `components/spawn-agent-modal.tsx` | Imperative agent creation; family picker |
| `components/command-palette.tsx` | ⌘K palette with grouped jump targets and chip-formatted line items |
| `lib/swarm-types.ts` | Canonical TS types for Agent, AgentMessage, MissionMeta, etc. |
| `lib/swarm-data.ts` | **Mock data** — the seed for everything you see today |
| `lib/part-taxonomy.ts` | Part/tool color map + `isCrossLane()` predicate |
| `lib/playback-context.tsx` | Mission clock + per-part phase machine |
| `docs/opencode-vocabulary.md` | Detailed canonical vocab from opencode SDK |

---

## 10. The one rule

**Ship surfaces with single contracts.** A panel is either declarative (rules / config / state) or imperative (actions / events / commands). Never both. The `policy` eyebrow tooltip explains why — read it before adding a "force redispatch" button to the routing modal, or a "save preset" to the spawn modal.
