# HARDENING_PLAN — structural bible

Living document. The 28+ Q-items shipped on 2026-04-26 (Q20–Q47) closed mostly *symptoms*. This plan targets the *contracts* that allow those symptoms to keep recurring, organized around four properties we want the codebase to have:

- **Resilience** — when something goes wrong (schema drift, transient failure, malformed input), the system fails loud, recovers cleanly, and never silently produces a corrupt state.
- **Durability** — data we wrote yesterday is still readable today; tests prove what shipped still works tomorrow; locks survive HMR.
- **Efficiency** — CPU, network, bundle bytes, and cold-compile modules each pay for themselves.
- **Capability** — the seams in the code make future features additive, not surgical.

## How this document is organized

Every entry has the same shape:

> **Failure mode** — what concretely goes wrong  
> **Evidence** — file:line citations, agent-corroborated  
> **Fix** — prescriptive action, no abstractions  
> **Effort** — wall-clock estimate  
> **Verification** — how to know it shipped

Read top-to-bottom: items are ordered by leverage (impact ÷ effort) within each part. Section IV (Capability) is longer because that's where the post-stabilization work clusters — once Resilience and Durability ship, Capability is the runway for the next two months.

---

## Scorecard (state at 2026-04-26)

What's already strong (don't waste effort here):

| Property | Evidence |
|---|---|
| Type discipline | 0 `@ts-ignore` · 0 `@ts-expect-error` · 1 real `: any` · ~25 `as unknown` (most narrowed) |
| Empty catches | 3 truly empty (all trivial stream-cleanup); audit found ONE real bug-magnet |
| Server/client boundary | Zero `lib/server/*` runtime imports from client components; `'use client'` consistently placed |
| SDK naming | `swarm-types.ts` declares opencode names verbatim; zero invented synonyms |
| SQLite concurrency | Both DBs WAL+NORMAL, globalThis-singleton, atomic CAS in `transitionStatus` |
| Direct import cycles | Only 2, both trivial |
| Promise hygiene | `Promise.allSettled` used for finalize/abort cascades; AbortController used correctly |

What's fragile (the work this plan covers):

| Property | Evidence |
|---|---|
| HTTP boundary fail-open | Pattern kickoffs return 201 even when orchestrator throws (see R1) |
| SDK schema-drift firewall | 0 opencode-JSON fixture files; transform.ts trusts shapes (see R2) |
| Test coverage on keystones | 0 tests on swarm-registry (867 LOC, 33 callers), dispatch (753 LOC), live.ts (1452 LOC), auto-ticker (~1500 LOC), memory pipeline (~1500 LOC) |
| meta.json atomicity | Non-atomic writes; SIGKILL → 0-byte file → `getRun` parse-throws |
| Lock-map HMR | `criticLocks`, `auditLocks` not globalThis-keyed → reset on every reload |
| Bundle pressure | snapshot route still 1310 modules (Q47 open); board/ticker route hot path untreated |
| Orphan endpoints | 8 routes with zero browser callers (~750 LOC dead) |
| Duplicate fetches | 4 pages do raw `fetch('/api/swarm/run')` bypassing TanStack dedup |

Numbers driving the rollout:

- 49,430 LOC across 207 .ts/.tsx files
- 21 test files / 253 cases / 0 fixtures
- 17 distinct env vars across 13 files; 0 typed config module
- 5 unbounded in-memory caches, all `globalThis`-pinned
- 49 `setInterval`/`setTimeout` sites; 3 of them are auto-ticker timers HMR-handled via a bespoke pattern

---

## Part I — RESILIENCE

### R1. HTTP-boundary fail-open: the 201-zombie bug

**Failure mode.** A user POSTs `/api/swarm/run`. The route synchronously creates the run row, then fires the per-pattern orchestrator with `.catch((err) => console.warn(...))` and returns `201 { swarmRunID, ... }`. If the orchestrator throws on its first await — bad model name, opencode unreachable, planner-prompt build error — the user gets a "run created" response and the run sits in the registry as `live` forever. This is exactly the failure shape MAXTEAM-2026-04-26 hit; the run-guard postmortem patched the body but not the route response.

**Evidence.**
- `app/api/swarm/run/route.ts:878,896,911,928,945,961,977` — seven sites where pattern-specific kickoffs are `.catch((err) => console.warn(...))` and the route still returns 201
- `app/api/swarm/run/route.ts:758,778,800` — three more: critic/verifier/auditor session spawn fails fall through to `gateSession=undefined`. The 201 body has no `gateFailures` field. A run with `enableAuditorGate=true` and `auditorSessionID=undefined` looks healthy in the response.
- Postmortem `docs/POSTMORTEMS/2026-04-26-critic-loop-runaway-token.md` — F1 fix is body-side (`waitForSessionIdle` aborts on deadline). Route-side response is unchanged.

**Fix.**
1. Wrap each pattern kickoff in `Promise.race([kickoff(), delay(150ms)])`. If the kickoff settles synchronously (rejected) inside 150ms, return `5xx` with `{ error: 'kickoff-failed', detail: err.message }` and mark the run as `failed`. If it's still pending, return 201 — the orchestrator owns its own outcome from there.
2. For the three gate-spawn failures, accumulate a `gateFailures: { critic?: string; verifier?: string; auditor?: string }` object and include it in the 201 body. The client (`new-run-modal.tsx`) already shows an error toast on non-200; just give it the diagnostic.

**Effort.** 2-3 hr.

**Verification.** Add a test fixture that throws synchronously inside `runOrchestratorWorkerKickoff`; assert the route returns 5xx and the registry shows `status: error` (not `live`). This is also the most impactful new test in the gap-analysis (closes the F3 promise from 2026-04-25).

---

### R2. SDK schema-drift firewall

**Failure mode.** opencode emits a `tool` part. Our client-side SSE handler in `lib/opencode/live.ts` parses it as `JSON.parse(ev.data) as MessagePartUpdated`. There is no runtime check that `tool` exists on the part, that `state` has the expected shape, or that `type` is one of the known values. When opencode adds a new part type or renames a field — exactly the Q34/Q42 failure shape — `transform.ts` silently produces `tool: 'unknown'` and the UI treats it as a normal tool call.

**Evidence.**
- `lib/opencode/live.ts:1054, 401, 631, 1124, 1222` — 5 SSE event parses, each casting `JSON.parse` directly to a typed shape with no validator
- `lib/blackboard/live.ts:120` — `JSON.parse(ev.data) as BoardFrame`; the `switch (frame.type)` that follows has **no default** branch — new event type is dropped silently
- `lib/opencode/transform.ts` — every part-narrowing uses TS-only filters like `(p): p is Extract<OpencodePart, { type: 'tool' }> => p.type === 'tool'`. Type system trusts that `tool` exists once `type === 'tool'`. Q42 is exactly the case where this assumption broke (model emitted `type: 'text'` content that *looked* like a tool call to the UI).
- Zero opencode JSON fixture files anywhere in the repo (test-coverage agent finding)

**Fix.**
1. Add `lib/opencode/validate-part.ts`: a 30-line runtime validator with a `KNOWN_PART_TYPES` set, required-field checks per type. Returns `{ ok: true; part: OpencodePart } | { ok: false; reason: string; raw: unknown }`. Drop and `console.warn(...)` on `ok: false` so an unknown part shows up in dev logs immediately.
2. Capture 4-6 real opencode message JSON payloads from current sessions into `lib/opencode/__fixtures__/` (one per pattern shape: planner, worker, critic, council). Add tests in `transform.test.ts` that drive the full pipeline through these fixtures. **This is the firewall against the Q34 class.**
3. Make `lib/blackboard/live.ts:120`'s switch exhaustive — add `default: console.warn('unknown board frame', frame)`.

**Effort.** 4-5 hr (1 hr validator + 2 hr fixture capture + 1-2 hr exhaustiveness).

**Verification.** Bash a fake fixture into `transform.test.ts` with a deliberately drifted shape (extra field, missing field, unknown type) — assert validator catches each.

---

### R3. The single bug-magnet empty catch

**Failure mode.** The auto-ticker's orphan cleanup at startup calls `deriveRunRow(meta)` to decide whether each registry entry corresponds to an alive run. The catch silently treats any failure (transient opencode hiccup, parse failure on a session probe) as "this run is orphaned, kill the ticker." A live run gets shut down with no log line, no event, nothing.

**Evidence.**
- `lib/server/blackboard/auto-ticker/state.ts:82` — `try { ... } catch {}` with no body, no log

**Fix.** Replace with `catch (err) { console.warn('[orphan-cleanup] deriveRunRow threw for', meta.swarmRunID, '— treating as orphan; reason:', err); }`. Better: don't treat it as orphan unless we can affirmatively prove the run is dead (e.g., process not present in run registry, or meta.json missing). Until then, a forensic trail beats nothing.

**Effort.** 15 min.

**Verification.** Trigger by stopping opencode mid-run-startup; check dev log for the warn line.

---

### R4. Typed error vocabulary

**Failure mode.** When opencode is unreachable, `lib/opencode/live.ts` and `lib/opencode/client.ts` throw `new Error(\`opencode ${path} -> HTTP ${res.status}\`)`. Downstream consumers in `lib/server/blackboard/coordinator/wait.ts` and `lib/server/critic-loop.ts:526-530` decide whether to retry-vs-abort by **substring matching** the error message: `err.message.includes('timed out')`. A human renaming the error string for clarity would silently break retry logic.

**Evidence.**
- 1 typed Error subclass in entire codebase (`CostCapError` at `lib/opencode/live.ts:181`)
- 42 `throw new Error(string)` sites with 39 distinct unstructured messages
- 8 `throw new Error(\`opencode ... -> HTTP ${status}\`)` patterns repeating in `live.ts` + `client.ts`
- Substring matches as de-facto error codes: `wait.ts`, `critic-loop.ts:526-530`

**Fix.** Add `lib/opencode/errors.ts` with `OpencodeUnreachableError`, `OpencodeHttpError`, `OpencodeTimeoutError` (all extending Error, all with `kind` discriminator + structured payload). Replace the 8 throw sites and the 2 substring-match sites with `instanceof` checks.

**Effort.** 1-2 hr.

**Verification.** `grep "includes('timed out')"` returns zero in `lib/server/`.

---

### R5. API error-response shape standardization

**Failure mode.** Across 20 route handlers, error responses come in 4 different shapes: `{ error }`, `{ error, message }`, `{ error, detail }`, `{ error, hint }`. Plus `{ error, currentStatus }` (board CAS) and `{ error: 'cost-cap...', swarmRunID, costTotal, costCap }` (cost cap). Clients that want the diagnostic substring have to know which key holds it per route. `new-run-modal.tsx:175` reads `detail.error`; `chips.tsx:123` reads the same; both miss `message` and `hint`.

**Evidence.**
- 87 `Response.json(...)` calls across 20 route files
- 4 shape variants for "more than just error string"
- Client-side: `components/new-run-modal.tsx:173-175`, `components/swarm-topbar/chips.tsx:121-123`

**Fix.** Define `lib/api-types.ts::ApiErr = { error: string; detail?: string; hint?: string }` (drop `message` — fold into `detail`). Migrate all 87 `Response.json(...)` error sites to this shape. Update the 5 client read sites to consume `detail` and `hint` consistently.

**Effort.** 2-3 hr (mostly mechanical).

**Verification.** `grep -nE "Response\.json\(\{\s*error:" app/api | wc -l` matches `grep -nE "ApiErr" lib/api-types.ts`.

---

### R6. Untyped HTTP request bodies

**Failure mode.** Four route handlers accept POST bodies via `(await req.json()) as TheBody`. Field access happens immediately after with no `typeof` checks. A malformed body (missing field, wrong type) doesn't return 400 — it propagates `undefined` into business logic and crashes mid-handler with a generic 500.

**Evidence.**
- `app/api/swarm/recall/route.ts:27` — `body.swarmRunID/sessionID/workspace` used directly after a one-line "at least one set" check
- `app/api/swarm/run/[swarmRunID]/board/[itemId]/route.ts:81` — `ActionBody` cast; per-action partial validation only
- `app/api/swarm/memory/reindex/route.ts:31` — `JSON.parse(raw) as { swarmRunID?: string }`, no typeof
- `app/api/swarm/memory/rollup/route.ts` — same pattern

**Fix.** Adopt the existing `parseRequest` / `parsePost` style (already used in `app/api/swarm/run/route.ts` and `app/api/swarm/run/[swarmRunID]/board/route.ts` — ~280 lines of typeof guards). No Zod dependency needed — the codebase has its own validation idiom. Extend it to the 4 untyped routes.

**Effort.** 1-2 hr.

**Verification.** Each migrated handler has a `parseFooBody(raw): { ok: true; body } | { ok: false; error }` helper that's called before any field access.

---

### R7. JSON.parse trust on disk

**Failure mode.** `swarm-registry.ts` reads `meta.json` and `events.jsonl` from disk and casts the parsed JSON directly to typed shapes. If either file is corrupt (truncated by SIGKILL, partially-written, hand-edited), the cast succeeds at compile time and propagates `undefined`-shaped data into the rest of the system. `getRun` returns an object whose required fields are silently `undefined`.

**Evidence.**
- `lib/server/swarm-registry.ts:249` — `JSON.parse(raw) as SwarmRunMeta`
- `lib/server/swarm-registry.ts:857` — `JSON.parse(line) as SwarmRunEvent`
- `lib/server/memory/reader.ts:45`, `lib/server/memory/query.ts:197` — `JSON.parse(payload) as AgentRollup | RunRetro` cast on a discriminated union with **no discriminator check**

**Fix.** Add `validateSwarmRunMeta(raw): SwarmRunMeta | null` and `validateSwarmRunEvent(raw): SwarmRunEvent | null` in `lib/server/swarm-registry-validate.ts`. Required-field check + tag check on union types. Return null on validation failure, log once. Same pattern for memory union deserialization (one `typeof obj.kind === 'string'` discriminator check).

**Effort.** 1-2 hr.

**Verification.** Hand-corrupt a `meta.json` (delete required field); confirm `getRun` returns null instead of an object with undefined fields.

---

## Part II — DURABILITY

### D1. meta.json atomic-rename writes

**Failure mode.** `swarm-registry.ts:195` (`createRun`) and `:280` (`updateRunMeta`) both call `await fs.writeFile(metaPath(...), JSON.stringify(...))`. `writeFile` is **not crash-atomic** — `O_TRUNC` happens before any byte is written. A SIGKILL between truncate and the write call leaves a 0-byte `meta.json`. Next `getRun` parse-throws. Worse: two concurrent `updateRunMeta` calls both read-then-write without CAS — the second silently overwrites the first's update.

**Evidence.**
- `lib/server/swarm-registry.ts:195` — initial `meta.json` write
- `lib/server/swarm-registry.ts:280` — `updateRunMeta` rewrite
- No mutex around the read-modify-write block

**Fix.**
1. Replace both writes with `writeFile(tmp) → rename(tmp, final)` (atomic on POSIX).
2. Wrap the `read → merge → write` block in `updateRunMeta` with a per-`swarmRunID` async mutex (one `Map<string, Promise<void>>` keyed by run ID).

**Effort.** 1-2 hr.

**Verification.** A unit test that pkill -9's mid-write must leave either the old meta.json or the new one — never a 0-byte file.

---

### D2. HMR-vulnerable lock maps

**Failure mode.** `criticLocks`, `verifierLocks`, and `auditLocks` are plain `const Map<string, Promise<unknown>>()` declarations. Next.js HMR replaces the module on file change; the new module's lock map starts empty. An in-flight critic run's lock vanishes mid-flight. Two concurrent reviews of the same run can now race against opencode's "one prompt per session at a time" rule.

**Evidence.**
- `lib/server/blackboard/critic.ts:75` — `const criticLocks = new Map<string, Promise<unknown>>();`
- `lib/server/blackboard/verifier.ts:61` — same shape
- `lib/server/blackboard/auditor.ts:89` — same shape
- All other module-level state in `lib/server/` is `globalThis`-keyed via `Symbol.for(...)` (see `bus.ts:29`, `swarm-registry.ts:74,234,750`)

**Fix.** One-line change per file matching the `bus.ts` pattern: `const g = globalThis as AnyGlobal; const KEY = Symbol.for('opencode_swarm.criticLocks'); if (!g[KEY]) g[KEY] = new Map(); const criticLocks = g[KEY];`

**Effort.** 30 min.

**Verification.** Touch any of the 3 files mid-run; the lock survives the HMR reload.

---

### D3. Unbounded TTL caches (5)

**Failure mode.** Five in-memory caches grow without bound. Each is `globalThis`-pinned for HMR survival, which means in long-lived dev they accumulate forever. `sessionIndex` in particular maps every session ID across every run to its swarmRunID — including deleted runs.

**Evidence.**

| Cache | TTL | Bound | Site |
|---|---|---|---|
| `metaCache` | 2s | unbounded Map | `swarm-registry.ts:223-261` |
| `listCache` | 15s | single slot | `swarm-registry.ts:321-364` (already bounded) |
| `derivedRowCache` | 10s | unbounded Map | `swarm-registry.ts:742-768` |
| `treeCache` | 30s | unbounded Map | `app/api/swarm/run/[swarmRunID]/tree/route.ts:39-64` |
| `sessionIndex` | ∞ | unbounded Map | `swarm-registry.ts:74` |
| `models cache` | 5min | single slot | `lib/server/opencode-models.ts:33-78` (already bounded) |

**Fix.** Cap each unbounded Map at 500 entries with simple LRU eviction. Existing TODO comment at `swarm-registry.ts:718-720` already flags this. Pattern: a small `LRU<K,V>(max=500)` helper in `lib/server/lru.ts` so we don't reinvent eviction four times.

**Effort.** 1-2 hr.

**Verification.** A test that fills `metaCache` to 600 entries asserts size ≤ 500 and oldest entries evicted.

---

### D4. Test coverage gap on keystone modules

**Failure mode.** The five most-imported, most-critical files have **zero** tests. A silent regression in `swarm-registry.ts` cascades through 33 callers; a silent regression in `dispatch.ts` is exactly the Q34 silent-drop class. There is no automated regression detection on the keystones.

**Evidence (test-coverage agent).**

| Module | LOC | Callers | Test coverage |
|---|---|---|---|
| `lib/server/swarm-registry.ts` | 867 | 33 | ZERO |
| `lib/server/blackboard/coordinator/dispatch.ts` | 753 | 1 (central) | ZERO |
| `lib/opencode/live.ts` | 1452 | 16 | ZERO |
| `lib/opencode/transform.ts` | 1189 | 14 | 17 cases (parsers only; 80% untested) |
| `lib/server/blackboard/planner.ts` | 1234 | n/a | 44 cases (prefix parsers only; 80% untested) |
| `lib/server/blackboard/auto-ticker/*` | ~1500 | n/a | ZERO |
| `lib/server/memory/*` | ~1500 | n/a | ZERO |
| `app/api/swarm/run/route.ts` | 1076 | n/a | ZERO |
| 73 components + page.tsx | ~22,000 | n/a | ZERO |

253 unit tests exist; they cover the corners (verdict classifiers, prefix parsers, pricing math) — not the keystones.

**Fix.** Five tests, in order, for ROI:

1. **`swarm-registry-lifecycle.test.ts`** — temp-dir SQLite fixture, exercise `createRun → getRun → appendEvent → updateRunMeta → listRuns → deriveRunRow`. Catches the next 33-caller cascade. (2-3 hr)
2. **`dispatch.test.ts → tickCoordinator`** — mock `postSessionMessageServer` + `listBoardItems`, drive the picker through claim → dispatch → idle. Catches Q34/silent-drop class before live runs. (3-4 hr)
3. **`transform-shape.test.ts`** with real opencode JSON fixtures (R2 firewall) — Q34/Q42 firewall. (2-3 hr; pairs with R2)
4. **The 6 promised pattern integration tests** from 2026-04-25 F3 (orchestrator-worker, role-differentiated, critic-loop, debate-judge, council, map-reduce, deliberate-execute). The ledger says SHIPPED; only `blackboard.test.ts` exists. Each is ~50 LOC with mocks. (4-6 hr cumulative)
5. **`planner-sweep.test.ts`** — drive `runPlannerSweep` with mocked planner replies; assert board seeding correctness. (2 hr)

**Effort.** 13-18 hr cumulative. Sequence them: #1 enables #2 (both need swarm-registry mocks); #3 pairs with R2.

**Verification.** Coverage diff: keystone files go from 0% to >70% line coverage.

---

### D5. Postmortem ledger discipline gap

**Failure mode.** 2026-04-25 postmortem F3 was marked "SHIPPED + VERIFIED" but only one of the 7 promised pattern integration tests exists. The ledger lies. Future regressions will be re-discovered live instead of caught by the suite the ledger claims is in place.

**Evidence.**
- `docs/POSTMORTEMS/2026-04-25-agent-name-silent-drop.md` — F3 declares per-pattern integration tests
- `tests/integration/` — only `blackboard.test.ts` exists
- 7 patterns marked *(todo)* in `tests/README.md`

**Fix.**
1. Add a "validated by run/test" column requirement to `docs/POSTMORTEMS/README.md`'s template — fix is not "VERIFIED" until the line/run ID is filled in.
2. Write the 6 missing tests (folded into D4 above).
3. Audit existing postmortems for similar overclaiming: grep for "VERIFIED" and check each backing artifact.

**Effort.** 30 min for template; tests are in D4.

---

### D6. server-only enforcement

**Failure mode.** None of 64 server modules under `lib/server/` import `'server-only'`. If a client component accidentally imports any server module — even type-only — Next.js bundler will dutifully ship the server code (better-sqlite3, fs, child_process) into the client bundle and the browser crashes at module evaluation.

**Evidence.**
- `grep -rl "import 'server-only'" lib/server | wc -l` → 0
- `find lib/server -name '*.ts' ! -name '*.test.*' | wc -l` → 64
- The architecture-seam audit confirmed zero current violations — but there's no protection for the next refactor.

**Fix.** Add `import 'server-only';` as the first line of every file under `lib/server/`. ~64 one-line edits, all mechanical. The `server-only` package is a Next.js convention; no install needed (it's part of `next`).

**Effort.** 30 min.

**Verification.** A test or a script that imports any `lib/server/` file from a `'use client'` test fails to build.

---

### D8. Auto-ticker concurrency tightenings

**Failure mode.** Two soft races inside the auto-ticker:
1. `tick.ts:193` — `resweepInFlight` is read-then-set without atomicity. Two simultaneous `tickSession` calls hitting the auto-stop threshold both observe `false`, both set `true`, both fire `attemptTierEscalation`. Planner has its own throttle so the duplicate sweep doesn't cascade into duplicate todos, but it wastes one full opencode prompt round-trip.
2. `tick.ts:75-101` — `ensureSlots` "double-check after the await" pattern. Two concurrent `fanout` calls on a fresh state both pass the first guard, both await `getRun`, both pass the second check, both write `state.sessionIDs = [...meta.sessionIDs]`. Idempotent (same content), so race is benign — but flagged here so future edits don't introduce a non-idempotent write under the same shape.

**Evidence.** `lib/server/blackboard/auto-ticker/tick.ts:193` and `lib/server/blackboard/auto-ticker/tick.ts:75-101`.

**Fix.**
1. `attemptTierEscalation` itself early-returns when `state.resweepInFlight === true`. Set the flag inside the function body, not at the call site. Single critical section.
2. Document `ensureSlots`'s idempotent-race property with an inline comment so future edits don't mutate it into a non-idempotent write.

**Effort.** 30 min.

**Verification.** Add a unit test in `auto-ticker/__tests__/tick.test.ts` that drives two concurrent `tickSession` calls past the auto-stop threshold and asserts `attemptTierEscalation` runs exactly once.

---

### D9. Per-swarmRunID dispatch mutex

**Failure mode.** `tickCoordinator` claims a todo, prompts a session, waits for idle, commits the result. The auto-ticker fans out via `restrictToSessionID` with a per-session `inFlight` flag. But a user POST to `/board/tick` (with no restriction) can race the auto-ticker on the same swarmRunID — both pick the same idle session, both call `getSessionMessagesServer` for the picker, both pick the same todo, the second loses CAS at `transitionStatus`. Lossy-but-correct today (the SQL layer enforces single-claim) but expensive — one full opencode read trip wasted per race.

**Evidence.** `lib/server/blackboard/coordinator/dispatch.ts` has no per-`swarmRunID` mutex. Per-session `inFlight` flag in `auto-ticker/state.ts` only protects against same-session re-entry, not cross-caller races.

**Fix.** Add a `dispatchMutexByRun: Map<string, Promise<void>>` in `dispatch.ts` (globalThis-keyed). Every entry into `tickCoordinator` awaits-then-replaces the entry. Callers without `restrictToSessionID` serialize per run. The `inFlight` flag stays for same-session protection within the mutex.

This is independent of C4 (decomposing tickCoordinator) — even pre-decomp, the mutex wraps the whole function at the entry point.

**Effort.** 1 hr.

**Verification.** A unit test that fires two concurrent `tickCoordinator(runID, {})` calls and asserts only one reaches `getSessionMessagesServer` per cycle.

---

### D7. opencode JSON fixture firewall

**Failure mode.** Q34 and Q42 were caused by opencode emitting message shapes our transform code didn't expect. We have no fixture corpus to test against. Every shape change is discovered live, costs tokens, and produces a postmortem.

**Evidence.** Zero `__fixtures__/` directories. Zero captured opencode JSON in `lib/opencode/__tests__/`.

**Fix.** Pairs with R2 — capture 4-6 real message JSONs into `lib/opencode/__fixtures__/`. Tests:
- `transform-shape.test.ts` drives `toAgents`, `toMessages`, `toRunMeta`, `toTurnCards`, `toFileHeat`, `toLiveTurns`, `toRunPlan` through each fixture. Snapshot the output. PRs that change transform shape have to update the snapshot — visible review signal.

**Effort.** Folded into R2 (2-3 hr total).

---

## Part III — EFFICIENCY

### E1. Snapshot route 2N opencode probe redundancy

**Failure mode.** `GET /api/swarm/run/[id]/snapshot` calls `Promise.all([deriveRunRowCached, deriveRunTokens])`. Both fan out into `deriveSessionRow(sid)` → `getSessionMessagesServer(sid)` for the same sessionIDs. For an 8-session council snapshot, 16 opencode HTTP probes hit instead of 8. No in-flight deduplication.

**Evidence.**
- `app/api/swarm/run/[swarmRunID]/snapshot/route.ts:56`
- `lib/server/opencode-server.ts:103` (`getSessionMessagesServer`) — no cache layer

**Fix.** Add a 500ms in-flight + TTL cache on `getSessionMessagesServer(sid)`. Single in-flight `Promise<Messages>` per session ID; concurrent callers share. TTL 500ms is well under the 4s polling cadence so no staleness.

**Effort.** 1 hr.

**Verification.** Add a counter; cold snapshot of an 8-session run shows 8 cache misses, 8 cache hits. Network panel shows 8 opencode HTTP probes instead of 16.

---

### E2. Fragmented `/api/swarm/run` fetches (4 raw fetches bypass dedup)

**Failure mode.** Four pages fetch the same endpoint as four independent network calls instead of sharing TanStack Query's dedup. Cold-load of any of these pages costs an extra round trip.

**Evidence.**
- `app/projects/page.tsx:24` — direct `fetch('/api/swarm/run')`
- `app/projects/[slug]/page.tsx:40` — same
- `app/metrics/page.tsx:24` — same
- `app/board-preview/page.tsx:107` — same
- `useSwarmRuns` (live.ts:1357) is the canonical hook; uses TanStack key, deduplicates at 30s cadence

**Fix.** Replace each raw fetch with `useSwarmRuns({ intervalMs: 30000 })`. They auto-share the cache key.

**Effort.** 30 min.

**Verification.** Network panel: navigating Projects → Metrics → board-preview shows one `/api/swarm/run` request, not four.

---

### E3. `useBackendStale` 3-poller waste

**Failure mode.** `useBackendStale` admits in its own comment ("if we ever need to share one instance, wrap in Context") that it spawns N independent 5s pollers. Currently 3 callers (page.tsx, swarm-topbar, swarm-timeline) × 5s = 36 unnecessary HTTP requests per minute.

**Evidence.** `lib/opencode/live.ts:329-343`

**Fix.** Wrap in `BackendHealthProvider` context. Single 5s poll, all consumers subscribe. ~30 lines, zero risk.

**Effort.** 30 min.

**Verification.** Network panel: `/api/opencode/health` fires once per 5s regardless of how many components mount.

---

### E4. Polling-vs-SSE redundancy

**Failure mode.** Two endpoints are polled at 5s while a perfectly good SSE channel (`/board/events`) already streams board mutations. Drop the polls; fold the data onto the SSE.

**Evidence.**
- `useLiveTicker` polls `/board/ticker` at 5s — ticker state is naturally a board frame
- `useStrategy` polls `/strategy` at 5s — plan-revisions could be a board frame too

**Fix.** Add `'ticker.tick'` and `'strategy.update'` frame types to the existing `/board/events` SSE channel; remove the two poll hooks. Server-side: emit on the bus from `tick.ts` and `plan-revisions.ts`.

**Effort.** 2-3 hr.

**Verification.** Network panel: per-run page shows 1 SSE connection, no `/board/ticker` or `/strategy` polls.

---

### E5. dispatch.ts sequential `sha7` await loops

**Failure mode.** `lib/server/blackboard/coordinator/dispatch.ts` has 3 separate `for await` loops over `expectedFiles` / `editedPaths`, each calling `sha7(absPath)` (which does fresh `fs.readFile`). On WSL2 9P, every read is a cross-FS roundtrip. For a todo with 3 expected files, dispatch latency is 9× the round-trip cost instead of 3×.

**Evidence.**
- `dispatch.ts:354-365` (claim) — sequential `for…of await`
- `dispatch.ts:511-525` (drift) — sequential
- `dispatch.ts:574-583` (commit) — sequential
- Only the drift-deltas log uses `Promise.all` (line 527)

**Fix.** Wrap each loop in `Promise.all(files.map(f => sha7(f)))`. Three localized changes, no semantic difference.

**Effort.** 30 min.

**Verification.** Time a dispatch with 5 expected files; before-fix vs after-fix should drop ~4× on WSL2.

---

### E6. board/ticker route Q46-style import-graph fix

**Failure mode.** `GET /api/swarm/run/[id]/board/ticker` is polled at 5s. It only needs `getTickerSnapshot` — a state-only read. But it imports `startAutoTicker` and `stopAutoTicker` from the `@/lib/server/blackboard/auto-ticker` index module, which transitively pulls `tick.ts → coordinator → planner` (~1100 modules) into GET cold compile. Same shape as the Q46 fix on `/board/tick` and Q47 (still open) on `/snapshot`.

**Evidence.** `app/api/swarm/run/[swarmRunID]/board/ticker/route.ts` imports from index module; only POST handler needs start/stop.

**Fix.** Mirror the Q46 split: GET imports `getTickerSnapshot` directly from `auto-ticker/state`. POST dynamic-imports `startAutoTicker`/`stopAutoTicker`. Module count drops from ~1100 to ~200 on the hot path.

**Effort.** 30 min.

**Verification.** Run the modules-counting probe used in Q46. Confirm ticker route ≤ 200 modules.

---

### E7. board/route + retry-stale similar pattern

**Failure mode.** Other route handlers may pull POST-only imports into GET cold compile, same pattern as E6. Quick audit:
- `board/route.ts` — GET imports `insertBoardItem` (POST-only) at module level → bus emit chain in GET compile
- (Other routes need a sweep)

**Fix.** Audit each multi-method route; ensure GET handlers don't transitively pull POST-only deps.

**Effort.** 1-2 hr (audit + fixes).

---

### E9. POST raw-fetch sites → `useMutation`

**Failure mode.** Four client-side POST sites bypass TanStack Query's `useMutation`:
- `components/strategy-rail.tsx:65` (replan trigger)
- `components/swarm-topbar/chips.tsx:116` (stop button)
- `components/retro-view.tsx:710` (rollup trigger)
- `components/new-run-modal.tsx:167` (run create)

Each implements its own loading / error / disabled state. Inconsistent retry semantics; some lose race conditions to fast double-clicks; error messages render differently per site.

**Evidence.** Component-state audit. The hooks (`useSwarmRuns`, `useLiveSession`, etc.) consistently use `useQuery`; mutations have drifted.

**Fix.** Migrate each to `useMutation({ mutationFn, onError, onSuccess })` so disabled-during-pending, error-toast, and success-invalidation are uniform across the four sites. Co-locate any cache invalidation (e.g., `queryClient.invalidateQueries(SWARM_RUNS_QUERY_KEY)`) inside the mutation's `onSuccess`.

**Effort.** 2-3 hr.

**Verification.** Manual: trigger each button rapidly; double-click is correctly debounced; error toasts share styling.

---

### E8. `app/page.tsx` 8 separate full-pass transforms

**Failure mode.** `app/page.tsx:368-403` has 8 separate `useMemo` blocks, each running a full-pass transform over the same `messages` array: `toAgents`, `toMessages`, `toRunMeta`, `toProviderSummary`, `toRunPlan`, `toLiveTurns`, `toTurnCards`, `toFileHeat`. Each transform is O(N×M); 8× pass cost.

**Evidence.** Performance audit citation; component-state audit confirmed 33 hooks in page.tsx.

**Fix.** Consolidate into `useSwarmView(messages, meta)` hook returning a single `{ agents, messages, runMeta, ... }` object computed in one pass. Folds into capability item C6 (page.tsx hook extraction) — same edit.

**Effort.** Folded into C6.

**Verification.** Profiler shows one O(N×M) pass per data change instead of 8.

---

## Part IV — CAPABILITY

### C1. Pattern-runtime: lift one helper, do NOT introduce `runPattern()`

**Premise.** The 5 pattern files (3,057 lines) might look like prime targets for a polymorphic `runPattern()` interface. **They are not.** Architecture-seam audit found:

> Each pattern is a state machine over `withRunGuard + waitForSessionIdle + harvestDrafts + recordPartialOutcome` — 80% scaffolded already, 20% pattern-specific shape. The surviving duplication (`extractLatestAssistantText`, verdict regex tropes) is forced consolidation territory only: prompts, verdict vocabularies, and loop shapes are genuinely different.

**Fix.** Lift `extractLatestAssistantText` to `lib/server/harvest-drafts.ts` (already imported by all 5). Delete the 5 character-identical duplicates. **Stop there.** Do not introduce a polymorphic interface — the "delete a pattern with one `git rm`" property is load-bearing and would be lost.

**Why this matters as a capability item.** Future-you may be tempted to build a generic pattern abstraction. Don't. This is a constraint on future refactors, encoded in the plan.

**Effort.** 1 hr.

**Verification.** `grep -rn "function extractLatestAssistantText" lib/server | wc -l` returns 1.

---

### C2. Split `app/api/swarm/run/route.ts` (1076 → ~250 LOC)

**Failure mode.** The biggest non-page file in the repo. Three-quarters of it is one POST handler containing: parse → continuation → defaults → spawn → intro → 9-branch pattern dispatch → response build. Adding a new pattern means editing this file. Adding a new validation field means scrolling through ~280 lines of typeof guards.

**Evidence.** API-topology agent identified the natural seam:

| Lines | Phase | Target file |
|---|---|---|
| 56-157 | Pattern table + `parseRequest` validation | `lib/server/run/validate.ts` |
| 160-451 | `parseRequest` body | (large; either stays here or splits internally) |
| 463-490 | `resolveContinuation` | `lib/server/run/continuation.ts` |
| 519-605 | Pattern defaults / model resolution | `lib/server/run/defaults.ts` |
| 619-660 | Session minting | `lib/server/run/spawn-sessions.ts` |
| 691-810 | Intro/directive prompts | `lib/server/run/dispatch-intro.ts` |
| **859-1001** | **9 if-blocks for pattern kickoff** | `lib/server/run/kickoff/{pattern}.ts` + dispatcher table |
| 1003-1009 | Build response | route stays |
| 1025-1076 | GET (list) | could split to `app/api/swarm/run/list/route.ts` or stay |

**Fix.** Extract in this order:
1. The 9 if-blocks → `Record<SwarmPattern, KickoffFn>` table. Drops ~140 LOC. Adding a new pattern = one new file + one new table entry.
2. Validate / defaults / spawn / intro → 4 separate files. Drops ~700 LOC.
3. Route file should be ≤ 250 LOC after.

**Effort.** 3-4 hr.

**Verification.** `wc -l app/api/swarm/run/route.ts` ≤ 250. New pattern can be added by writing one file.

---

### C3. Split `lib/server/swarm-registry.ts` (867 → fs-only / opencode-dep)

**Failure mode.** 33 callers import this file. Half need only fs-side ops (`getRun`, `listRuns`, `appendEvent`); the other half pull `deriveRunRow*` which transitively imports `opencode-server.ts → live.ts`. Today every importer pays the full transitive cost. Q47 is exactly this.

**Evidence.** Earlier deep-audit finding (the natural seam was identified before this rewrite — call-graph confirmed 30 callers of `getRun`).

**Fix.**
- `lib/server/swarm-registry-fs.ts`: `findRunBySession`, `createRun`, `getRun`, `updateRunMeta`, `listRuns`, `appendEvent`, `readEvents`
- `lib/server/swarm-registry-derive.ts`: `deriveRunRow`, `deriveRunTokens`, `deriveRunRowCached`
- `lib/server/swarm-registry.ts`: barrel re-export for migration; deprecate after callers update

Cuts snapshot-route compile from ~1310 modules toward ~200; closes Q47.

**Effort.** 2-3 hr.

**Verification.** Module count probe on `/snapshot` route ≤ 250.

---

### C4. Decompose `tickCoordinator` (753 lines, 14 exits)

**Failure mode.** One function with 14 exit paths. 8 `skipped` outcomes, 6 `stale` outcomes, 1 happy path. Untestable as a unit. The Q34 silent-drop class lives here.

**Evidence.** `lib/server/blackboard/coordinator/dispatch.ts`. Test coverage: 0.

**Fix.** Split into helper functions:
- `pickClaim(ctx)` — returns `{ todo, sessionID } | null`
- `dispatchPrompt(ctx, todo, sessionID)` — sends the prompt
- `awaitTurn(ctx, sessionID, deadline)` — wraps `waitForSessionIdle`
- `runGateChecks(ctx, todo, messages)` — phantom-no-tools, drift, critic, verifier
- `commitDone(ctx, todo, sessionID, sha7s)` — atomic transition

Each helper is 50-150 LOC, testable in isolation. The orchestrator becomes readable end-to-end.

**Effort.** 4-5 hr.

**Verification.** Each helper has its own test file. Aggregate coverage on dispatch.ts > 70%.

---

### C5. `lib/api-types.ts` + `lib/config.ts` centralization

**Failure mode.**
- 6 inline interfaces in route handlers (`TickBody`, `SweepBody`, `PostBody`, `ActionBody`, `StopResponse`, `GateBlock`) — clients re-key request bodies by hand
- 17 `process.env.X` reads across 13 files; no typed config module; `?? '...'` defaults inline at every read site

**Evidence.** Architecture-seam audit. `process.env` distinct names: `OPENCODE_URL`, `OPENCODE_BASIC_USER`, `OPENCODE_BASIC_PASS`, `OPENCODE_LOG_DIR`, `OPENCODE_RESTART_CMD`, `OPENCODE_SWARM_ROOT`, `OPENCODE_HEAT_HALF_LIFE_S`, `OLLAMA_URL`, `DEMO_LOG_AUTO_DELETE`, `DEMO_LOG_RETENTION_DAYS`, `USER`, `WSL_USER`.

**Fix.**
- `lib/api-types.ts`: lift the 6 inline interfaces. Route handlers and the 4 client `fetch` callsites import from one place.
- `lib/config.ts`: typed config module exporting all 12+ env vars with documented defaults. Single grep target for "what's configurable."

**Effort.** 2-3 hr cumulative.

**Verification.** `grep -nE "process\.env\." lib app | wc -l` drops from ~30 to <5 (only `lib/config.ts` should access `process.env`).

---

### C6. `app/page.tsx` hook extraction (`useSwarmView` + `useDiffStats`)

**Failure mode.** Page.tsx is 1206 LOC, 33 hook calls (15 useMemo + 15 custom). Two big inline derivation blocks remain after 5 prior decomp passes:
- 55-line `view: SwarmView` memo at lines 354-407 (multi-session vs single-session branching)
- 40-line `liveDiffs` + `diffStatsByPath` block at lines 687-723

**Evidence.** Component-state agent.

**Fix.** Extract:
- `app/page-internals/use-swarm-view.ts` — accepts session/meta/live data, returns `SwarmView`
- `app/page-internals/use-diff-stats.ts` — accepts session ID, returns `{ liveDiffs, diffStatsByPath }`
- Folds in E8 (8 transform passes consolidated to 1 inside `useSwarmView`)

Page should drop from 1206 → ~1050 lines, hooks 33 → ~22.

**Effort.** 3-4 hr.

**Verification.** `wc -l app/page.tsx` ≤ 1050; useMemo count ≤ 6.

---

### C7. swarm-timeline.tsx — TimelineInteractionContext

**Failure mode.** `onFocus`, `onSelectAgent`, `roleNames` drilled 5 levels deep: `PageBody → SwarmTimeline → TimelineFlow → EventCard/ChipCard → TimelineNodeCard`. Each level passes the prop through, doing nothing with it.

**Evidence.** Component-state agent traced the chain.

**Fix.** Add `TimelineInteractionContext` provider in `swarm-timeline.tsx`. Consumer hook in `EventCard` and `TimelineNodeCard`. Eliminates ~12 prop pass-throughs; subtree memoization becomes feasible.

**Effort.** 1-2 hr.

**Verification.** TimelineFlow's prop list drops from N to N-3.

---

### C8. new-run-modal.tsx + spawn-agent-modal.tsx — section split + `useNewRunForm`

**Failure mode.**
- `new-run-modal.tsx`: 909 LOC, 23 hooks (16 useState!), 157 JSX elements. Q43/Q44/Q25 paper-cut breeding ground.
- `spawn-agent-modal.tsx`: 626 LOC, similar shape.

**Evidence.** Component-state + size-lens agents.

**Fix.**
- Extract `useNewRunForm` hook: consolidate the 16 useState into a reducer with typed actions
- Extract form sections into sub-components: `<SourceSection>`, `<PatternSection>`, `<RoutingSection>`, `<AdvancedSection>`, etc.
- `routing-modal.tsx` (439 LOC, "draft leak" bug shape from `wasOpenRef` + 6 paired useState bounds re-sync): replace with `<Modal key={open}>` remount or `useDraftBounds(bounds, open)` reducer

**Effort.** 4-5 hr cumulative.

**Verification.** `wc -l components/new-run-modal.tsx` ≤ 500. useState count ≤ 5. Visual regression: file new run flow still works end-to-end.

---

### C9. 8 orphan endpoints — delete or namespace

**Failure mode.** 8 API routes have **zero browser callers**. ~750 LOC of dead route code. They appear in dev grep results, look load-bearing, and confuse future refactors.

**Evidence.** API-topology agent.

| Path | Status |
|---|---|
| `POST /api/swarm/run/[id]/board` (create) | orphan; coordinator uses internal `insertBoardItem` |
| `GET /api/swarm/run/[id]/board` (list) | orphan; replaced by `/board/events` SSE + `/snapshot.board.items` |
| `POST /api/swarm/run/[id]/board/[itemId]` | orphan; coordinator imports `transitionStatus` directly |
| `POST /api/swarm/run/[id]/board/sweep` | orphan; only in error-message strings |
| `POST /api/swarm/run/[id]/board/tick` | orphan; comment says "smoke scripts/curl only" |
| `POST /api/swarm/run/[id]/board/retry-stale` | orphan; UI button missing |
| `POST /api/swarm/recall` | orphan; designed for agents, no caller |
| `POST /api/swarm/memory/reindex` | orphan; described as one-shot install backfill |

**Fix.** Three options per route, picked individually:
1. Delete (most: `board` GET/POST, `board/[itemId]`, `recall`, `memory/reindex`)
2. Move to `/api/_debug/*` namespace (curl-only ones: `board/sweep`, `board/tick`)
3. Wire up the missing UI (`board/retry-stale` if intentional)

**Effort.** 1-2 hr cumulative.

**Verification.** `find app/api -name 'route.ts' | wc -l` drops from 20 to ≤14.

---

### C10. `lib/opencode/live.ts` (1452 LOC, 18 importers) — hook split

**Failure mode.** Largest file in repo. 6+ hooks in one file; HMR can't isolate them. Each hook lives independently; co-location is incidental, not architectural.

**Fix.** One hook per file under `lib/opencode/live/`:
- `use-opencode-health.ts`
- `use-live-session.ts`
- `use-live-sessions.ts`
- `use-live-swarm-run-messages.ts`
- `use-swarm-runs.ts`
- `use-swarm-run-snapshot.ts`
- `live-shared.ts` for the validators (R2) + types

**Effort.** 4-6 hr.

**Verification.** Each new file ≤ 300 LOC.

---

### C11. `lib/opencode/transform.ts` (1189 LOC) — transformer split

**Failure mode.** One transformer per output type (`toAgents`, `toMessages`, `toRunMeta`, `toLiveTurns`, `toFileHeat`, `toRunPlan`, `toTurnCards`, `toProviderSummary`) all in one file. 25 helpers are orphans (no caller outside the file) per the call-graph analysis.

**Fix.** Per-transformer files under `lib/opencode/transform/`. Shared helpers in `transform-shared.ts`. Dead-code sweep falls out naturally — orphan helpers per transformer are visible.

**Effort.** 3-4 hr.

**Verification.** Each new file ≤ 300 LOC. Call-graph rerun shows orphan count dropped substantially.

---

### C12. `lib/server/blackboard/planner.ts` (1234 LOC) — split

**Failure mode.** Sweep + tier ladder + prompts + parsers all in one file. 17 orphan helpers per call-graph.

**Fix.**
- `planner-prompt.ts` — `buildPlannerPrompt`, tier ladder, role notes
- `planner-parse.ts` — todowrite extraction, criterion viability checks
- `planner-sweep.ts` — `runPlannerSweep` (the orchestrator)
- `planner-types.ts` — interfaces

**Effort.** 3-5 hr.

**Verification.** Each new file ≤ 400 LOC.

---

### C13. `lib/server/memory/rollup.ts` (591 LOC) — capture/rollup/persist split

**Failure mode.** 13 functions, 11 orphans. Three concerns mixed: capturing diffs, computing rollups, persisting to memory DB.

**Fix.** `memory/rollup-capture.ts` + `memory/rollup-compute.ts` + `memory/rollup-persist.ts`.

**Effort.** 2-3 hr.

---

### C14. Smaller UI items (folded into K/L/M from prior plan)

- `components/inspector/sub-components.tsx` (798) — already partially extracted
- `components/swarm-timeline.tsx` (779) — pairs with C7
- `components/retro-view.tsx` (731) — section panels; also remove `document.activeElement` mutation + `window.location.reload()` (smell)
- `components/turn-cards-view.tsx` (619)
- `components/board-rail.tsx` (623)
- `components/agent-roster.tsx` (557)

Each is 3-5 hr; do incrementally as UX work surfaces them.

---

### C15. Pattern-rail shared helpers extraction

**Failure mode.** `wrap`, `turnText`, `countLines`, `compactNum` duplicated across 4-8 rail components. Every new pattern rail starts with copy-paste.

**Evidence.** Call-graph cross-module-duplicates: `wrap` × 8, `turnText` × 5, `countLines` × 5, `compactNum` × 4.

**Fix.** `components/rails/_shared.ts` with the four helpers. Replace duplicates.

**Effort.** 1-2 hr.

---

### C16. `parseVerdict` server-side only

**Failure mode.** `parseVerdict` defined in 2 server files (critic.ts, verifier.ts) AND 2 client rails (debate-rail.tsx, iterations-rail.tsx). Server already emits structured verdicts on board items; client is re-parsing the raw note text. Will drift on prompt format changes.

**Evidence.** Call-graph cross-tier duplicate.

**Fix.** Server emits `{verdict, confidence}` structured fields on the item. Client reads the field. Delete client-side parsing (~40 LOC).

**Effort.** 30 min.

---

### C18. Pattern-tunables consolidation

**Failure mode.** ~20 magic numbers scattered across pattern code:
- `lib/server/council.ts` — `ROUND_WAIT_MS`, `COUNCIL_CONVERGENCE_THRESHOLD`
- `lib/server/critic-loop.ts` — `ITERATION_WAIT_MS`, `NITPICK_CONF_MAX`
- `lib/server/debate-judge.ts` — `ROUND_WAIT_MS`, judge timeouts
- `lib/server/deliberate-execute.ts` — phase timeouts, classifier thresholds
- `lib/server/map-reduce.ts` — `SCOPE_IMBALANCE_THRESHOLD`, `MAX_DRAFT_CHARS_FOR_SYNTHESIS`
- `lib/server/blackboard/auto-ticker/*` — tier-escalation thresholds, sweep cadences

Each is `const FOO_MS = N * 60_000` with a comment justifying the choice. Tunable via patch. But there's no central registry — a stress test that wants to sweep "all wait timeouts ÷ 2" has to grep + edit each file.

**Evidence.** Architecture-seam audit found ~20 such constants. Many follow the same shape (`*_WAIT_MS`, `*_THRESHOLD`); none are runtime-configurable.

**Fix.** Add `lib/server/pattern-tunables.ts` re-exporting the timing + threshold constants by category:

```ts
export const TIMINGS = {
  council: { roundWaitMs: 10 * 60_000 },
  critic: { iterationWaitMs: 15 * 60_000 },
  // ...
} as const;

export const THRESHOLDS = {
  council: { convergence: 0.85 },
  mapReduce: { scopeImbalance: 5, maxDraftChars: 80_000 },
  // ...
} as const;
```

Pattern files import from this module instead of inlining. Stress tests can override (or wrap) the export at module load. **Do NOT** make these env-var-driven — that's a separate scope decision (we kept config sprawl bounded in C5; tunables are code-default constants, not user config).

**Effort.** 2-3 hr (mostly mechanical; the trickiest part is finding all the constants and naming them consistently).

**Verification.** `grep -rE 'const [A-Z_]+(_MS|_THRESHOLD|_MAX|_CHARS)\b' lib/server/{council,critic-loop,debate-judge,deliberate-execute,map-reduce}.ts | wc -l` returns ≤ 2 (just header constants left).

---

### C17. Direct import cycles (2)

**Failure mode.** Cycles aren't pervasive (only 2), but worth closing.

**Evidence.**
- `lib/server/blackboard/planner.ts ⟷ lib/server/degraded-completion.ts`
- `components/heat-rail.tsx ⟷ components/heat-rail/sub-components.tsx`

**Fix.** Extract shared types to a third file in each case.

**Effort.** 30 min total.

---

## Part V — Cumulative impact model

If the full plan ships, conservative estimates:

| Lever | Before | After | Net |
|---|---|---|---|
| Plan items | — | **43** (R×7 · D×9 · E×9 · C×18) | full |
| Total LOC | 49,430 | ~42,000 | -7,400 (-15%) |
| Files >500 LOC | 21 | ~5 | -16 |
| Test cases | 253 | ~320 | +67 |
| Test coverage on keystones | 0% | >70% | huge |
| Cold compile (snapshot route) | 1310 modules | ~250 | -1060 (-81%) |
| Cold compile (ticker route) | ~1100 | ~200 | -900 (-82%) |
| Polling HTTP req/min (per-page) | ~60 | ~20 | -40 (-67%) |
| API routes | 20 | ≤14 | -6 dead |
| Snapshot opencode probes per call (8-session run) | 16 | 8 | -50% |
| Empty-catch bug-magnets | 1 | 0 | done |
| HTTP boundary fail-open zombies | yes | no | done |
| Lock-map HMR resets | yes | no | done |
| meta.json crash-safe | no | yes | done |
| Auto-ticker concurrency races | 2 (resweepInFlight + ensureSlots) | 0 | done |
| Per-swarmRunID dispatch races | yes | no | done (D9 mutex) |
| Magic-number sprawl in pattern code | ~20 inline | 1 module (pattern-tunables.ts) | done |
| Mutation hooks: TanStack-uniform | 4 raw fetches | useMutation × 4 | done |

Resilience risk reduction is qualitative but concentrated: the 201-zombie bug class, the SDK schema-drift class, the lock-HMR class, and the dispatch-race class together account for most of the worst incident memories.

---

## Part VI — Rollout order

Ordered by leverage (severity × callers ÷ effort) within risk-reduction-first sequencing.

### Wave 1 — Resilience floor (5-7 hr)

Goal: stop the bleeding. After this wave, no more 201-zombies, no more schema-drift surprises, no more silent orphan kills.

1. **R3** (15 min) — `auto-ticker/state.ts:82` log line
2. **R1** (2-3 hr) — kickoff sync-throw → 5xx; gate-failure surfacing
3. **R2 + D7** (4-5 hr) — SDK validator + fixture firewall

### Wave 2 — Durability floor (6-9 hr)

Goal: lock down the failure-mode invariants. Parallel work; can split across sessions.

4. **D1** (1-2 hr) — meta.json atomic-rename + per-run mutex
5. **D2** (30 min) — globalThis-key the 3 lock maps
6. **D6** (30 min) — server-only on all 64 modules
7. **D8** (30 min) — auto-ticker `resweepInFlight` CAS-tighten
8. **D9** (1 hr) — per-swarmRunID dispatch mutex around `tickCoordinator`
9. **R4** (1-2 hr) — `OpencodeUnreachableError` + kill substring matches
10. **R7** (1-2 hr) — JSON.parse validators on disk reads
11. **R5 + R6** (3-5 hr cumulative) — API error-shape standardization + 4 untyped bodies

### Wave 3 — Test the keystones (13-18 hr)

Goal: durability through regression detection. After this wave, the next refactor doesn't ship blind.

10. **D4 #1** (2-3 hr) — `swarm-registry-lifecycle.test.ts`
11. **D4 #2** (3-4 hr) — `dispatch.test.ts → tickCoordinator`
12. **D4 #3** (folded into R2/D7)
13. **D4 #4** (4-6 hr) — 6 missing pattern integration tests; D5 ledger update
14. **D4 #5** (2 hr) — `planner-sweep.test.ts`

### Wave 4 — Efficiency wins (8-11 hr)

Goal: payoff for the user. After this wave, the page feels snappier and dev cycles are tighter.

15. **E1** (1 hr) — getSessionMessagesServer dedup
16. **E2** (30 min) — 4 raw-fetch consolidation
17. **E3** (30 min) — useBackendStale Context wrap
18. **E5** (30 min) — sha7 Promise.all
19. **E6 + E7** (2-3 hr) — board/ticker route + audit other multi-method routes
20. **E4** (2-3 hr) — fold ticker + strategy into board/events SSE; drop 2 polls
21. **E9** (2-3 hr) — `useMutation` migration for 4 POST raw-fetch sites

### Wave 5 — Capability decomp (42-63 hr cumulative)

Goal: the seams future work depends on. Sequence by cascade risk (highest-fan-in first), do incrementally.

22. **C3** (2-3 hr) — split swarm-registry along fs/derive seam (kills Q47)
23. **C4** (4-5 hr) — decompose tickCoordinator + add tests
24. **C2** (3-4 hr) — split `app/api/swarm/run/route.ts`; pattern dispatcher table
25. **C9** (1-2 hr) — delete/namespace 8 orphan endpoints
26. **C5** (2-3 hr) — `lib/api-types.ts` + `lib/config.ts`
27. **C18** (2-3 hr) — `lib/server/pattern-tunables.ts` magic-number consolidation
28. **C1 + C16 + C15** (2-3 hr) — `extractLatestAssistantText` lift + `parseVerdict` server-side + rail helpers
29. **C6** (3-4 hr) — page.tsx hooks (useSwarmView + useDiffStats)
30. **C7** (1-2 hr) — TimelineInteractionContext
31. **C10** (4-6 hr) — split live.ts
32. **C11** (3-4 hr) — split transform.ts
33. **C12** (3-5 hr) — split planner.ts
34. **C13** (2-3 hr) — split memory/rollup.ts
35. **C8** (4-5 hr) — new-run-modal + spawn-agent-modal + routing-modal
36. **C14** — remaining UI as UX work surfaces it
37. **C17** (30 min) — close the 2 import cycles

### Stop conditions (anti-scope-creep)

- Don't introduce `runPattern()` polymorphic interface (C1's stance is durable).
- Don't introduce Zod (existing manual validator idiom is sufficient and zero-dep).
- Don't introduce Server Actions (current `'use client'` + explicit API-route pattern is intentional simplicity).
- Don't optimize beyond the cumulative-impact targets — past that, you're paying complexity for no user-visible win.

---

## Appendix A — Mapping from prior tier letters

The earlier draft of this plan used tier letters A through X. Mapping for git-blame archaeology:

| Old | New section | Status |
|---|---|---|
| A (extractLatestAssistantText) | C1 | unchanged |
| B (swarm-registry tests) | D4 #1 | folded into wave 3 |
| C (24 empty catches) | R3 (corrected: only 1 real bug-magnet, not 24) | scope dramatically reduced |
| D (slim swarm-registry chain) | C3 (subsumed) | superseded |
| E (split live.ts) | C10 | unchanged |
| F (split transform.ts) | C11 | unchanged |
| G (page.tsx decomp) | C6 + C14 | restructured |
| H (split planner.ts) | C12 | unchanged |
| I (pattern consolidation) | C1 (rejected polymorphic interface; lift one helper only) | scope reduced based on architecture audit |
| J (integration test harness) | D4 #4 + D7 | folded |
| K, L, M (UI decomp) | C8 + C14 | restructured |
| N (split swarm-registry) | C3 | unchanged |
| O (coalesce primary-session fetch) | (not yet ported — minor item, do alongside C10) | parked |
| P (dead-code sweep) | (folds out naturally from C10/C11/C12 splits) | parked |
| Q (decompose tickCoordinator) | C4 | unchanged |
| R (rail helpers) | C15 | unchanged |
| S (parseVerdict server-side) | C16 | unchanged |
| T (live.ts orphan audit) | folded into C10 | merged |
| U (api/swarm/run split) | C2 | unchanged |
| V (new-run-modal split) | C8 | unchanged |
| W (swarm-timeline split) | C7 + C14 | restructured |
| X (memory/rollup split) | C13 | unchanged |

## Appendix B — Audit methodology (2026-04-26)

- Function-level call-graph: `scripts/_call-graph.mjs` — 207 files, 743 fn defs, 2 cycles, 4 hubs ≥8 callers
- File size lens: `find ... | wc -l` per file; 21 files >500 LOC
- 8 parallel research agents covering: error handling • type safety • async/race • API topology • test coverage • component state • performance • architecture seams
- Cross-checked agent claims against direct grep on the codebase before committing them to this plan
- Output: `docs/CALL_GRAPH.md`, `docs/HARDENING_PLAN.md`, agent transcripts in `/tmp/.../tasks/*.output`
