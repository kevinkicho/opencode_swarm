# Architecture & Runtime Compendium

Reference material for debugging and extending `opencode_enhanced_ui`. Read
in this order when onboarding: **CLAUDE.md → DESIGN.md → this file →
SWARM_PATTERNS.md → WHAT_THIS_PROJECT_IS_NOT.md → docs/opencode-vocabulary.md**.

This document answers two questions:

- *"Where do I look when X breaks?"* — see §4 Debugging Playbook.
- *"What do I touch when I want to add Y?"* — see §3 Extension Recipes.

Everything architectural that isn't here is already canonical in one of the
siblings above. Cross-links are preferred over duplication.

---

## 1. Runtime data-flow

### 1.1 The pipeline

```
opencode HTTP API                          (process running on 127.0.0.1:<port>)
        │
        │  GET /project, GET /session?directory=…, GET /session/{id}/message
        │  SSE: GET /event      (one stream, all session events)
        ▼
app/api/opencode/[...path]                 (Next.js catch-all proxy)
        │
        │  rewrites origin + forwards auth header + streams bytes through
        ▼
lib/opencode/live.ts                       (browser-only thin client + hooks)
        │  - useLiveSession(id, dir)     → rolling messages[] + status
        │  - useLivePermissions(dir)     → pending[] + reply()
        │  - useSessionDiff(id, dir)     → DiffData[] per-turn
        │  - useLiveSessions()           → picker list
        │  - useOpencodeHealth()         → live / offline / checking
        ▼
lib/opencode/transform.ts                  (pure functions, no hooks)
        │  toAgents(messages)              → Agent[]          (roster)
        │  toMessages(messages, agents)    → AgentMessage[]   (timeline)
        │  toRunMeta(messages, session)    → RunMeta          (topbar + bounds)
        │  toRunPlan(messages)             → TodoItem[]       (plan rail)
        │  toLiveTurns(messages)           → LiveTurn[]       (commit history)
        │  toProviderSummary(agents, msgs) → ProviderSummary[](provider strip)
        │  parseSessionDiffs(raw)          → DiffData[]       (diff viewer)
        ▼
app/page.tsx (PageInner, PageBody)         (composition + context providers)
        │  assembles: Agent[], AgentMessage[], RunMeta, ProviderSummary[],
        │  TodoItem[], DiffData[] into a single `view` snapshot, layers the
        │  permissions state, applies routing bounds → per-agent tokensBudget
        ▼
components/*                               (presentational, props-driven)
           swarm-timeline, agent-roster, plan-rail, provider-stats,
           permission-strip, inspector, routing-modal, new-run-modal, …
```

### 1.2 The one-message trace

A single `message.part.updated` SSE event becomes a rendered timeline row
via this sequence:

1. **Origin.** opencode emits `{ type: 'message.part.updated', properties: { part, messageID } }` on its SSE stream.
2. **Proxy.** `app/api/opencode/[...path]` streams it through to the browser (no transform, just host rewrite + auth).
3. **Client buffer.** `useLiveSession` in `live.ts:248` appends/updates the part inside its local `OpencodeMessage` buffer. Keeps everything in an `Array<{ info, parts[] }>` shape.
4. **Transform.** `app/page.tsx` re-runs `toMessages(messages, agents)` on every snapshot delta. `toMessages` normalizes parts to `AgentMessage` (with `fromAgentId` / `toAgentIds`, `PartType`, tool-state).
5. **Composition.** `PageBody` receives `AgentMessage[]`, hands them to `SwarmTimeline`.
6. **Render.** `SwarmTimeline` groups by timestamp bucket, delegates to `TimelineNode` + `PartChip` for in-lane vs cross-lane choice (see DESIGN.md §2 for the wires-vs-chips contract).

### 1.3 SSE events that the UI actually reads

Only four event shapes are consumed right now. Everything else is still at
parity via periodic `GET /session/{id}/message` refresh.

| Event | Handler | Purpose |
|---|---|---|
| `message.part.updated` | `useLiveSession` (`live.ts:248`) | Timeline, roster, plan, provider-summary all react |
| `message.updated` | `useLiveSession` (`live.ts:248`) | Updates `info.time.completed`, `info.error`, token totals |
| `permission.asked` | `useLivePermissions` (`live.ts:484`) | Permission-strip shows a pending request |
| `permission.replied` | `useLivePermissions` (`live.ts:484`) | Clears the pending request |

Periodic refresh (`POLL_INTERVAL_MS = 30_000`) re-fetches the full
`/session/{id}/message` response and overwrites the local buffer. This is
the safety net for dropped streams — see DESIGN.md §6.5 for opencode
API quirks.

### 1.4 The "live vs mock" split

`app/page.tsx` switches between mock fixtures and live opencode data based
on URL params:

- **No params** → `swarm-data.ts` mock. Used for designing surfaces
  without a running opencode.
- **`?session=<id>`** → `useLiveSession(id, dir)` + transforms. Direct
  deep-link to an opencode session created outside the swarm-run flow.
- **`?swarmRun=<id>`** → `useLiveSwarmRun(id)` resolves to the run's
  primary sessionID, which then feeds the same `useLiveSession` pipeline.
  Preferred URL because it carries run-level context (workspace, bounds,
  source). See §1.5.

The Agent / AgentMessage / RunMeta / TodoItem / ProviderSummary shapes are
identical in all paths — every component is agnostic. See
`memory/feedback_prototype_first.md` for why we keep the mock layer alive.

### 1.5 The swarm-run pipeline

A parallel entry point to §1.1. §1.1 starts from an already-created opencode
session; §1.5 starts from the new-run modal and walks the creation, dispatch,
and multiplexed-event path through the Next.js server.

```
components/new-run-modal.tsx           (handleLaunch)
        │
        │  POST /api/swarm/run       { pattern, workspace, source?, directive?,
        │                               title?, teamSize?, bounds? }
        ▼
app/api/swarm/run/route.ts             (validate → create → persist → respond)
        │  1. reject pattern !== 'none' with 501
        │  2. createSessionServer(workspace, title)  → opencode session
        │  3. postSessionMessageServer(sessionID, workspace, directive)
        │     (fire-and-forget; failure is logged, run continues)
        │  4. createRun(req, [sessionID])
        │     writes .opencode_swarm/runs/<id>/meta.json
        ▼
browser receives SwarmRunResponse      { swarmRunID, sessionIDs, meta }
        │
        │  router.push(`/?swarmRun=<id>`)
        ▼
app/page.tsx (PageInner)               (URL → sessionID resolver)
        │  useLiveSwarmRun(swarmRunID) → fetches /api/swarm/run/:id → meta
        │  effective sessionId = meta.sessionIDs[0]
        │
        │  from here the flow is identical to §1.1:
        │  useLiveSession(sessionId) → transform.ts → view snapshot
        ▼
rendered UI (same components as direct-session path)

┌─ parallel stream (started per-run, lives in parallel to useLiveSession) ──┐
│                                                                           │
│  GET /api/swarm/run/:id/events                                            │
│        │                                                                  │
│        │  opens ONE upstream to opencode /event?directory=<workspace>     │
│        │  filters frames where properties.sessionID ∈ meta.sessionIDs     │
│        │  tags each with { swarmRunID, sessionID, ts, type, properties }  │
│        │  appends SwarmRunEvent JSON to events.ndjson  (L0 log)           │
│        │  forwards tagged frames as SSE to the browser                    │
│        ▼                                                                  │
│  browser consumers (future: provenance panel, cross-session chips)        │
└───────────────────────────────────────────────────────────────────────────┘
```

Ownership split:

| Layer | Where it lives | Role |
|---|---|---|
| wire types | `lib/swarm-run-types.ts` | shared browser/server — `SwarmRunRequest/Meta/Response/Event` |
| persistence | `lib/server/swarm-registry.ts` | `createRun`, `getRun`, `appendEvent` — server-only |
| opencode fan-out | `lib/server/opencode-server.ts` | `createSessionServer`, `postSessionMessageServer` — server-only |
| HTTP surface | `app/api/swarm/run/route.ts`, `.../[swarmRunID]/route.ts`, `.../[swarmRunID]/events/route.ts` | POST create · GET meta · GET SSE multiplex |
| browser resolver | `useLiveSwarmRun` in `lib/opencode/live.ts` | fetches meta; exposes `primarySessionID`, `workspace` |
| UI entry | `components/new-run-modal.tsx` → `app/page.tsx` PageInner | POST launch · URL-param branch |

Invariants:

- **Multi-session by pattern.** `pattern='none'` runs N=1; `council`,
  `blackboard`, and `map-reduce` all spawn N sessions on create
  (`sessionIDs[]` populated) and their coordinators run concurrently —
  blackboard via per-session tick fan-out in
  `lib/server/blackboard/auto-ticker.ts` (shipped 2026-04-22), map-reduce
  via parallel fan-out with a blackboard-routed synthesis claim, council
  via the workspace-scoped SSE multiplexer. Wire shapes have been plural
  since v1.
- **Preset dispatch ships for `none` / `council` / `blackboard` /
  `map-reduce`.** Stigmergy is still unimplemented and will 501 if ever
  exposed through the UI — it's a layer over blackboard, not a separate
  dispatch path. See `SWARM_PATTERNS.md` §4.
- **L0 events.ndjson is the authoritative replay source**, not the live
  SSE stream. Future analytics / rollup workers read from disk; the live
  stream is a convenience for the browser.
- **The multiplexer filters by `properties.sessionID`.** Events without a
  sessionID (global opencode events) are dropped. A future swarm-coordinator
  event type would opt back in here.

---

## 2. Component & file role map

One line per file. If a file is unlisted, it's either trivial (single-
purpose) or its role is obvious from its name.

### `app/`

| File | Role |
|---|---|
| `page.tsx` | Top-level composition. Holds `PageInner` (live data, permissions, bounds layering) and `PageBody` (pricing-aware per-agent budget, renders the shell). |
| `layout.tsx` | Next.js app shell; global fonts, metadata, CSS entry. |
| `globals.css` | Tailwind theme tokens, ink/fog/molten/mint/iris/amber palette, hairline utilities, `text-micro`. |
| `api/opencode/[...path]/route.ts` | Server-side proxy to the opencode HTTP API. Rewrites origin and forwards auth. |
| `debug/opencode/page.tsx` | Dev harness for probing opencode endpoints without touching the main UI. |

### `lib/` (domain + state)

| File | Role |
|---|---|
| `swarm-types.ts` | **Source of truth.** Agent / AgentMessage / RunMeta / TodoItem / ProviderSummary / Provider / SwarmPattern / ToolName / PartType / EventType. |
| `swarm-data.ts` | Mock-data fixtures for the `?session` unset path. |
| `swarm-patterns.ts` | UI metadata for the new-run-modal preset picker. Keep in sync with `SWARM_PATTERNS.md`. |
| `routing-bounds-context.tsx` | `RoutingBoundsProvider` — localStorage-backed run-wide bounds (`costCap`, `tokenCap`, `minutesCap`, ceilings). |
| `provider-context.tsx` | `ProviderStatsProvider` — exposes current agents/run to `ProviderStats` popover. |
| `playback-context.tsx` | Controls timeline scrub / replay state. Mock-only at v1. |
| `model-catalog.ts` | Local catalog of model metadata for the roster's model-label lookups. |
| `zen-catalog.ts` | Curated zen model list for new-run-modal's team picker. `fmtZenPrice` formats dollars. |
| `part-taxonomy.ts` | `PartType` → icon/label/variant mapping used by `part-chip.tsx`. |
| `agent-status.ts` | Status → color/label/glyph mapping used by the roster and inspector. |
| `format.ts` | `compact()` for tokens, timestamp helpers, small formatters. |
| `types.ts` | DiffData / DiffHunk / DiffLine — the diff viewer's shape. |
| `mock-data.ts` | Historical mock fixtures still referenced by one or two surfaces. |

### `lib/opencode/` (live wiring)

| File | Role |
|---|---|
| `types.ts` | Wire-format mirrors of opencode's SDK shapes: `OpencodeMessage`, `OpencodePart`, `OpencodeSession`, `OpencodeTokenUsage`, `OpencodePermissionRequest`. |
| `client.ts` | `getJsonBrowser` + fetch helpers. Everything in `live.ts` routes through here. |
| `live.ts` | Browser hooks (`useLiveSession`, `useLivePermissions`, `useSessionDiff`, `useLiveSessions`, `useOpencodeHealth`) + POST helpers (`createSessionBrowser`, `postSessionMessageBrowser`, `abortSessionBrowser`, `replyPermissionBrowser`). |
| `transform.ts` | Pure projections from `OpencodeMessage[]` → our UI shapes. Zero hooks, zero fetches. |
| `pricing.ts` | opencode zen per-1M-token price table + `priceFor` / `tokensForBudget` / `withPricing`. See `memory/reference_opencode_zen_pricing.md`. |

### `components/` (presentation)

| File | Role |
|---|---|
| `swarm-timeline.tsx` | Main timeline render. Groups by time bucket, picks wires vs chips. |
| `timeline-node.tsx` | Single cross-lane event with wires into / out of lane columns. |
| `timeline-flow.tsx` | SVG wire layout between nodes. |
| `part-chip.tsx` | Compact in-lane chip (tool / internal events docked under A2A rows). See `memory/project_tool_chip_docking.md`. |
| `agent-roster.tsx` | Left-rail agent list. Identity + status + tokens ratio. |
| `plan-rail.tsx` | Plan / todo list. Clicks jump to bound `task` tool call (see §3 recipe). |
| `left-tabs.tsx` | Tab strip above roster/plan for switching views. |
| `swarm-topbar.tsx` | Run title, total tokens/cost, provider strip, routing button. |
| `swarm-composer.tsx` | Bottom input + agent target picker. POSTs to opencode. |
| `sidebar.tsx` | Right rail drawer trigger + inspector host. |
| `inspector.tsx` | Expanded detail drawer for selected agent/message. |
| `provider-stats.tsx` | Popover with tokens / cost / budget-per-provider. |
| `provider-badge.tsx` | Small provider tag used in roster rows. |
| `permission-strip.tsx` | Strip above composer when opencode asks for tool approval. |
| `routing-modal.tsx` | **Declarative** policy editor (draft-then-commit). |
| `new-run-modal.tsx` | **Imperative** run launcher: source + workspace + pattern + team + … |
| `spawn-agent-modal.tsx` | **Imperative** spawn of an individual agent into the current session. |
| `glossary-modal.tsx` | Actor / transcript vocabulary reference. Not API docs. |
| `command-palette.tsx` | Keyboard-first jump to agents / messages / runs. |
| `commit-history.tsx` / `live-commit-history.tsx` | Branch-history drawer (mock and live versions). |
| `diff-view.tsx` | Per-turn unified diff renderer. |
| `live-session-picker.tsx` | Picker for swapping the active `?session=`. |
| `event-info.tsx` | Event-stream health badge. |
| `statusbar.tsx` | Bottom status bar (health, session id). |
| `topbar.tsx` | Higher-level topbar host wrapping `swarm-topbar`. |
| `chat-pane.tsx` | Text-only transcript view of an agent's messages. |
| `icons.tsx` | Stroke-icon set used across the UI. |
| `ui/` | Low-level primitives (Modal, Tooltip, Popover). **Declarative vs imperative separation lives here.** |

Surface contracts (one-liner each) are in `CLAUDE.md`'s "Surface contracts" table. The *why* behind each lives in DESIGN.md §12 and the `memory/` folder.

---

## 3. Extension recipes

### 3.1 Add a new tool chip (e.g. a new opencode tool like `notebook`)

1. **`lib/swarm-types.ts`** — add to `ToolName` union.
2. **`lib/opencode/transform.ts`** — add to `KNOWN_TOOLS` array at file top. Without this, `normalizeTool()` drops the tool and it won't show up in `Agent.tools`.
3. **`lib/part-taxonomy.ts`** — add icon/label/variant entry so `part-chip.tsx` renders it.
4. **(Optional) `docs/opencode-vocabulary.md`** — add to the tool table for posterity.

**Verify:** dispatch a session that exercises the tool. The chip should appear docked under the assistant's row per `memory/project_tool_chip_docking.md`.

### 3.2 Wire a new SSE event

1. **`lib/opencode/types.ts`** — model the event's `properties` shape.
2. **`lib/opencode/live.ts`** — either extend `useLiveSession` (for per-session events) or write a new hook mirroring `useLivePermissions` (for cross-session state). Subscribe inside the existing `EventSource` block at `live.ts:282` or open a dedicated `EventSource` at `live.ts:515` (scope-dependent).
3. **`lib/opencode/transform.ts`** — if the event requires projecting into existing UI shapes, add a new `toFoo` function. Keep it pure.
4. **`app/page.tsx`** — wire the hook's output into the `view` snapshot and pass to whichever component consumes it.

**Verify:** type-check + fire the event from opencode and confirm the new state propagates without needing a poll-refresh.

### 3.3 Add a model to the pricing table

1. **`lib/opencode/pricing.ts`** — add entry to `PRICES` keyed by canonical slug, then add a regex to `LOOKUP` (more-specific patterns first — ordering matters, the first matching regex wins).
2. **`lib/zen-catalog.ts`** — if the model should appear in the new-run-modal team picker, add it here too.

**Verify:** `priceFor('<test-model-id>')` returns the entry. No type-check signal — the ordering bug is behavioral.

### 3.4 Promote a pattern preset from "soon" to "available"

1. **`lib/swarm-patterns.ts`** — flip `available: false` → `true` for the preset.
2. **`SWARM_PATTERNS.md`** — move the preset's status marker from `[ ]` to `[~]` or `[x]`. Update the §Roadmap table if the order shifts.
3. **Backend work** — unless the preset genuinely runs on opencode-native (only `none` does today), also ship the coordinator pieces listed in SWARM_PATTERNS.md §"Backend gap".

**Verify:** tile becomes selectable in new-run-modal → step 03; launch-time still works (for `none` anyway).

### 3.5 Add a new routing-bound field

1. **`lib/routing-bounds-context.tsx`** — extend `RoutingBounds` and `defaultBounds`.
2. **`components/routing-modal.tsx`** — add a draft-state field + control; save handler already generic. Keep the declarative stance per DESIGN.md §12 — no "apply now" button.
3. **Consumers** — if the bound gates behavior (e.g. another `tokensForBudget`-style derivation), wire in `app/page.tsx`'s `PageBody` where `bounds` is already consumed.

**Verify:** persist via localStorage round-trip, confirm save-dirty indicator behavior.

### 3.6 Add a new `PartType`

1. **`docs/opencode-vocabulary.md`** — record the opencode SDK name first. Don't invent synonyms (see CLAUDE.md "Never").
2. **`lib/swarm-types.ts`** — add to `PartType` union.
3. **`lib/opencode/transform.ts`** — add to `KNOWN_PARTS` + `synthesizeTitle` switch. Wire `bodyOf` / `previewOf` if the UI needs to render body/preview.
4. **`lib/part-taxonomy.ts`** — icon/label/variant.

**Verify:** a message carrying the new part renders without falling through to the `'text'` default.

---

## 4. Debugging playbook

Symptoms first. Each row is the two or three files most likely at fault, plus the first thing to check.

| Symptom | Where to look first | First check |
|---|---|---|
| Roster is empty | `lib/opencode/transform.ts:172` (`toAgents`) | Are there assistant-role messages in the buffer? Agents are derived from `info.agent` on assistant messages only. |
| Agent status stuck on `thinking` | `transform.ts:239-287` (status derivation) | Is this the session's latest message? Status only fires `working/thinking` for the overall-last speaker. See `memory/reference_opencode_zombie_messages.md` for the 10-min stale threshold. |
| Plan-rail item not clickable | `transform.ts:532-594` (task/todo matching) | Is the todo content specific enough (≥ 3 non-stopword tokens)? Containment threshold is 0.5. |
| Provider strip shows wrong numbers | `transform.ts:36-65` (`providerOf` / `derivedCost`) + `transform.ts:742` (`toProviderSummary`) | Is `info.cost` populated, or are we falling back to pricing-derived cost? Compare against `lib/opencode/pricing.ts` expected rates. |
| Timeline missing rows | `live.ts:248` (`useLiveSession`) + `transform.ts:283` (`toMessages`) | Are `message.part.updated` events arriving? Use the EventSource in devtools Network → EventStream tab. |
| Permission strip never appears | `live.ts:484` (`useLivePermissions`) | Does `GET /permission?directory=…` return pending? The hook hydrates on mount; strip requires non-empty `pending[]`. |
| Permission strip won't clear | `live.ts:557`/`573` (reply helpers) + SSE `permission.replied` | If POST succeeds but UI stays stuck, the `permission.replied` event handler isn't matching IDs. Log `parsed.properties.id` vs pending IDs. |
| Diff viewer empty mid-session | `live.ts:345` (`useSessionDiff`) + DESIGN.md §6.5 | `/session/{id}/diff` is session-aggregate; `?messageID=` is ignored. Per-turn filter happens in `filterDiffsForTurn`. |
| Session picker reshuffles on poll | `live.ts:392` (`useLiveSessions`) | Backend drops session-list ordering stability around index 235. Client sorts by immutable `id`. See `memory/reference_opencode_session_order.md`. |
| Routing bounds don't persist | `lib/routing-bounds-context.tsx` | localStorage key drift? The provider hydrates on mount; check DevTools → Application → Local Storage. |
| Timeline wire goes to the wrong card | `components/timeline-flow.tsx` | Wires end on target lane *column*, not receiver card, by design. See `memory/project_timeline_drop_pattern.md`. |
| New tile in new-run-modal not selectable | `lib/swarm-patterns.ts` | `available: false` gates the click handler. Flip to true only when a backend exists. |
| Costs aggregate wrong after model switch | `lib/opencode/pricing.ts` `LOOKUP` order | Specific patterns must precede generic ones (e.g. `gpt-5-4-pro` before `gpt-5-4`). |
| Composer sends to the wrong agent | `lib/opencode/live.ts:148` (`postSessionMessageBrowser`) | Is the `opts.agent` arg populated from the composer's target picker? See `memory/project_run_initiation.md`. |

### 4.1 Provenance tips

- Before chasing a rendering bug, confirm the data shape. Use `app/debug/opencode/page.tsx` to inspect raw opencode responses.
- When memory suggests a fix, verify the cited function still exists — memory can go stale. Grep for the exact symbol before trusting it.
- For any timeline / status issue, check `info.error` on the latest assistant message first. opencode writes error info there for both real errors and user-triggered aborts (`MessageAbortedError`).

---

## 5. What this document is not

- Not an API reference — the opencode HTTP API lives at opencode's own docs; our notes on it live in DESIGN.md §6.5 (quirks) and `docs/opencode-vocabulary.md` (canonical names).
- Not a design-decisions log — WHAT_THIS_PROJECT_IS_NOT.md owns that. If you're tempted to add a "why we rejected X" section here, it belongs there.
- Not a changelog — git log is authoritative. Memory files capture *durable* learnings; commit bodies capture the *why* of a specific change.
- Not a style guide — CLAUDE.md's "Always / Never" section owns that.

When this file drifts from reality, the failure mode is quiet: an extension recipe references a function that moved, a debugging row points at the wrong line. Keep recipes file-pointer-shallow (names, not line numbers where possible) so they survive routine edits.
