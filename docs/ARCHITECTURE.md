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

- **Multi-session by pattern.** `pattern='none'` runs N=1; everything else
  spawns N sessions on create (`sessionIDs[]` populated). Each pattern's
  background orchestrator lives in its own module under `lib/server/`
  and fires fire-and-forget from the POST handler after `createRun`
  returns — the HTTP response doesn't wait for orchestration.
- **Dispatch catalog (shipped 2026-04-23).** 9 patterns ship: `none`,
  `blackboard`, `council`, `map-reduce` (self-organizing), plus
  `orchestrator-worker`, `role-differentiated`, `debate-judge`,
  `critic-loop`, `deliberate-execute` (hierarchical — see §1.5.1).
  Stigmergy is still unimplemented — it's a layer over blackboard, not
  a separate dispatch path. Each pattern's POST body shape is in
  `SwarmRunRequest`; see `SWARM_PATTERNS.md` for per-pattern invariants.
- **L0 events.ndjson is the authoritative replay source**, not the live
  SSE stream. Future analytics / rollup workers read from disk; the live
  stream is a convenience for the browser.
- **The multiplexer filters by `properties.sessionID`.** Events without a
  sessionID (global opencode events) are dropped. A future swarm-coordinator
  event type would opt back in here.
- **The SSE proxy reshapes + coalesces.** `lib/server/sse-shaping.ts`
  strips redundant `summary.diffs` patches from `message.updated` frames,
  coalesces `message.part.updated` firehoses per part.id at 250 ms, and
  dedupes historical replay. Shipped 2026-04-23 after a long run's
  firehose choked browser tabs. Shaping runs AFTER `appendEvent` — L0
  stores the shaped frames so replay size shrinks too.

### 1.5.1 Hierarchical-pattern orchestrators

Five patterns shipped 2026-04-23 after retiring the earlier "no role
hierarchy" design stance (see DESIGN.md §1 history note). All five reuse
the blackboard board store + auto-ticker where they need execution, but
each wraps its own orchestration on top:

| Pattern | Orchestrator module | Shape |
|---|---|---|
| `orchestrator-worker` | `lib/server/orchestrator-worker.ts` | session 0 plans + dispatches; workers claim off board. Picker excludes orchestrator via `excludeSessionIDs` option on `tickCoordinator`. |
| `role-differentiated` | `lib/server/role-differentiated.ts` | N workers with pinned `agent={role}` identities. Roles bias self-selection (no hard routing at v1). `teamRoles[]` in request body or rotated defaults. |
| `critic-loop` | `lib/server/critic-loop.ts` | Exactly 2 sessions. Worker drafts → critic reviews ("APPROVED:" / "REVISE:") → worker revises. Loop up to `criticMaxIterations`. |
| `debate-judge` | `lib/server/debate-judge.ts` | N generators + 1 judge. Judge verdict: WINNER / MERGE / REVISE. Loops up to `debateMaxRounds`. |
| `deliberate-execute` | `lib/server/deliberate-execute.ts` | Compositional: council rounds (via `runCouncilRounds`) → synthesis (extracts todos via `todowrite` on session 0) → blackboard execution on the same session pool. |

### 1.5.2 Overnight-safety stack

Shipped 2026-04-23 after an 8-hour run diagnosed three compounding
failure modes. Everything below lives in `lib/server/blackboard/`:

- **Zombie auto-abort in the session picker** (`coordinator.ts`,
  `ZOMBIE_TURN_THRESHOLD_MS = 10 min`). opencode assistant turns can
  hang silently (no `completed`, no `error`); the coordinator used to
  skip those sessions forever as "busy," freezing dispatch. Now: if a
  session's oldest in-flight turn crosses 10 min, the picker fires
  `abortSessionServer` and treats the session as idle-for-dispatch.
- **Turn timeout raised to 10 min** (`DEFAULT_TURN_TIMEOUT_MS`). Matches
  the zombie threshold — substantive README-verification todos
  legitimately run past 5 min, and the previous 5-min cap was
  producing false `stale` transitions.
- **Eager re-sweep on drain** (`auto-ticker.ts`,
  `IDLE_TICKS_BEFORE_EAGER_SWEEP = 3`, `MIN_MS_BETWEEN_SWEEPS = 2 min`).
  When every session has been idle 30 s AND ≥ 2 min have elapsed since
  the last planner sweep, fires a fresh sweep immediately instead of
  waiting for the periodic timer. Converts "drain, then 15 min dead"
  into "drain, then 30-120 s gap, then new batch."
- **Periodic planner sweep** (`auto-ticker.ts`, configurable via
  `persistentSweepMinutes` in the request body). On when > 0; disables
  auto-idle-stop so the run only stops via explicit `stopAutoTicker`
  call, process shutdown, or `opencode-frozen` detection. Eager + periodic
  together: eager almost always wins the race; periodic is the safety net.
- **Opencode-frozen watchdog** (`auto-ticker.ts`,
  `FROZEN_TOKENS_THRESHOLD_MS = 10 min`, `STARTUP_GRACE_MS = 15 min`).
  Polls `deriveRunRow` every 60 s; stops the ticker with
  `stopReason: 'opencode-frozen'` if tokens haven't advanced for 10 min
  after once producing activity, or if tokens stayed 0 for 15 min from
  the start. Surfaces in `components/board-rail.tsx`'s ticker footer
  as `stopped · opencode-frozen` — distinct from `auto-idle` so the
  user knows to restart opencode rather than the ticker.
- **Opt-in opencode auto-restart** (`lib/server/opencode-restart.ts`).
  After the frozen watchdog stops a ticker, `maybeRestartOpencode` runs
  `OPENCODE_RESTART_CMD` via `child_process.spawn({ shell, detached,
  stdio: 'ignore' })` so the user's launcher (PowerShell one-liner,
  systemd user service, Docker restart, whatever) comes back up
  without human intervention. Zero-config when the env var is unset —
  the ticker stays stopped exactly as before. Module-level debounce
  at 10 min so a loop of restarts into a still-broken opencode doesn't
  hammer; the STARTUP_GRACE (15 min) naturally paces the next attempt.
  Ticker still needs a manual `POST …/board/ticker { action: 'start' }`
  after opencode comes back — the restart doesn't auto-resume so the
  user observes recovery explicitly.
- **Zen rate-limit probe** (`lib/server/zen-rate-limit-probe.ts`). Before
  declaring a stall as `opencode-frozen`, the watchdog tails opencode's
  own log directory (`OPENCODE_LOG_DIR`) for recent `statusCode":429`
  lines. If a 429 is present within the stall window, the ticker stops
  with `stopReason: 'zen-rate-limit'` instead, and `retryAfterEndsAtMs`
  is populated from the `retry-after` header when parseable. The UI
  renders a live countdown via `RetryAfterChip` in the topbar so the
  user knows to wait out the window rather than bounce opencode. No log
  dir = probe no-ops and every stall is attributed to "opencode-frozen"
  as before.
- **Session cleanup on run end** (`lib/server/finalize-run.ts`). For
  non-ticker orchestrators (council, map-reduce, debate-judge,
  critic-loop, deliberate-execute) the kickoff wraps its body in
  `try/finally` and calls `finalizeRun(swarmRunID)` to abort every
  session in `meta.sessionIDs` (plus `criticSessionID` / `verifierSessionID`
  when set). Ticker-driven patterns go through `stopAutoTicker` which
  has the equivalent hook. Closes the "run ended but opencode sessions
  still in-flight" gap that used to leak turns across restarts.
- **HMR-resilient module exports** (`lib/server/hmr-exports.ts`). Three
  modules publish their exports to `Symbol.for()` slots on `globalThis`:
  `coordinator.ts` (tickCoordinator, waitForSessionIdle), `planner.ts`
  (runPlannerSweep), `auto-ticker.ts` (fanout, runPeriodicSweep,
  checkLiveness). Consumers read via `liveExports(key, fallback)` at
  call time — `setInterval` callbacks in `auto-ticker.ts` all go through
  `liveAutoTicker()` / `liveCoordinator()` / `livePlanner()`. Means
  edits to any of these three files take effect on the next tick
  without needing a ticker restart. Fixes a multi-hour debug loop
  from 2026-04-23 where HMR reloaded modules but `setInterval` closures
  still referenced the old function bodies.
- **Browser ChunkLoadError auto-reload** (`components/chunk-error-reload.tsx`
  + `lib/lazy-with-retry.ts`). `dynamic()` loaders wrap through
  `lazyWithRetry` (4 retries, ~15 s total budget). A window-level error
  listener catches any chunk-load errors that escape the wrapper and
  reloads the tab with a brief overlay. URL state (`?swarmRun=...`)
  preserves context across the reload.

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
| `api/swarm/run/[swarmRunID]/tokens/route.ts` | GET per-session + aggregate token/cost breakdown for one run. Uses `deriveRunTokens` from `swarm-registry.ts`; role-labels sessions via `roleNamesBySessionID` so hierarchical-pattern drill-downs name sessions by role. Added 2026-04-23 after the overnight deep-check had no HTTP way to answer "did we pass the token threshold?". |
| `api/swarm/run/[swarmRunID]/board/retry-stale/route.ts` | POST bulk-reopens stale board items (clears `ownerAgentId` / `fileHashes` / `staleSinceSha` / retry-count note; transitions `stale → open`). Auto-restarts the ticker if the pattern is in `TICKER_PATTERNS` and ticker is stopped. The recovery path for rate-limit stranded runs documented in `memory/reference_opencode_freeze.md`. |
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

### `lib/server/` (Node-only backend)

Server-only modules. Not importable from client components — guards via the
`'use client'` boundary. Each pattern orchestrator module is fire-and-
forget from `app/api/swarm/run/route.ts`; they return Promise\<void> and
the POST response doesn't wait on them.

| File | Role |
|---|---|
| `swarm-registry.ts` | `createRun` / `getRun` / `listRuns` / `appendEvent` / `readEvents` / `deriveRunRow` / `deriveRunTokens`. L0 events.ndjson is authoritative per §1.5 invariants. `deriveRunTokens` is the per-session-grain companion to `deriveRunRow` — callers that need only the aggregate stay on `deriveRunRow` (it's on the 4 s poll hot path); drill-downs use `deriveRunTokens`. |
| `opencode-server.ts` | Server-side opencode HTTP helpers: `createSessionServer`, `postSessionMessageServer`, `abortSessionServer`, `getSessionMessagesServer`. Mirror of the browser helpers in `lib/opencode/live.ts`. |
| `sse-shaping.ts` | `reshapeForForward` + `PartCoalescer` + `dedupeReplay` (see §1.5 invariants). |
| `hmr-exports.ts` | `publishExports` / `liveExports` helpers for the HMR-resilient globalThis-stash pattern (see §1.5.2). |
| `council.ts` | `runCouncilRounds` — council auto-rounds (R2/R3 peer-revise after Round-1 directive broadcast). Fires from the POST handler when `pattern='council'`. |
| `map-reduce.ts` | `runMapReduceSynthesis` + `buildScopedDirective` + `deriveSlices`. |
| `orchestrator-worker.ts` | `runOrchestratorWorkerKickoff` — session 0 planner + worker-only dispatch. |
| `role-differentiated.ts` | `runRoleDifferentiatedKickoff` + `resolveTeamRoles` — pinned `agent={role}` per session, architect seeds board on session 0. |
| `critic-loop.ts` | `runCriticLoopKickoff` — 2-session worker/critic loop with APPROVED/REVISE verdict parsing. |
| `debate-judge.ts` | `runDebateJudgeKickoff` — N generators + 1 judge, WINNER/MERGE/REVISE verdict parsing. |
| `deliberate-execute.ts` | `runDeliberateExecuteKickoff` — composes council rounds + synthesis + blackboard execution. |
| `blackboard/store.ts` | SQLite-backed board state. `insertBoardItem`, `listBoardItems`, `transitionStatus` (CAS-safe). |
| `blackboard/coordinator.ts` | `tickCoordinator` (session picker + claim + work + commit), `waitForSessionIdle`, zombie auto-abort (§1.5.2). |
| `blackboard/planner.ts` | `runPlannerSweep` — posts the planner prompt to session 0, extracts todowrite, seeds board. Prompt is mission-anchored with workspace README auto-embedded (see commit `a5b7c86`). Exports `latestTodosFrom`, `mintItemId`, `buildPlannerBoardContext` for reuse by other orchestrators. |
| `blackboard/auto-ticker.ts` | Timer-based ticker with per-session fanout. Hosts periodic sweep, eager sweep, liveness watchdog (§1.5.2). `AutoTickerOpts.orchestratorSessionID` excludes a session from worker dispatch for hierarchical patterns. |
| `blackboard/bus.ts` | Process-local event bus that `board/store` fires on insert/update/transition. Consumed by the board-events SSE route. |
| `blackboard/critic.ts` | Opt-in anti-busywork critic gate (`enableCriticGate: true` on any pattern). A dedicated critic session reviews board-item completion claims and rejects busywork into `stale` with a `[critic-rejected]` note. Fail-open — a missing verdict passes. Companion layer to the ambition ratchet; see `memory/project_ambition_ratchet.md`. |
| `blackboard/verifier.ts` | Opt-in Playwright verifier gate (`enableVerifierGate: true` + `workspaceDevUrl`). Board items carrying `requiresVerification: true` route through a dedicated verifier session that calls `npx playwright`. Verdicts: `VERIFIED` / `NOT_VERIFIED` / `UNCLEAR`. `NOT_VERIFIED` rolls the claim back to `open` so a worker retries with the failure log. |

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

### 3.4 Add a new swarm pattern

Template for pattern #10 onward. Use the orchestrator-worker /
critic-loop / deliberate-execute files as references.

1. **`lib/swarm-types.ts`** — add the pattern value to `SwarmPattern`.
2. **`lib/swarm-patterns.ts`** — add a `patternMeta` entry with a unique
   `accent` (add to the accent union + the two accent-class records if
   you need a new color).
3. **`lib/swarm-run-types.ts`** — add any pattern-specific request body
   fields to `SwarmRunRequest` and mirror them on `SwarmRunMeta` so
   periodic re-entries can read them from disk.
4. **`lib/server/swarm-registry.ts`** — copy the new request fields into
   the meta at `createRun` time.
5. **`lib/server/<pattern>.ts`** — new module with a `run<Pattern>Kickoff`
   function. Follow the shape of existing kickoffs: `getRun` → validate
   pattern + session count → post role-framed intros (with
   `agent={role}` if hierarchical) → orchestrate via
   `runCouncilRounds` / `runPlannerSweep` / custom waits → fire
   auto-ticker if the pattern has a blackboard-execution phase.
6. **`app/api/swarm/run/route.ts`** — add the pattern to
   `SUPPORTED_PATTERNS`, `PATTERN_TEAM_SIZE`, `isSwarmPattern`, and the
   `patternsWithCustomIntro` set (if the pattern posts its own intros
   instead of the uniform directive broadcast). Add pattern-specific
   validators for any new body fields. Add a `Step N` block that fires
   the kickoff in `.catch(logAndExit)`.
   *If the pattern has a blackboard-execution phase (ticker-driven
   worker dispatch), also add the pattern name to `TICKER_PATTERNS` in
   `app/api/swarm/run/[swarmRunID]/board/retry-stale/route.ts` so the
   auto-restart behavior extends to your pattern — otherwise retry-
   stale will reopen items but leave the ticker dormant.*
7. **`components/new-run-modal.tsx`** — add an `API_RECIPES` entry
   with a working curl example so users see the POST body shape.
8. **`lib/blackboard/live.ts`** — if the pattern pins roles, add a
   `case` to `roleNamesFromMeta` so board chips show role labels.
9. **`app/page.tsx`** — if the pattern uses the board, add it to
   the `boardPatterns` set.
10. **`SWARM_PATTERNS.md`** — add a §N.X section describing the shape,
    status marker, opencode fit.

**Verify:** `npx tsc --noEmit` clean; POST validator accepts the new
pattern value via `scripts/_hierarchical_smoke.mjs` invocation.

### 3.4a Promote an existing pattern's `available` flag

1. **`lib/swarm-patterns.ts`** — flip `available: false` → `true`.
2. **`SWARM_PATTERNS.md`** — move the status marker from `[ ]` to `[~]` or `[x]`.

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
| Blackboard run stuck, sessions have in-flight turns 20+ min old | `lib/server/blackboard/coordinator.ts` zombie-abort (§1.5.2) | Probe `/session/{id}/message` per session; look for `info.time.completed == null` on assistant turns past `ZOMBIE_TURN_THRESHOLD_MS`. Coordinator picker should auto-abort at 10 min — if it's not firing, check HMR-resilient export registration (`liveCoordinator()` resolves to current code). |
| Ticker footer says `stopped · opencode-frozen` | `lib/server/blackboard/auto-ticker.ts` liveness watchdog (§1.5.2) | Tokens haven't advanced for 10+ min. **First check `memory/reference_opencode_freeze.md`** — 90 % of the time the cause is Zen free-tier 429 rate-limiting, not a dead opencode process. `grep 'statusCode":429' /mnt/c/Users/kevin/.opencode-ui-separate/opencode/log/<today>.log` is definitive. If 429s: wait out `retry-after`, then resume. If no 429s: restart opencode (user's launcher) and resume via `POST /api/swarm/run/:id/board/ticker {"action":"start","periodicSweepMinutes":N}`. |
| Run ended with N `stale` items you want to retry | `app/api/swarm/run/[swarmRunID]/board/retry-stale/route.ts` | `POST /api/swarm/run/:id/board/retry-stale` with an empty body. Reopens every stale item in one call, auto-restarts the ticker if the pattern is ticker-driven and ticker is stopped. Returns `{ reopened, reopenedIds, failed, tickerRestarted }`. CAS losses (row flipped between SELECT and UPDATE) land in `failed` — bulk call still succeeds. |
| Need per-session token counts / $ for a run | `app/api/swarm/run/[swarmRunID]/tokens/route.ts` | `GET /api/swarm/run/:id/tokens` returns `{ totals, sessions[] }`. Sessions carry `role` when the pattern pins roles. Cost is 0 for `big-pickle` bundle model by design — see "bundle-pricing banner" in STATUS.md. |
| Ticker footer says `stopped · auto-idle` unexpectedly | `auto-ticker.ts` auto-idle logic | Auto-idle fires only when `periodicSweepMs === 0`. If you expected persistent mode, confirm the run was POSTed with `persistentSweepMinutes > 0`. |
| Planner sweep throws "board already populated" | `lib/server/blackboard/planner.ts` line ~310 | Re-sweep paths must pass `overwrite: true` — see commit `5631557`. If re-sweep silently fails, the attempt is logged as `re-sweep threw: board already populated`. |
| Code edit to `coordinator.ts` / `planner.ts` / `auto-ticker.ts` isn't taking effect | HMR stale-closure (§1.5.2) | Normally HMR-resilient via `liveExports`. If the effect STILL isn't propagating, confirm the module's `publishExports(KEY, …)` call fires on load (add a log; edit should reload module; log should print). Nuclear option: stop + start the ticker via the POST route. |
| Browser tab blanks out with ChunkLoadError | `components/chunk-error-reload.tsx` | Auto-reload should fire within ~1 s. If it doesn't, the overlay is missing or the module failed to load — open devtools, clear `.next` cache, hard reload. |
| Board chips all show "S ses" | `lib/blackboard/live.ts::deriveBoardAgents` | Pre-commit `f3c8112` bug. Verify the new sorted-numeric derivation is in place + `roleNames` arg is wired from the page. |
| Hierarchical pattern POSTs accepted but nothing happens | `app/api/swarm/run/route.ts` Step 7-11 blocks | Check server logs for `[<pattern>] run <id>: kickoff aborted` — likely session count mismatch (critic-loop needs exactly 2; debate-judge needs at least 3). |

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
