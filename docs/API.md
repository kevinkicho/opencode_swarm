# API Reference

Greppable catalog of every HTTP endpoint the app exposes. Method · path
· body · response. For *why* these shapes exist, see `DESIGN.md` §6; for
implementation details see `docs/ARCHITECTURE.md`.

Everything here is **personal-use, unauthenticated**. There is no login
flow, no tenant scoping, no rate limiting. See
`WHAT_THIS_PROJECT_IS_NOT.md` ("Not authenticated / multi-tenant") before
assuming otherwise.

**Base URL:** whatever Next.js prints on startup (`http://localhost:<port>`
— sticky port via `scripts/dev.mjs`).

---

## 1. Opencode proxy

`/api/opencode/[...path]` forwards every method (`GET | POST | PUT |
PATCH | DELETE`) to `OPENCODE_URL`. Auth is attached server-side from
`OPENCODE_BASIC_USER` / `OPENCODE_BASIC_PASS`, so the browser never
holds opencode credentials.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/opencode/[...path]` | Read requests (sessions, messages, diffs, permissions, providers). SSE streams (`/event`) pipe through as `text/event-stream` with backpressure preserved. |
| POST | `/api/opencode/[...path]` | Write requests (session create, prompt, abort, permission reply). Body forwarded as `arrayBuffer`. |
| PUT / PATCH / DELETE | `/api/opencode/[...path]` | Same passthrough semantics. |

**Cost-cap gate.** Before forwarding a `POST /session/{id}/prompt` or
`/session/{id}/prompt_async`, the proxy looks up the swarm run owning
`{id}` via `findRunBySession`. If the run has `bounds.costCap` set and
`costTotal >= costCap`, the proxy returns **402** without calling
opencode:

```json
{
  "error": "cost_cap_exceeded",
  "swarmRunID": "run_...",
  "costTotal": 12.41,
  "costCap": 10.00,
  "message": "run has reached its cost ceiling"
}
```

Direct `?session=` flows (browser session picker) and runs without
`bounds.costCap` are ungated — opting out of swarm management ≡ opting
out of the wall. The 402 surfaces in the UI via `CostCapError` →
`CostCapBanner` with a `raise cap` action. See DESIGN.md §9 "Cost
ceiling enforcement."

**Upstream failures** return **502** with `{ error: "upstream_unreachable",
target, message }`.

---

## 2. Swarm run lifecycle

### `POST /api/swarm/run`

Create a new multi-session run.

**Body (`SwarmRunRequest`)**
```ts
{
  pattern: "blackboard" | "map-reduce" | "council" | "orchestrator-worker"
         | "role-differentiated" | "debate-judge" | "critic-loop"
         | "deliberate-execute";
  workspace: string;               // absolute path to the target repo
  source?: string;                 // repo URL (for display / memory scoping)
  directive?: string;              // optional seed; blank = swarm infers
  title?: string;
  teamSize?: number;               // pattern-dependent defaults (see PATTERN_TEAM_SIZE)
  bounds?: { costCap?, tokenCap?, minutesCap?, zenCeiling?, goCeiling? };
  persistentSweepMinutes?: number; // > 0 disables auto-idle-stop (ticker patterns)
  teamRoles?: string[];            // role-differentiated only
  criticMaxIterations?: number;    // critic-loop only
  debateMaxRounds?: number;        // debate-judge only
  enableCriticGate?: boolean;      // opt-in anti-busywork gate (any pattern)
  enableVerifierGate?: boolean;    // opt-in Playwright verifier (any pattern)
  workspaceDevUrl?: string;        // required when enableVerifierGate=true
}
```

**Response 201**
```ts
{ swarmRunID: string; sessionIDs: string[]; meta: SwarmRunMeta }
```

**Errors:** `400` validation, `501` unsupported pattern, `502` zero
sessions spawned (full opencode failure), `500` registry write failed.

**Behavior:** spawns N sessions via `Promise.allSettled` (partial success
OK — survivors named in `sessionIDs`); posts the directive in parallel;
fires the pattern orchestrator as fire-and-forget so the response
doesn't wait on opencode turns.

---

### `GET /api/swarm/run`

List every persisted run, newest-first.

**Response 200**
```ts
{
  runs: Array<{
    meta: SwarmRunMeta;
    status: 'active' | 'idle' | 'error' | 'stale';
    lastActivityTs: number;
    costTotal: number;
    tokensTotal: number;
  }>
}
```

Cached 2 s in-memory per run; `appendEvent` purges on activity.

---

### `GET /api/swarm/run/{swarmRunID}`

Return one run's `meta.json`. Used after page reload to resolve a URL
to workspace + session list synchronously (vs. waiting on the SSE
handshake frame).

**Response 200:** `SwarmRunMeta`. **404** when run not found.

---

### `GET /api/swarm/run/{swarmRunID}/events`

SSE stream: replay of `events.ndjson` followed by live fan-in of
opencode events filtered to the run's `sessionIDs`.

**Response 200:** `text/event-stream`. Frame types:

| Frame | Shape |
|---|---|
| `swarm.run.attached` | `{ sessionIDs }` — initial handshake |
| `swarm.run.replay.start` | `{}` |
| `SwarmRunEvent` (replay) | `{ type, properties, sessionID?, ts, replay: true }` |
| `swarm.run.replay.end` | `{ count }` |
| `SwarmRunEvent` (live) | same shape, `replay` unset |

`message.part.updated` frames are coalesced at 100 ms per `part.id` to
avoid choking a browser tab on a firehose. See
`lib/server/sse-shaping.ts`.

---

### `GET /api/swarm/run/{swarmRunID}/tokens`

Per-session + aggregate token and cost drill-down. Split from the meta
endpoint so drill-down callers pay the opencode round-trip that list
surfaces don't.

**Response 200**
```ts
{
  swarmRunID: string;
  pattern: SwarmPattern;
  totals: { tokens: number; cost: number; status: string; lastActivityTs: number };
  sessions: Array<{
    sessionID: string;
    role?: string;    // present when the pattern pins roles
    tokens: number; cost: number;
    status: string; lastActivityTs: number;
  }>;
}
```

Role labels resolved via `lib/blackboard/roles.ts::roleNamesBySessionID`.

---

## 3. Blackboard endpoints

Scoped to `pattern='blackboard'` by the UI, but the storage endpoints
don't gatekeep pattern — they'll happily store items for any run.

### `GET /api/swarm/run/{swarmRunID}/board`

List every board item, newest-first.

**Response 200:** `{ items: BoardItem[] }`.

### `POST /api/swarm/run/{swarmRunID}/board`

Create a board item.

**Body**
```ts
{
  id?: string;               // auto-mint as t_<4hex> if omitted
  kind: "todo" | "question" | "claim" | "finding";
  content: string;
  status?: BoardItemStatus;  // defaulted by kind: finding→done, claim→claimed, else→open
  ownerAgentId?: string;     // required for claim
  note?: string;
  fileHashes?: Array<{ path: string; sha: string }>;  // required non-empty for claim
}
```

**Response 201:** `{ item: BoardItem }`. Errors: `400` validation,
`409` id UNIQUE conflict.

### `POST /api/swarm/run/{swarmRunID}/board/{itemId}`

Board-item action. CAS-checked transitions.

**Body**
```ts
{
  action: "claim" | "start" | "commit" | "block" | "unblock";
  ownerAgentId?: string;
  fileHashes?: Array<{ path: string; sha: string }>;
  note?: string;
}
```

**Response 200:** `{ item: BoardItem }`. On `commit` with file drift:
```ts
{ item, drift: Array<{ path; recorded; current: string | null }> }
```
(item marked `stale`, 200 returned — drift is information, not
failure). **409** on CAS loss (status flipped under you) with
`currentStatus`.

### `GET /api/swarm/run/{swarmRunID}/board/events`

SSE stream of board mutations. Replaces the 2 s polling the earliest UI
used.

**Response 200:** `text/event-stream`. Frame types:

| Frame | Shape |
|---|---|
| `board.snapshot` | `{ items: BoardItem[] }` — initial full list on connect |
| `board.item.inserted` | `{ item }` |
| `board.item.updated` | `{ item }` |
| heartbeat | `: heartbeat` every 30 s |

Backed by the process-local bus in `lib/server/blackboard/bus.ts`;
`store` fires on insert/transition.

### `POST /api/swarm/run/{swarmRunID}/board/sweep`

Run the planner sweep — posts the planner prompt to session 0, parses
`todowrite` output, seeds the board with open items. The "plan from
scratch" half of the coordinator loop.

**Body:** `{ overwrite?: boolean; timeoutMs?: number }` (timeout range
5 s – 5 min).

**Response 200:** `{ items: BoardItem[], count: number }`.

**Errors:** `409` if board already populated and `overwrite` is not
set; `504` timeout.

### `POST /api/swarm/run/{swarmRunID}/board/tick`

Run one coordinator tick — pick a session + pick an open item + claim
+ dispatch + wait for idle + commit. Synchronous. External test drivers
(smoke scripts) call this; normal runs use the auto-ticker (below).

**Body:** `{ timeoutMs?: number }` (5 s – 10 min).

**Response 200:** `{ outcome: string }` — e.g. `claimed:t_abc`,
`idle`, `timeout`, `skipped:no-open-items`.

### `POST /api/swarm/run/{swarmRunID}/board/retry-stale`

Bulk reopen — every `stale` item transitions to `open`, clearing
`ownerAgentId` / `fileHashes` / `staleSinceSha` / retry-count note.
Also auto-starts the ticker if it was stopped and the pattern is in
`TICKER_PATTERNS` (blackboard, orchestrator-worker, role-differentiated,
deliberate-execute).

**Body:** `{}`.

**Response 200**
```ts
{
  reopened: number;
  reopenedIds: string[];
  failed: Array<{ id: string; currentStatus: string }>;   // CAS races
  tickerRestarted: boolean;
}
```

Recovery path for rate-limit-stranded runs — see
`memory/reference_opencode_freeze.md`.

### `GET /api/swarm/run/{swarmRunID}/board/ticker`

Inspect the auto-ticker state.

**Response 200**
```ts
{ state: 'none' | 'active' | 'stopped'; ...TickerSnapshot }
```

`TickerSnapshot` shape is in `lib/server/blackboard/auto-ticker.ts` —
the important fields are `consecutiveIdle`, `stopped`, `stopReason`,
`startedAtMs`, `stoppedAtMs`, `currentTier`, `retryAfterEndsAtMs`.

`state: 'none'` means never-started (distinct from `stopped: true`).

### `POST /api/swarm/run/{swarmRunID}/board/ticker`

Start / stop the auto-ticker.

**Body**
```ts
{
  action: 'start' | 'stop';
  periodicSweepMinutes?: number;   // > 0 disables auto-idle-stop
}
```

**Response 200:** same shape as GET. `400` when `pattern != 'blackboard'`
(the other ticker-driven patterns kick their own ticker from their
orchestrator; this endpoint is explicit to blackboard to avoid confusing
double-starts).

Start is idempotent — a second `action: 'start'` resets the idle
counter without reinitializing the timer. `action: 'stop'` sets
`stopReason: 'manual'` which survives for UI display ("last stop:
manual 3 min ago").

---

## 4. Memory & recall

### `POST /api/swarm/memory/rollup`

Run the L1 → L2 reducer. Generates per-session `AgentRollup` and a
`RunRetro` for one run or all runs. Idempotent upsert keyed by
`(swarm_run_id, session_id)`.

**Body:** `{ swarmRunID?: string }` — omit for all-runs mode.

**Response 200 (single-run):**
```ts
{ swarmRunID: string; agentCount: number; retro: RunRetro }
```

**Response 200 (all-runs):** `{ results: Array<...> }`.

See DESIGN.md §7.4 for the `AgentRollup` / `RunRetro` schemas.

### `POST /api/swarm/memory/reindex`

Rebuild the L1 parts index from L0 (`events.ndjson`). Backfill after
install, schema migration, or a corrupted index. Resumes from per-run
`event_seq` cursor — idempotent.

**Body:** `{ swarmRunID?: string }`.

**Response 200:** `{ results: Array<{ swarmRunID, ...reindexResult }> }`.

### `POST /api/swarm/recall`

Query surface for agents (or UI side panels) to hydrate context from
prior runs. Three response shapes.

**Body (`RecallRequest`)**
```ts
{
  // at least one of swarmRunID / sessionID / workspace required
  swarmRunID?: string;
  sessionID?: string;
  workspace?: string;
  shape?: 'summary' | 'parts' | 'diffs';   // default 'summary'
  // shape-specific filters (file glob, agent id, time window, etc.)
  // — see RecallRequest in lib/server/memory/types.ts
}
```

**Response 200:** shape-dependent.
- `summary` → cards per session + `RunRetro` for the run
- `parts` → part snippets matching filters
- `diffs` → patch parts only (file edits)

**Errors:** `400 query_too_broad` when no scope is set (guardrail
against malformed agent plans).

See DESIGN.md §7.5 for the design rationale + shape catalog.

---

## 5. Error conventions

| Status | When |
|---|---|
| 200 | Successful GET or idempotent POST |
| 201 | Create endpoints (run, board item) |
| 400 | Invalid JSON, missing required fields, out-of-range numbers |
| 402 | Cost cap hit (`/api/opencode/*prompt*` proxy only) |
| 404 | Resource not found (swarm run, board item) |
| 409 | CAS loss, UNIQUE conflict, state-machine violation (`currentStatus` included) |
| 500 | Registry write failed, rollup crashed, reindex crashed |
| 501 | Unsupported pattern |
| 502 | Upstream opencode unreachable; zero sessions spawned |
| 504 | Planner sweep timeout |

All error responses are JSON `{ error: string; message?: string; ...context }`.

---

## 6. SSE stream shapes (quick reference)

Two SSE endpoints. Both send `text/event-stream` with blank-line-
delimited frames.

| Endpoint | Frame types |
|---|---|
| `/api/swarm/run/{id}/events` | `swarm.run.attached`, `swarm.run.replay.{start,end}`, `SwarmRunEvent` (replay then live) |
| `/api/swarm/run/{id}/board/events` | `board.snapshot`, `board.item.inserted`, `board.item.updated`, heartbeat (30 s) |

Both handle reconnect at the EventSource layer; the initial frame
(`swarm.run.attached` / `board.snapshot`) is the rebase anchor so the
client doesn't need resync logic. See
`lib/opencode/live.ts::useLiveSwarmRunMessages` and
`lib/blackboard/live.ts::useLiveBoard` for the consumer patterns.

---

## 7. What's intentionally absent

- **No `DELETE /api/swarm/run/{id}`.** Runs are durable training signal
  (§7.7). Dev-stage cleanup is `rm -rf .opencode_swarm/runs/<id>/`.
- **No authentication endpoints.** Personal-use only.
- **No WebSocket endpoints.** SSE is sufficient for the event rate and
  composes with the opencode proxy more cleanly.
- **No public `/api/metrics` yet.** The `/metrics` page groups runs
  client-side from `GET /api/swarm/run`. Graduate to a server-side
  pre-grouped endpoint only when run counts grow past "tens of runs."
  See DESIGN.md §6.4 Phase 4.
