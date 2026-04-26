# HARDENING_PLAN

Living document for structural fragility findings + prioritized fixes.
2026-04-26 — initial deep audit. User-flagged: "app feels brittle and
unpredictable, lots of errors and warnings". This plan is the response.

The 25+ Q-items shipped on 2026-04-26 (Q20–Q47 in IMPLEMENTATION_PLAN
Phase 7) closed mostly *symptoms*. This plan targets the *contracts*
that allow those symptoms to keep recurring.

## Findings (deep audit 2026-04-26)

### File-size distribution (≥400 lines, top tier first)

| File | Lines | Concern |
|---|---|---|
| `lib/opencode/live.ts` | 1452 | 6+ live-data hooks in one file; HMR can't isolate them |
| `lib/server/blackboard/planner.ts` | 1234 | sweep + tier ladder + prompts + parsers all here |
| `app/page.tsx` | 1206 | already 5 decomp passes; ~398 lines of inline JSX remain |
| `lib/opencode/transform.ts` | 1189 | 6 transformers in one file |
| `app/api/swarm/run/route.ts` | 1076 | POST validation + 9-pattern spawn + GET handler |
| `components/new-run-modal.tsx` | 909 | 552 lines deeply-nested JSX (Q43/Q44 hidden here) |
| `lib/server/swarm-registry.ts` | 867 | **35 importers, 0 tests** — keystone untested |
| `components/inspector/sub-components.tsx` | 798 | recently extracted |
| `lib/server/map-reduce.ts` | 785 | per-pattern logic |
| `components/swarm-timeline.tsx` | 779 | the main visualization |
| `lib/server/blackboard/coordinator/dispatch.ts` | 753 | hot path, 0 tests |
| `components/retro-view.tsx` | 731 | section panels |
| `lib/server/debate-judge.ts` | 659 | per-pattern |
| `lib/server/deliberate-execute.ts` | 657 | per-pattern |
| `components/spawn-agent-modal.tsx` | 626 | similar to new-run-modal |
| `components/board-rail.tsx` | 623 | 129 lines deeply-nested JSX |

### Test coverage gap (no-test critical paths)

35 importers; 0 tests:
- `swarm-registry.ts` — keystone of run state
- `opencode-server.ts` (22 importers) — keystone of opencode bridge
- `auto-ticker.ts` lifecycle
- Per-pattern kickoffs: `orchestrator-worker`, `role-differentiated`, `auditor`, `finalize-run`, `degraded-completion`, `demo-log-retention`

254 unit tests cover the corners. The structural keystones are bare.

### Latent Q22-shape bug class

`extractLatestAssistantText` exists in 6 files (byte-identical):
- `council.ts`, `critic-loop.ts`, `debate-judge.ts`, `deliberate-execute.ts`, `map-reduce.ts`, `harvest-drafts.ts`

8 call sites pass unfiltered messages. Q22 fix patched ONE (debate-judge:486 with `newMsgs = msgs.filter(!known.has)`). The other 7:
- `debate-judge.ts:587` (judge-side)
- `critic-loop.ts:394, 452`
- `deliberate-execute.ts:387, 571`
- `map-reduce.ts:641, 699`
- `harvest-drafts.ts:86` (used by council + map-reduce — propagates)

Each can return pre-prompt prime-ack text when the actual draft turn fails silently.

### API redundancy

6 client-side pollers concurrent per page (TanStack-deduped, but 6 cold compiles):

| Hook | Endpoint | Cadence |
|---|---|---|
| useOpencodeHealth | /api/opencode/health | 5s |
| useLiveSession | /api/opencode/session/<sid>/message | per-session SSE+poll |
| useLiveSessions | /api/opencode/session | 3s |
| useSwarmRuns | /api/swarm/run | 4s |
| useSwarmRunSnapshot | /api/swarm/run/<id>/snapshot | per-run fallback |
| useLiveTicker | /api/swarm/run/<id>/board/ticker | 5s per active run |

### Empty catches (24 across 10 files)

Most are FS-exists checks (file-not-found returning null) — those are fine.
Some are real silent-error suppression — must be audited individually.

Files with empty catches: critic-loop (3), debate-judge (3), deliberate-execute (5), map-reduce (5), harvest-drafts (2), demo-log-retention (1), degraded-completion (1), finalize-run (1), opencode-restart (1), orchestrator-worker (2).

### Points of failure (high blast radius)

- `swarm-registry`: 35 importers
- `opencode-server`: 22 importers
- `store`: 9
- `coordinator`: 8

Fragility floor — break these and N files cascade.

### Memory + stack safety
- setInterval cleanup looks correct (auto-ticker, log-tail, live.ts properly clear timers)
- No recursion → stack-overflow risk minimal
- globalThis-keyed registries are HMR-safe pattern, not a leak

### TS escape hatches: minimal
6 `as unknown as` total, all intentional (HMR globalThis casts).

### Deep audit additions (2026-04-26 follow-up)

**Natural seam in swarm-registry** — exports cleanly split into:
- FILESYSTEM-ONLY (no opencode dep): `findRunBySession`, `createRun`, `getRun`, `updateRunMeta`, `listRuns`, `appendEvent`, `readEvents`
- OPENCODE-DEPENDENT (pulls opencode-server graph): `deriveRunRow`, `deriveRunTokens`, `deriveRunRowCached`

Splitting along this seam = Q47 fix + breaks 35-importer monolith into testable pieces.

**`tickCoordinator` is one 753-line function with 14+ exit paths**:
- 8 `skipped` outcomes (no work / claim race / no idle session / etc.)
- 6 `stale` outcomes (wait failed / cas-drift / phantom-no-tools / critic reject / verifier reject / final-emit failed)
- 1 `picked` (the happy path)

Should split: `pickClaim` / `dispatchPrompt` / `awaitTurn` / `gateBeforeDone` / `commitDone`.

**Hydration waterfall on `?swarmRun=<id>` open**:
7 HTTP hooks + 1 SSE fire concurrently:
1. useOpencodeHealth (5s cadence)
2. useSwarmRunSnapshot (cold compile = 1310 modules pre-Q47)
3. useSwarmRuns (4s cadence)
4. useLiveSession (primary)
5. useLiveSwarmRunMessages (all sessions; **double-fetches the primary** with #4 on cold load — only deduped after both complete)
6. useLivePermissions
7. useSessionDiff
8. useLiveBoard (SSE)
9. useLiveTicker (5s)

useLiveSwarmRunMessages mirrors INTO TanStack cache (per its comment), but does NOT consult useLiveSession's pending fetch — so cold load sees a doubled primary-session fetch.

**Cross-pattern duplication beyond extractLatestAssistantText**:
- `buildSynthesisPrompt` × 2 (map-reduce + deliberate-execute)
- `buildRevisionPrompt` × 2 (critic-loop + deliberate-execute likely)
- Plus the 5 confirmed `extractLatestAssistantText` clones (debate-judge has the +Q22 filter at the call site)

**Dead-code surface**: of 147 exported functions in `lib/server/`, 109 have ≤1 importer (including self). Even at 50% false positive rate (tests, route imports my grep missed), still ~50 functions of dead/low-utility exports. Bundle bloat.

**JSX element count (proxy for DOM render complexity)**:
- `app/page.tsx`: 66 JSX elements
- `swarm-timeline.tsx`: 110 elements
- `new-run-modal.tsx`: 157 elements (highest — explains the deep-nesting + Q43/Q44/Q25 paper-cut breeding ground)

---

## Prioritized fix plan

Tiers ranked by `value × structural impact / effort`.

### Tier 1 — high value, bounded scope (highest leverage)

#### A. Consolidate `extractLatestAssistantText` + force `knownIDs` filter (1-2 hr)
- Single file `lib/server/extract-text.ts`
- Variant 1: `extractLatestAssistantText(messages)` — legacy shape
- Variant 2: `extractNewAssistantText(messages, knownIDs)` — REQUIRED filter
- Migrate 5 patterns to variant 2 where the call site has `knownIDs` available
- For sites without `knownIDs` (deliberate-execute, map-reduce some), build the set before fetching
- **Closes 5 latent Q22-shape bugs across patterns**

#### B. Tests for `swarm-registry` (2-3 hr)
- Status derivation: cap-stop → idle (Q27), opencode-frozen → error (Q35), live ticker → live (Q28), normal idle session → idle
- List ordering: createdAt desc; survivor remap on partial spawn failures
- Meta cache TTL behavior
- **Safety net before further refactors of the 35-importer keystone**

#### C. Audit + label the 24 empty catches (1-2 hr)
- `console.warn` the silent ones in critical paths
- Document the intentional ones (file-exists checks) inline
- **Makes future failures visible instead of invisible**

#### D. Slim `swarm-registry` transitive chain for snapshot (Q47) (2-3 hr)
- Lazy-load opencode-server inside `deriveRunRow` via dynamic import (same as Q46 ticker pattern)
- Or: split swarm-registry into read-only (`listRuns`, `getRun`) and live-state (`deriveRunRow*`, `deriveRunTokens`) files
- **Cuts snapshot cold-compile from 1310 modules → ~300, the 5-30s page-load pain**

### Tier 2 — structural payoff, bigger scope

#### E. Split `lib/opencode/live.ts` (1452 → 6 files) (4-6 hr)
- Per-hook files: `use-opencode-health.ts`, `use-live-session.ts`, `use-live-sessions.ts`, `use-live-swarm-run-messages.ts`, `use-swarm-runs.ts`, `use-swarm-run-snapshot.ts`
- Shared types/helpers in `live-shared.ts`
- HMR can isolate edits to one hook from the others; bundle analysis becomes possible
- **Biggest single-file refactor; unlocks per-hook iteration**

#### F. Split `lib/opencode/transform.ts` (1189 → ~6 files) (3-4 hr)
- One file per transformer: `to-agents.ts`, `to-messages.ts`, `to-live-turns.ts`, `to-file-heat.ts`, `to-run-plan.ts`, `to-turn-cards.ts`
- Shared utilities in `transform-shared.ts`

#### G. Continue Q26 — `app/page.tsx` 1206 → ≤700 (4-6 hr)
- Extract pattern-rail switch into a dispatcher component
- Extract main-view JSX block into a `PageView` component
- Extract the entire JSX `return` body into smaller view components

#### H. Split `lib/server/blackboard/planner.ts` (1234 → ~4 files) (3-5 hr)
- `planner-prompt.ts` — buildPlannerPrompt + tier ladder
- `planner-parse.ts` — todowrite extraction
- `planner-sweep.ts` — runPlannerSweep
- `planner-types.ts` — interfaces

### Tier 3 — architectural

#### I. Pattern consolidation: designate blackboard canonical (1 hr decision + Nx hr each pattern)
- Mark blackboard as production-ready in DESIGN.md
- Mark other 8 as experimental
- Optionally deprecate unused patterns
- **Cuts 9-pattern bug surface; most 2026-04-26 bugs were pattern-specific**

#### J. Integration test harness against recorded opencode (6-8 hr)
- Record real opencode HTTP traffic during a known-good run
- Replay against test runs
- **Catches Q33/Q37/Q22/Q42-shape integration realities before they ship**

### Tier 4 — UI tech debt

#### K. Decompose `new-run-modal.tsx` (909 lines, 552 deeply-nested) (4-6 hr)
#### L. Decompose `swarm-timeline.tsx` (779) (3-5 hr)
#### M. Decompose remaining ≥600-line components (6-10 hr cumulative)

---

### New tier-1 items surfaced by the deep audit

#### N. Split `swarm-registry.ts` along the natural seam (2-3 hr) — supersedes D
- `swarm-registry-fs.ts` — fs-only ops (findRunBySession, createRun, getRun, updateRunMeta, listRuns, appendEvent, readEvents)
- `swarm-registry-derive.ts` — opencode-dependent (deriveRunRow*, deriveRunTokens)
- The fs-only file becomes an order-of-magnitude lighter import for routes that only need run metadata
- **Cuts the snapshot-route 1310-module compile to ~200, ALSO breaks the 35-importer monolith into pieces that can be tested**

#### O. Coalesce primary-session fetch (1 hr)
- useLiveSession + useLiveSwarmRunMessages currently double-fetch the primary session on cold load
- Fix: useLiveSwarmRunMessages should `queryClient.ensureQueryData(sessionMessagesQueryKey(...))` instead of imperative fetch — one network call shared
- **Cuts 1 redundant HTTP call per page open**

#### P. Dead-code sweep in lib/server (2-4 hr)
- 109 of 147 exported functions have ≤1 importer
- Audit each, delete the unused, document the intentional-but-unused (e.g. exposed for future use, exposed for tests)
- **Reduces bundle + reduces "what does this function do?" cognitive load**

#### Q. Decompose tickCoordinator (753 lines, 14 exits) (3-5 hr)
- Split into helper functions: `pickClaim`, `dispatchPrompt`, `awaitTurn`, `runGateChecks`, `commitDone`
- Each helper testable independently (currently ZERO tests for the entire 753-line function)
- **Lowers the activation energy for adding tests to the hottest server function**

## Suggested order (revised)

1. **A + C in one push** (2-4 hr) — closes 5 latent Q22 bugs + makes silent failures visible
2. **N** (supersedes D) (2-3 hr) — splits swarm-registry along the natural seam, fixes Q47, sets up for B
3. **B** (2-3 hr) — tests for the now-split swarm-registry-derive module (smaller, more focused)
4. **O** (1 hr) — coalesce primary-session fetch
5. **Q** (3-5 hr) — decompose tickCoordinator + start adding dispatch tests
6. **E + F together** (~7-10 hr) — splits the two biggest data-layer files
7. **P** (2-4 hr) — dead-code sweep
8. **G + K + L** — UI decomp when you want UX hygiene work
9. **I** — strategic decision; deletes ~3000 lines if you commit to one pattern
10. **J** — biggest defensive payoff once core stabilizes
