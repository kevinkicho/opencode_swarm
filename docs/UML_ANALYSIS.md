# Design & Architecture Analysis — opencode_swarm

UML-driven analysis with real import graph data (434 imports across 104 server modules).
Each diagram reveals a structural insight that none of the previous analyses
(Ansoff, Scenario, Monte Carlo, LCCA, FTA) could surface.

---

## 1. Class Diagram — Dependency Density

**What it shows**: Which modules are the most coupled — imported by the most
other modules. These are the single points of failure at the code level.

**Real data** (from `scripts/import-graph.ts`, 104 server modules):

| Module | Import count | Imported by |
|--------|-------------|-------------|
| `types` (coordinator/types.ts + blackboard/types.ts + swarm-run-types.ts) | 55 | Across all subsystems |
| `store` (blackboard/store.ts) | 26 | Planner, coordinator, gates, ticker, escalation |
| `opencode-server` | 25 | Planner, coordinator, wait, critic, verifier, auditor, state, dispatch |
| `swarm-registry` (fs.ts) | 21 | Auto-ticker, planner, coordinator, route handlers |
| `swarm-run-types` | 20 | Across all subsystems |
| `node:path` | 15 | File operations in coordinator, planner |
| `coordinator` (dispatch.ts + wait.ts) | 13 | Auto-ticker, map-reduce, council |
| `degraded-completion` | 12 | Planner sweep, kickoff, stop routes |

**Insight 1.1 — `types` is a monolithic import hub.** 55 imports across
3 type files (`coordinator/types.ts`, `blackboard/types.ts`,
`swarm-run-types.ts`). Every module touches these. A change to any type
definition cascades through the entire import graph. The FTA already
identified the planner as a structural bottleneck; the class diagram reveals
that the TYPE SYSTEM is an equal bottleneck — much higher fan-in than any
runtime module.

**Actionable**: Split `swarm-run-types.ts` into domain-specific files:
`run-config.ts`, `run-status.ts`, `run-events.ts`. Each subsystem imports
only the types it needs. Reduces blast radius of type changes.

**Insight 1.2 — `store` has the widest functional fan-in.** At 26 imports,
the board store touches every module that reads or writes board state:
planner (insert), coordinator (claim/dispatch), gates (drift check), ticker
(idle check), cold-file-seed, auditor, critic, verifier, escalation.

This is expected for a centralized data store, but it means `store.ts` is
effectively 26 modules' worth of implicit contracts. If the store's schema
changes, 26 modules need re-verification.

**Actionable**: Add a `BoardStore` interface in a shared types file. All
26 consumers import and depend on the interface, not the SQLite
implementation. Schema changes are gated by the interface.

**Insight 1.3 — `opencode-server` has high fan-in but low churn.** At 25
imports, the adapter is the second most-coupled module. But its interface
is stable (5 functions, same signatures since v1.0). High fan-in + low
churn = acceptable. High fan-in + high churn = architectural risk.

**Insight 1.4 — No circular dependencies detected.** The import graph
analysis scanned all 104 server modules. Zero circular imports found. This
is exceptional for a prototype of this size and suggests disciplined
layering. The architecture's "import down, never up" rule is being followed.

---

## 2. State Machine Diagram — Board Item Lifecycle

**What it shows**: Every possible state transition for a board item, including
invalid or untested ones.

```
                    ┌──────────┐
           ┌───────→│   open   │←─────────┐
           │        └────┬─────┘          │
           │   [retry]   │ [CAS: open→    │ [retryOrStale:
           │             │  claimed]      │  in-progress→open]
           │        ┌────▼─────┐          │
           │        │  claimed  │─────────┘
           │        └────┬─────┘
           │             │ [CAS: claimed→
           │             │  in-progress]
           │        ┌────▼──────────┐
           │        │  in-progress  │
           │        └───┬────┬──────┘
           │   [CAS drift]│    │ [commitDone]
           │   [phantom]  │    │
           │   [critic]   │    │
           │   [build]    │    │
           ▼        ┌────▼────▼──┐
       ┌────────┐   │    done    │
       │ stale  │   └────────────┘
       └────────┘
```

**Defined transitions** (by code path):

| From | To | Guard | Path |
|------|----|-------|------|
| open | claimed | CAS (transitionStatus) | `pick-claim.ts:312` |
| claimed | in-progress | CAS (transitionStatus) | `pick-claim.ts:326` |
| in-progress | done | Gate checks + CAS | `commit-done.ts:18` |
| in-progress | stale | Gate rejection (drift/phantom/critic/build) | `run-gate-checks.ts` |
| in-progress | open (retry) | `retryOrStale` with retry budget | `retry.ts:75` |
| open | stale | `finalizeRetryExhaustedItems` (zombie cleanup) | `retry.ts:109` |

**Insight 2.1 — The `claimed` state has no timeout transition.** If a
session crashes between `open→claimed` and `claimed→in-progress`, the item
is stuck in `claimed` forever. The zombie check in `pick-claim.ts` re-reads
session messages but only transitions `claimed→in-progress` — it never
transitions `claimed→stale` or `claimed→open`. This is a one-way state.

**Frequency**: Rare — the two CAS operations happen within microseconds
in the same function. But if the process crashes between them, the item is
permanently claimed.

**Actionable**: Add a `finalizeClaimedZombies` function to the safety-net
loop in `tick.ts`, alongside `finalizeRetryExhaustedItems`. Transitions any
`claimed` item older than 10 minutes to `stale`.

**Insight 2.2 — `done→stale` and `stale→open` are not valid but are not
prevented.** There is no runtime guard that prevents a debug endpoint or
manual intervention from moving a `done` item to `stale` or a `stale` item
to `open`. The state machine has runtime assertions (state-assert.ts, shipped)
but those only verify EXPECTED states, not PREVENT invalid transitions.

**Actionable**: Add a `validateStateTransition` guard in `transitionStatus`
itself. Reject transitions that aren't in the defined set. Return `{ ok: false,
reason: 'invalid_transition' }` for any transition not in the allowed map.

**Insight 2.3 — The state machine has 6 states but only 2 CAS-guarded
transitions.** The critical path (open→claimed→in-progress) is CAS-guarded.
But `in-progress→done` (the most important transition — it records the
work as complete) is NOT CAS-guarded in the same way. `commitDone` calls
`transitionStatus` but doesn't check the `ok` result — it proceeds regardless.

**Actionable**: Make `commitDone` fail-visible on CAS failure. Currently it
returns `{ status: 'stale' }` but the caller in `tickCoordinatorImpl`
doesn't handle the stale case specially — it treats it the same as `picked`.

---

## 3. Sequence Diagram — Tick Cycle

**What it shows**: The temporal order of operations in a single tick, including
synchronous blocking points where the system waits for external I/O.

```
fanout()                    tickSession()           opencode
   │                             │                     │
   │──ensureSlots()──┐           │                     │
   │                 │           │                     │
   │←────────────────┘           │                     │
   │                             │                     │
   │──for each session───┐       │                     │
   │                     │       │                     │
   │   void tickSession()│       │                     │
   │                     ▼       │                     │
   │              ┌──────────────┤                     │
   │              │ MUTEX ACQUIRE (per-session)        │
   │              │              │                     │
   │              │──pickClaim()─┤                     │
   │              │              │──getSessionMessages─→│  BLOCKS: HTTP round-trip
   │              │              │←─────messages───────│  200-500ms
   │              │              │                     │
   │              │──resetSession│                     │
   │              │              │──abortSession───────→│  BLOCKS: HTTP round-trip
   │              │              │←─────ack────────────│  200-500ms
   │              │              │──createSession──────→│  BLOCKS: HTTP round-trip
   │              │              │←─────new session────│  200-500ms
   │              │              │                     │
   │              │──dispatch───┤                     │
   │              │              │──postSessionMessage─→│  FIRE-AND-FORGET
   │              │              │                     │  ~100ms
   │              │              │                     │
   │              │──awaitTurn──┤                     │
   │              │              │──getSessionMessages─→│  POLLS every 1s
   │              │              │←─────messages───────│  
   │              │              │   (repeat until idle) │ 30-120s for LLM turn
   │              │              │                     │
   │              │──runGateChecks──┐                   │
   │              │──commitDone─────┘                   │
   │              │                                     │
   │              │            MUTEX RELEASE            │
   │              └─────────────────────────────────────┤
   │                                                     │
   │  (other sessions tick in parallel)                  │
```

**Insight 3.1 — `pickClaim` blocks on 3 sequential HTTP calls.** Before
the worker can claim a todo, the coordinator:
1. Calls `getSessionMessagesServer` for every candidate session (HTTP)
2. Calls `abortSessionServer` (HTTP, in `resetSessionForClaim`)
3. Calls `createSessionServer` (HTTP, in `resetSessionForClaim`)

That's 3 HTTP round-trips, each 200-500ms, before the work prompt is even
posted. For a 4-worker run, that's up to 6 seconds of idle time per tick
cycle spent on session management.

**Actionable**: Batch the `getSessionMessagesServer` calls for all candidate
sessions into one `Promise.all`. Currently they're sequential in the
`for (const sessionID of sessionCandidates)` loop. Parallelizing would
cut pre-claim overhead by ~60%.

**Insight 3.2 — The mutex is held across the entire LLM turn.** From
`slot.inFlight = true` in `tickSession` until `slot.inFlight = false` in
`finally`, the per-session mutex is held for 30-120 seconds (the LLM turn
duration). During this time, no other claim can dispatch to this session.
This is intentional — it prevents double-dispatch. But it means the session
is idle for the entire interval between `awaitTurn` completion and the next
tick cycle's mutex acquisition.

**Actionable**: None — this is correct behavior. The session is busy from
claim to commit. The idle gap between turns is the tick interval (10s),
not the mutex hold time.

**Insight 3.3 — The "parallel" fanout is actually staggered by tick interval.**
`fanout()` calls `void tickSession()` for each session in a `for` loop
without awaiting. But each tickSession hits the per-session mutex, which
is uncontended (different sessions). So they truly run in parallel. However,
the stagger from the `for` loop means session 3 starts ~microseconds after
session 0. This is negligible compared to the 10s tick interval.

---

## 4. Component Diagram — System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (Next.js client)                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Timeline │  │ Board UI │  │ Topbar   │  │ Composer  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬─────┘  │
│       │              │             │               │         │
│       │ useLiveSwarmRunMessages    │               │         │
│       │ useBoardItems              │               │         │
│       └──────────┬─────────────────┴───────────────┘         │
│                  │ ┌──────────────────────────────┐          │
│                  └─┤ /api/opencode proxy (SSE)    │          │
│                    └──────────────┬───────────────┘          │
└──────────────────────────────────┼──────────────────────────┘
                                   │ HTTP
┌──────────────────────────────────┼──────────────────────────┐
│  Next.js Server                  │                           │
│                                  │                           │
│  ┌─── Route Handlers ───────────┼─────────────────────┐    │
│  │ POST /api/swarm/run           │                     │    │
│  │ POST /api/swarm/run/:id/stop  │                     │    │
│  │ POST /api/webhook/run         │                     │    │
│  │ GET /api/_debug/parse-failures│                     │    │
│  └──────────────┬────────────────┼─────────────────────┘    │
│                 │                │                           │
│  ┌─── Swarm Engine ─────────────┼─────────────────────┐    │
│  │  swarmEngine()               │                     │    │
│  │   .startRun()                │                     │    │
│  │   .stopRun()                 │                     │    │
│  │   .subscribe()               │                     │    │
│  │   .getRunMeta()              │                     │    │
│  └──────────────┬───────────────┼─────────────────────┘    │
│                 │                │                           │
│  ┌─── Coordination Runtime ─────┼─────────────────────┐    │
│  │  Auto-ticker ──► Coordinator ──► Board Store       │    │
│  │  Planner Sweep ──► Gates (critic/verifier/auditor) │    │
│  │  FileLockSet · BoardView · PatternGuard            │    │
│  └──────────────┬───────────────┼─────────────────────┘    │
│                 │                │                           │
│  ┌─── Opencode Adapter ─────────┼─────────────────────┐    │
│  │  createSessionServer          │                     │    │
│  │  postSessionMessageServer     │                     │    │
│  │  getSessionMessagesServer     │                     │    │
│  │  abortSessionServer           │                     │    │
│  │  getSessionDiffServer         │                     │    │
│  └──────────────┬───────────────┼─────────────────────┘    │
│                 │                │                           │
└─────────────────┼────────────────┼──────────────────────────┘
                  │                │
                  ▼                ▼
           ┌──────────────────────────┐
           │  opencode HTTP API       │
           │  (opencode daemon)       │
           └──────────────────────────┘
```

**Insight 4.1 — The Swarm Engine (C1, just shipped) sits at the right
architectural boundary.** It's between route handlers and the coordination
runtime. Route handlers delegate to the engine. The engine delegates to
the runtime. This is the classic MVC controller pattern — the engine is
the controller, the runtime is the model, and the UI is the view.

**Insight 4.2 — The opencode adapter is a proper anti-corruption layer.**
All 30 server modules that need opencode go through the 5 functions in
`opencode-server.ts`. No module calls `opencodeFetch` directly except the
adapter itself and a handful of route-specific endpoints (SSE multiplexer,
provider catalog). This was confirmed in the adapter isolation analysis.

**Insight 4.3 — The browser proxy (`/api/opcode/[...path]`) is an
architectural duplicate.** The browser goes through the proxy; the server
goes through `opencode-server.ts`. Both ultimately call `opencodeFetch`.
Any change to opencode's API requires updating both paths. A consolidated
client (used by both proxy and server) would eliminate this duplication.

---

## 5. Consolidated Recommendations (from all 4 UML diagrams)

| # | Insight | Source | Action | Effort |
|---|---------|--------|--------|--------|
| 5.1 | `types` is a 55-import hub — blast radius of any type change | Class Diagram 1.1 | Split `swarm-run-types.ts` into domain-specific files | 0.5d |
| 5.2 | `store.ts` has 26 consumers with no abstraction | Class Diagram 1.2 | Add `BoardStore` interface; consumers depend on interface | 0.5d |
| 5.3 | `claimed` state has no timeout transition | State Machine 2.1 | `finalizeClaimedZombies` alongside `finalizeRetryExhaustedItems` | 0.2d |
| 5.4 | Invalid state transitions not prevented | State Machine 2.2 | `validateStateTransition` guard in `transitionStatus` | 0.3d |
| 5.5 | `pickClaim` blocks on 3 sequential HTTP calls | Sequence 3.1 | Parallelize `getSessionMessagesServer` for candidates | 0.2d |
| 5.6 | Proxy + adapter duplicate opencode API surface | Component 4.3 | Consolidate into single `opencodeClient` used by both | 0.5d |

---

## 6. What UML Reveals That Other Analyses Miss

| Analysis | Sees | Misses |
|----------|------|--------|
| FTA | Causal failure chains (events) | Structural coupling (code layout) |
| Monte Carlo | Probabilistic behavior (outcomes) | Temporal behavior (sequence of operations) |
| LCCA | Economic value (dollars) | Architectural value (maintainability) |
| UML Class | **Dependency density** — which modules break when you change one type | Economic impact of those dependencies |
| UML State | **Transition completeness** — which state changes are possible but untested | Probability of each transition occurring |
| UML Sequence | **Blocking points** — where the system waits for I/O | Cost of the blocking time |

**The composite finding**: No single UML diagram is sufficient. The class
diagram found coupling hotspots. The state machine found missing transitions.
The sequence diagram found blocking points. The component diagram found
architectural duplication. Together, they reveal that the codebase is
well-layered (no circular dependencies) but has concentrated coupling
(4 modules with 20+ fan-in) and undocumented state machine edges (2
transitions are missing from the runtime).
