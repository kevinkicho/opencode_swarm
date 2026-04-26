# Status — where the project is right now

**What this file is.** A time-scoped snapshot of what has shipped, what
has rough edges, and what's queued. Complements the 5 durable docs
(`CLAUDE.md`, `DESIGN.md`, `SWARM_PATTERNS.md`, `WHAT_THIS_PROJECT_IS_NOT.md`,
`docs/ARCHITECTURE.md`) — those are stable reference material you read
once per task; this file you check when asking "where are we?"

**What this file is NOT.** Not a changelog (`git log` is canonical). Not
a design-decisions log (`DESIGN.md` §9 owns that). Not a roadmap (this is
present-tense). Not a todo list for individual tasks — if it can be done
in < 30 min, put it in the conversation or a commit, not here.

**Maintenance.** Append-only during a work session; rewrite (prune +
reorganize) every couple months. Keep known-limitations and queued items
current — remove when shipped or explicitly abandoned.

---

## Last updated

**2026-04-23** — post-consolidation. Today's 12 incremental shipped
entries folded into one themed block. Next review: ~2026-06-01 or
whenever the file has drifted enough that scanning it doesn't match
the actual state.

---

## Shipped

### 2026-04-26 — hard-stop run button (#105)

Soft `abort` only targets the primary session — multi-session runs
(council, debate-judge, role-differentiated, etc.) keep N-1 worker /
critic / verifier / auditor sessions tokenating, AND the orchestrator
coroutine keeps waiting. User reported `run_mof0ct1k_qpmsw1` (a
stress-test map-reduce run) bleeding tokens for 1.5 hours after
clicking abort.

**Endpoint:** new `POST /api/swarm/run/:swarmRunID/stop`. For
ticker-bearing patterns (blackboard / orchestrator-worker /
role-differentiated / deliberate-execute phase 3): calls
`stopAutoTicker(runID, 'operator-hard-stop')` — the ticker's
existing teardown handles abort cascade + run-end audit + persisted
snapshot. For non-ticker patterns (council / debate-judge /
critic-loop / map-reduce phase 1): explicitly aborts every session
in `meta.sessionIDs` plus critic / verifier / auditor.
Either way, records a `recordPartialOutcome` finding tagged
`operator-hard-stop` so the board carries durable evidence.

**StopReason:** added `'operator-hard-stop'` as a discrete reason
distinct from `'manual'` (which means stopping the auto-ticker
without aborting sessions). The run-health banner can now
distinguish these two operator actions.

**UI:** new `HardStopChip` in `swarm-topbar.tsx` next to existing
soft `AbortChip`. Two-step confirm to prevent accidental kills:
first click arms (3s auto-disarm window so a stray click doesn't
become a permanent landmine on the next click), second click
executes. Distinct rust styling + animate-pulse on armed state.
Disabled while in-flight; shows "stopped" terminal state after
success.

**Tradeoff:** in-flight tool calls land as-is — no rollback. A
worker mid-edit when stop fires will leave its file changes on
disk. Acceptable: the alternative is the current "stuck forever"
state.

### 2026-04-26 — stuck-deliberation detector + picker indicator (#104)

A run that's been alive long enough to produce output but has zero
board items and accumulated significant tokens is "stuck" — neither
the silent-watchdog nor the wall-clock cap will catch it because
parts ARE arriving and the run isn't actually past its budget yet.
This was the failure shape behind multiple MAXTEAM-2026-04-26 runs:
council × 8 (3.85M tokens / 0 items / stale), deliberate-execute × 8
(3.4M tokens / 0 items / stuck phase 1), map-reduce × 8 (10.3M tokens
/ 0 items / synth-starved).

**Fix:** new pure helper `lib/server/stuck-detector.ts`. Returns
`{ stuck: true, reason }` when ALL three conditions hold:
- `tokensTotal > 500K` (below this is normal startup)
- `ageMs > 10 min` (below this is normal model warm-up + first sweep)
- `boardItemCount === 0` (no findings, no todos, no criteria)

Wired into `GET /api/swarm/run` so every list-row carries an optional
`stuck?: { reason }` field. `swarm-runs-picker.tsx` shows a `⚠` next
to the status label when set, with a tooltip carrying the full reason
("3.4M tokens spent over 30 min, board still empty — likely stuck
deliberation"). 10 unit tests in `stuck-detector.test.ts`.

Detection only — does not abort. The hard-stop button (#105, queued)
gives the operator the action; this signal tells them which runs
need it. Total cost: one `listBoardItems` call per row in the list
endpoint (sub-ms local SQLite).

### 2026-04-26 — error-path findings: withRunGuard fallback + coordinator error-text (#95 + #96)

Two related gaps from MAXTEAM-2026-04-26 closed in one pass:

**#95 — `withRunGuard` fallback partial-outcome**

debate-judge teamSize=8 went `status=error` with 944K tokens and **0
findings** because the orchestrator threw an unhandled exception
that bubbled past the orchestrator's own recordPartialOutcome sites
into the route's bare `.catch()`. `withRunGuard` had a try/finally
shell but no error-catch.

Fixed by adding a try/catch inside `withRunGuard` that records a
`<context> (unhandled-exception)` partial-outcome with the error
message, then re-throws so the route-level logging still fires.
Covers council, critic-loop, debate-judge, map-reduce — all four
patterns that route through `withRunGuard`.

**#96 — Coordinator error-text extraction**

role-differentiated teamSize=8 reported `status=error` after 3 done
with no log line explaining the stop. Root cause: the coordinator's
worker-dispatch wait-result mapped `reason='error'` to the generic
string `'turn errored'`, dropping opencode's actual `info.error`
text (the field that carries "rate limit", "context exceeded",
model-specific provider errors, etc.).

Fixed by re-fetching the session messages on the error branch and
extracting the latest assistant message's `info.error.message`
field. The stale-note now carries
`turn errored: <provider error excerpt>` so the operator sees the
real reason on the board, and `retryOrStale`'s log line surfaces
the same string.

### 2026-04-26 — planner-sweep zero-todo findings (#99)

MAXTEAM-2026-04-26 found blackboard at teamSize=8 burning 1.2M tokens
across repeated sweeps that never seeded any board items. Operators
saw "no items" with no explanation of what the planner had been
doing — only dev-log WARN lines.

**Fix:** `runPlannerSweep` now records two distinct operator-visible
findings via `recordPartialOutcome` when a sweep produces zero items:

1. **`planner-sweep (zero-todo)`** — planner finished its turn but
   never called `todowrite`. Finding includes a 200-char assistant
   reply excerpt + common-causes hint (abstract directive, model
   regression, missing workspace artifacts) and remediation guidance
   (rephrase, switch pattern).
2. **`planner-sweep (filtered-all-todos)`** — planner DID call
   `todowrite` but every entry was filtered before insert
   (`isViableCriterion` rejected vague entries, empty content, etc.).
   Finding shows the dropped count and points the operator to the
   strategy tab to inspect the planner reply.

Both surface as findings on the board, not just dev-log lines, so
the operator sees them in the same UI surface where they were
expecting work to land. Operator's pattern + directive choice still
stands; the run can be relaunched with revisions.

### 2026-04-26 — council & deliberate-execute scale-aware round cap (#98)

MAXTEAM-2026-04-26 found council at teamSize=8 ran 24 turns of cross-
talk × 3 rounds without converging in the 30-min wall-clock cap.
Deliberate-execute's phase-1 council got stuck for the same reason
and never reached synthesis (3.4M tokens / 0 done at test stop).

**Fix:** new `recommendedDeliberationRounds(teamSize)` helper exported
from `lib/server/council.ts`. teamSize ≤ 4 → 3 rounds (default
preserved); teamSize ≥ 5 → 2 rounds. `runCouncilRounds` and
deliberate-execute's phase-1 both use it as the default when no
explicit `maxRounds` is supplied. Empirical envelope:
`teamSize × rounds × ~1-2 min/turn` now stays under 30 min for every
size we accept. Caller-supplied `opts.maxRounds` still wins.

The recommendedMax for council and deliberate-execute (5 and 4 from
#101 / #103) already keep most operators in safe territory; this fix
adds belt-and-braces protection for the high end. New log line at
kickoff when the cap fires:
`[council] run <id>: scale-aware round cap = 2 rounds for teamSize=N (#98)`.

Tests: `recommendedDeliberationRounds` covered in
`council-convergence.test.ts` — 4 tests verifying the boundary at 5
and the floor at 2.

### 2026-04-26 — map-reduce synthesis-prompt overflow guard (#97)

MAXTEAM-2026-04-26 found map-reduce at teamSize=8 burning 10M+ tokens
across 8 mappers with 0 done items — the synthesis claim never
landed because the concatenated drafts overflowed every model's
context window.

**Fix:** `buildSynthesisPrompt` now caps each individual mapper's
draft at 80,000 chars (~20K tokens) before concatenation. With 8
mappers that bounds the synth prompt at ~640K chars (~160K tokens),
which fits in GLM's 202K-token context with synth-prompt scaffolding
overhead. At the recommended `teamSize ≤ 5` (the picker hint from
#103) the cap rarely triggers — focused mappers tend to land well
under it. New `truncateDraftForSynthesis` helper is exported and
unit-tested in `lib/server/__tests__/map-reduce-truncate.test.ts`.

When truncation fires, the synthesizer sees a clear marker per
truncated draft (`*[…truncated for synthesis: N additional chars
omitted…]*`) AND a dev-log warning surfaces the count + the
recommendedMax hint, so operators can tune teamSize down for the
next run.

### 2026-04-26 — critic-loop runaway-token leak fixed (#100)

The MAXTEAM-2026-04-26 stress test caught a critic-loop run
(`run_mof0de0o_z31ohi`) burning 955K tokens / 30+ min on a single
worker turn that never completed. Diagnosis + fix recorded as
`docs/POSTMORTEMS/2026-04-26-critic-loop-runaway-token.md`.

**Root cause:** `waitForSessionIdle()` in
`lib/server/blackboard/coordinator.ts` had four watchdog branches that
each called `abortSessionServer` before returning (silent / tool-loop /
provider-unavailable / silent-warn). The plain deadline-expiry branch
(`while (Date.now() < deadline)` exit, line 810 pre-fix) returned
`{ ok: false, reason: 'timeout' }` **without aborting**. Net effect:
the orchestrator stops waiting after `ITERATION_WAIT_MS`, but the
worker turn keeps streaming tokens in opencode forever — F1 silent
watchdog never triggers because parts are growing, just not completing.

**Fix:** Track `lastSeenInProgress` inside the poll loop. When the
deadline expires AND the most recent poll saw an in-progress turn,
abort the session before returning timeout. When the most recent poll
saw all turns completed (just waiting on the `SESSION_IDLE_QUIET_MS`
buffer), don't bother — those sessions are already idle. New log line:
`[coordinator] session ses_<id> timeout with in-progress turn —
aborting (task #100)`.

**Knock-on:** Every other caller of `waitForSessionIdle(..., deadline)`
gets the same guarantee — planner sweep timeouts, blackboard worker
dispatch, council/debate-judge/role-differentiated/orchestrator-worker
sub-waits. The orchestrators above didn't need code changes; they
already returned partial-outcome, now the session bleed stops too.

**Validation probe:** see postmortem §4. PENDING — needs a future
critic-loop run with a token-heavy directive to confirm the
"aborting (task #100)" log line lands and `tokensTotal` plateaus
within ~30 s.

### 2026-04-26 — stress-test follow-up: dev-gate + teamSize ceilings (#102 + #101 + #103)

Three closely-coupled fixes from the MAXTEAM-2026-04-26 stress-test
ledger. All read from a single source-of-truth (`patternMeta.recommendedMax`)
so the kickoff WARN, picker hint, and stress-test ledger never drift
out of sync.

**Code shipped:**

- **`scripts/dev.mjs` tsc --noEmit gate** (`0c7e895`, #102) — runs
  `npx tsc --noEmit` before binding the dev port, refuses to start
  on non-zero status, prints offending stdout+stderr. Skip via
  `--skip-tsc` flag or `DEV_SKIP_TSC=1` env. Cost: ~10–15 s cold cache,
  ~3–5 s warm. Rationale: during the 2026-04-26 max-team-size run, two
  parallel-session breakages (heat-rail.tsx duplicated `<Tooltip>`,
  coordinator.ts `await` in non-async map) silently 500'd every
  snapshot endpoint mid-stress-test. Catching those before bind would
  have saved ~5 min of monitoring blindness. See
  `docs/STRESS_TESTS/2026-04-26-max-team-size-8.md` "Mid-run incidents".

- **Per-pattern `recommendedMax` + kickoff WARN** (this commit, #101) —
  added a `recommendedMax` field to `PatternMeta` carrying the empirical
  ceiling each pattern survived in the 2026-04-26 stress test (8 except
  orchestrator-worker, 5 for council/map-reduce, 6 for blackboard/
  role-differentiated, 4 for debate-judge/deliberate-execute, 2 for
  critic-loop). New `teamSizeWarningMessage(pattern, teamSize)` helper
  is pure + unit-tested (8 tests, `lib/__tests__/swarm-patterns.test.ts`).
  The `/api/swarm/run` POST handler calls it after teamSize resolution
  and emits a `console.warn` referencing the stress-test ledger when
  the run exceeds the ceiling. Advisory only — the route still accepts
  up to `TEAM_SIZE_MAX=8`.

- **New-run picker recommendedMax readout** (this commit, #103) — under
  the team picker, a one-line readout shows
  `recommended max for {pattern}: N · current K`. When K > N, the line
  flips amber and surfaces a hover-tooltip carrying the same warning
  text the server emits, so the user sees the failure-mode reference
  without leaving the modal. Single source of truth: imports
  `teamSizeWarningMessage` directly so server WARN and picker hint can't
  diverge.

**Tests:** 205 passing (was 196). New file `lib/__tests__/swarm-patterns.test.ts`
covers the per-pattern ceilings + warning shape + the orchestrator-worker
"only one that scaled cleanly" assertion. tsc --noEmit clean.

### 2026-04-26 — pending-validations sweep + perf wiring + log-tail HMR fix

User asked to clear the backlog of "shipped but unvalidated" items
that had accumulated across sessions. Five candidate items audited
from `STATUS.md`, `IMPLEMENTATION_PLAN.md`, and
`memory/project_pending_validation_run.md`. 4 of 5 closed; #91 left
for human-in-loop because it requires the user to start a target
repo's dev server.

**Code shipped:**

- **`useSwarmRunSnapshot` hook + page wiring** (`efbbd0a`, #89, IMPL
  6.6 follow-up) — TanStack-Query-backed aggregator hook that fetches
  `/api/swarm/run/:id/snapshot` once on cold load, replacing the
  previous separate `useLiveSwarmRun` round-trip. Snapshot bundles
  meta + status + derivedRow + tokens + board + ticker +
  planRevisions count. Live updates continue to flow through the
  existing SSE channels (`/board/events`, `/event` proxy) — this
  hook only owns the cold-load seed. Backend was previously measured
  for 4.5x cold / 3x warm-cached speedup vs the prior 5-call fan-out
  (commit c85724a); page now actually consumes that endpoint.
  30s staleTime; SSE keeps page fresh after.

- **opencode-log-tail globalThis-keyed state** (`0497417`, #90) —
  state was module-scoped, so Next.js HMR module reloads created
  fresh state=null on every reload. The idempotency check
  `if (state?.timer) return;` then incorrectly treated every reload
  as "first run" and started ANOTHER setInterval; the previous
  module's timer kept running too. Net effect: dozens of
  "[opencode-log-tail] starting (F2)" log lines per dev session
  and N concurrent tails reading the same file in parallel. Fix:
  stash state on globalThis with a `Symbol.for` key (matches the
  same HMR-survival pattern used by metaCache, listCache,
  baselineCache, deriveRowCache, publishExports). One tail per dev
  process now.

**Live validations:**

- **#92 ambition-ratchet** — VALIDATED. Spawned a tiny-directive
  blackboard run (`run_moex95aq_dihkz4`, "add a single comment line
  to README.md") with `bounds.minutesCap: 15, todosCap: 20`. The
  board drained naturally to 0; ticker idled 76 consecutive cycles;
  ambition-ratchet escalated **tier 1 → 2 → 3 → 4 → 5 ("Vision",
  MAX_TIER)**. Final state: 7 todos done, 8 items, currentTier=5,
  tierExhausted=true, stopReason=`wall-clock-cap`. First time tier
  escalation has fired in anger; the path works end-to-end across
  all tier transitions. Dev log captured each step:
    - `attempting tier escalation 1 → 2 (Reach)`
    - `attempting tier escalation 2 → 3 (Substantive)`
    - `attempting tier escalation 3 → 4 (Architectural)`
    - `attempting tier escalation 4 → 5 (Vision)`
    - `at MAX_TIER=5 — re-sweeping at tier 5 instead of escalating`

- **Bonus: #88 planner-sweep degraded-completion** — VALIDATED in
  production during the ratchet run above. When the tier-5 planner
  sweep errored (`tier-5 escalation threw: planner sweep failed:
  assistant turn errored`), today's #88 plumbing landed a finding:
  `note: degraded-completion blackboard error`,
  `content: [blackboard] partial outcome — orchestrator stopped at:
  planner-sweep (reason: error)`. Exactly the gap that bit
  role-differentiated earlier this calendar day; now closed AND
  verified end-to-end.

- **#93 pattern benchmark script** — VALIDATED. Invoked
  `scripts/_pattern_benchmark.mjs --workspace ... --patterns
  blackboard --max-done 1 --max-minutes 3`. Script ran end-to-end:
  spawned a swarm run, polled progress with timestamps every ~15s,
  hit max-minutes terminal correctly, produced the comparison table,
  persisted JSON to `/tmp/pattern-benchmark-<ts>.json`. The 0-done
  result is expected for the tight 3-minute cap; the script
  MACHINERY works.

**Deferred:**

- **#91 Playwright verifier gate** — initially deferred (requires
  target repo dev server). Then SHIPPED+VALIDATED in this same
  session — see entry below.

### 2026-04-26 — Playwright verifier gate live validation (#91)

Closed the last pending validation. Started kyahoofinance032926's
Vite dev server from WSL myself (after fixing a `@rollup/rollup-
linux-x64-gnu` missing-on-WSL issue with a single targeted install).
Spawned `run_moez4chh_xo7rnm` against the live dev URL with
`enableVerifierGate: true` + `enableCriticGate: true`, 6 sessions,
30min cap.

All three observables from `memory/project_pending_validation_run.md`
fired in production:

  Observable                                      | Result
  -----------------------------------------------|------------------
  Planner emits [verify] prefix on UX todos      | ✅ 11/23 items had requiresVerification: true
  Verifier composes Playwright via bash          | ✅ Real `playwright.chromium.launch()` scripts hitting localhost:5173
  [verifier-rejected] notes flow back to stale   | ✅ 7 items with concrete rejection reasons

Concrete verifier-rejected examples (real verifier output, not
synthetic):

  - "The correlations bento panel and ECharts heatmap were not
    detected on the page."
  - "No indicators of supply/demand data, surpluses, or deficits
    were found on the page."
  - "The Calendar sidebar sections (Today, This Week, Next Central
    Bank, Policy Rates) were not found on the page."

Bonus: 7 critic-rejected items also landed in parallel — the critic
and verifier gates run together correctly without stepping on each
other.

The verifier gate works end-to-end as designed: planner teaches
workers about the [verify] prefix → workers attempt fixes → verifier
exercises the live dev server via Playwright → mismatches between
worker claims and rendered UI surface as [verifier-rejected] so the
work cycles back through retry. This is the clearest validation
this feature could get; closing the long-standing "shipped but
unvalidated" loop.

### 2026-04-25 night — UX polish, test coverage push, autonomous validation

Continuation of the same calendar day's work. Capabilities and test
coverage expanded substantially while running 8 parallel 30-minute
validation runs autonomously to ground today's changes.

**UX polish (committed):**

- **Sticky-scroll robustness** (`33ba0f9`) — `useStickToBottom` gained
  a `ResizeObserver` so SSE chunks arriving 50-1000ms after a content
  change still snap to bottom. Previously only the FIRST mount got
  the multi-pass snap; subsequent updates only ran a single sync
  snap that read scrollHeight before late content settled.
- **Runs picker widening** (`de58883`, `ab3ead3`) — popover widened
  760 → 1100px; pat column widened 90 → 140px so long pattern names
  (`role-differentiated`, `orchestrator-worker`, `deliberate-execute`)
  fit without truncation.
- **View-tab tooltips** (`6be9d82`) — every run-view tab (timeline,
  cards, board, contracts, plus 7 pattern-specific tabs) now carries
  a hover hint via `VIEW_PATTERN_GATES` config. `filter` and `parts`
  toggles in the timeline got tooltips disambiguating the
  quick-preset vs granular-checkbox mechanic.
- **WSL2 dev perf caches** (`44bdea3`, `1219454`) — `getRun()` now
  has a 2s TTL cache; `listRuns()` got a 15s TTL cache;
  `deriveRunRowCached` TTL bumped 2s → 10s. Each /mnt/c file read
  costs 50-200ms on WSL2's 9P protocol; with 80+ accumulated runs
  the picker took 2.8s cold. Cached path: 162ms (~18× speedup).

**Page.tsx decomposition (#84) shipped:**

  page.tsx: 1644 → 1340 lines (-304, -18.5%)
  initial module count: 2345 → 1249 (-46%)

  - 10 conditionally-rendered view components → `next/dynamic`
    (loaded on tab click, not initial bundle): TurnCardsView,
    BoardFullView, ContractsRail, IterationsRail, DebateRail,
    RolesRail, MapRail, CouncilRail, PhasesRail, StrategyRail.
    Each wrapped in `lazyWithRetry` for HMR-rotation tolerance.
  - StatusRail (224 lines) and RunNotFoundScreen (43 lines)
    extracted to `components/status-rail.tsx` and
    `components/run-not-found-screen.tsx`.
  - `safePost` helper consolidated 4 repeated cost-cap-block
    error-handling patterns (`onForwardDraft`, `onStartRoundTwo`,
    `OrchestratorActionsStrip onAction`, `SwarmComposer onSend`).
  - `VIEW_PATTERN_GATES` config replaced 3 duplicated runView
    structures (state union, toolbar render, auto-reset effect)
    with one source of truth. Each gate also carries a `hint`
    string for the tab tooltips.

**Orchestrator entry-shell consolidation (#82):**

`withRunGuard` extracted to `lib/server/run-guard.ts`. Wraps the
~20-line meta-read + pattern-check + finalizeRun-in-finally shell
that was duplicated across 4 non-ticker orchestrators (council /
critic-loop / debate-judge / map-reduce). Body still owns its
state machine; only entry/exit is shared. deliberate-execute does
NOT use the helper (composite 3-phase lifecycle, each phase owns
its own cleanup). Coordinator's `pickSession`/`pickTodo` extraction
left the working tree broken on a parallel session — reverted
before this commit; intentionally not re-attempted (different scope
from #82).

**Test coverage growth: 78 → 194 tests (+116):**

Six new test files lock in pure-function contracts that previously
lived only in source:

  withRunGuard                        7 cases — guard branches + finalize
  classifyCriticReply                10 cases — YAML I1 contract +
                                                legacy fallback
  classifyJudgeReply                 14 cases — verdict classification +
                                                I2 addressed-fraction math
  meanPairwiseJaccard                 7 cases — convergence math
  classifyDirectiveComplexity +      12 cases — I4 directive classifier +
   classifySynthesisReply                       I1 verifier verdict
  Coordinator pure helpers           28 cases — turnTimeoutFor,
                                                zombieThresholdFor,
                                                currentRetryCount,
                                                extractPathTokens,
                                                pathOverlaps,
                                                relativizeToWorkspace
  parseUnifiedDiff +                 17 cases — diff parser (single
   parseSessionDiffs + filterForTurn             hunk, multi-hunk,
                                                edge cases)
  priceFor + tokensForBudget +       12 cases — pricing math
   withPricing
  deriveSilentSessions                9 cases — run-health chip detector

Surface change: ~12 functions promoted to `export` (stable contracts;
tests own them now).

**Autonomous parallel validation (8 runs, 30-min cap):**

Spawned all 8 patterns simultaneously around 20:00 local with
`bounds.minutesCap: 30`. Run-IDs:
  blackboard           run_moese3ip_p337vx
  council              run_moese42c_37at6r
  map-reduce           run_moese4mh_den0hf
  orchestrator-worker  run_moese5m9_ymc2r4
  role-differentiated  run_moese62w_m2dclg
  debate-judge         run_moese6v3_9dxdzm
  critic-loop          run_moese9p0_4b1cz1
  deliberate-execute   run_moesea79_5k8fs9

Mid-flight observations (~17 min in):
  - 7/8 producing real tokens (blackboard 245K, council 901K,
    map-reduce 381K, orchestrator-worker 226K, debate-judge 437K,
    critic-loop 270K, deliberate-execute 668K).
  - 1/8 hit `status=error`: role-differentiated's planner sweep
    went silent at ~50K tokens. Dev log: "planner sweep aborted:
    session went silent (provider unreachable?)". Real ollama-side
    hang, not a code bug; F1 watchdog tripped correctly.
  - map-reduce had one mapper session go silent mid-phase; I3
    partial-map tolerance handled it ("proceeding with its last
    completed text"). Working as designed.
  - Many opencode upstream "ERROR service=server error= failed"
    log lines with empty error messages — ollama-side timeouts/
    crashes, not actionable from app side.

Final results (~30 min in, runs at or near wall-clock cap):
  blackboard           live   items=11 done=1   findings=0  tokens=527K
  council              live   items=0  done=0   findings=0  tokens=986K
  map-reduce           live   items=1  done=0   findings=0  tokens=456K
  orchestrator-worker  live   items=5  done=2   findings=0  tokens=322K
  role-differentiated  error  items=0  done=0   findings=0  tokens=50K   (early planner-silent abort)
  debate-judge         live   items=0  done=0   findings=0  tokens=437K
  critic-loop          error  items=1  done=1   findings=1  tokens=270K  (degraded-completion fired)
  deliberate-execute   error  items=2  done=2   findings=2  tokens=874K  (degraded-completion ×2)

Total board.done across runs: 6. Total findings (degraded-completion):
3. Total tokens: ~3.95M. The 3 findings ARE today's #73 plumbing
firing correctly in production:
  - critic-loop:        "iter 1/3 worker-wait (reason: silent)"
  - deliberate-execute: "draft-harvest (too-few-drafts (1))"
  - council (via delib-exec phase 1): "round 2/3 draft-fan-in
    (too-few-drafts (0/3))"

This is real validation that the reliability ship works under load.

**Test coverage growth this session:**

  78 → 194 tests (+116, +149%)
  6 → 14 test files
  ~1954 lines of test code

New test files (this session, 13:00-13:35 local):
  run-guard.test.ts                   (7)  — withRunGuard branches
  critic-loop-verdict.test.ts        (10)  — yaml + legacy parser
  debate-judge-verdict.test.ts       (14)  — verdict + I2 math
  council-convergence.test.ts         (7)  — meanPairwiseJaccard
  deliberate-execute-classify.test.ts (12) — I4 + I1 verifier
  coordinator-helpers.test.ts        (28)  — pure helpers
  transform.test.ts                  (17)  — diff parser
  pricing.test.ts                    (12)  — priceFor / budget
  silent-session.test.ts              (9)  — health chip detector

Surface change: ~12 functions promoted to `export` (stable contracts;
tests own them now).

### 2026-04-25 evening — reliability hardening + broad live validation

Eight tasks closed, every behavioral change grounded by 16 spawned runs.

**Code shipped:**

- **Wall-clock cap on non-ticker patterns** (`ccdeb0d`, #85). Council, critic-loop, debate-judge, map-reduce, and deliberate-execute now check `bounds.minutesCap` at the top of each iteration / round / dispatch; partial deliberation stays in opencode for human review. Default 60min when `bounds.minutesCap` is unset. Shared helper at `lib/server/swarm-bounds.ts`.
- **Granular ticker stopReasons** (`b621d52`, #65 Phase A). Split the generic `'hard-cap'` into `'wall-clock-cap'` / `'commits-cap'` / `'todos-cap'` so the run-health UI can name WHICH ceiling was hit. Old persisted snapshots still readable.
- **Retry differentiation** (`610603e`, #76). When `retryOrStale` flips a stalled todo back to open, the next dispatch's prompt now includes the prior failure reason so the worker doesn't hit the same failure mode silently.
- **Latency-disparity script** (`b6ea9f6`, #79). `scripts/_latency_disparity.mjs <runID>` reports per-session turn count + median + p95 duration + tokens; flags any session ≥ 2x run median.
- **Pattern validation gate** (`077fcf6`, #70). `scripts/_validate_all_patterns.mjs` codifies the manual workflow into a scripted PASS/FAIL gate.
- **Degraded completion** (`c7c3e10`, #73). Iterative orchestrators (5 patterns) now record a `kind=finding` board item summarizing partial state when their loop aborts, instead of returning silently. 7 + 8 + 5 + 6 + 2 = 28 instrumented call sites.
- **opencode contracts doc** (`0ca507b`, #83). `docs/opencode-contracts.md` catalogs every implicit contract (silent-drop traps, model-format object shape, workspace-path encoding, zombie turns). Read before wiring a new opencode call site.
- **Runtime shape validation** (`04e760a`, #81). `parseOpencodeJSON` at every opencode response boundary throws clear errors on shape drift; per-endpoint validators in `lib/opencode/validators.ts`.

**Broad live validation (16 runs, ~$2-5):**

- *Phase 1 — happy path × 8 patterns:* 7/8 PASS. deliberate-execute's "FAIL" was inconclusive — synthesis succeeded but the execution-phase worker hit `opencode-frozen` (real opencode/ollama hiccup, not our bug).
- *Phase 2 — forced wall-clock cap on 5 non-ticker patterns:* 4/5 lit up the new partial-outcome path with `kind=finding note='degraded-completion <pattern>'` rows. debate-judge's run completed naturally with WINNER (not exercised; same plumbing as the 4 that did fire).
- *Phase 3 — forced wall-clock cap on 3 ticker patterns:* 3/3 PASS. blackboard, orchestrator-worker, role-differentiated each stopped at 60s with `stopReason='wall-clock-cap'` (the new granular reason from #65).

**Failure modes surfaced (not blocking, queued for future investigation):**

- **deliberate-execute execution-phase worker silence.** Synthesis succeeds (synthesized todo lands on board), but the same session that ran synthesis goes silent when the auto-ticker tries to claim the todo. Ticker correctly records `stopReason='opencode-frozen'`. Real opencode/ollama issue; would benefit from a session-rotation experiment (next claim goes to a fresh session).
- **debate-judge declares WINNER on starved generators.** When generators go silent during round 1, partial drafts can still satisfy `present.length >= 2` and the judge produces a verdict from incomplete content. Worth investigating later — model-side artifact, not orchestration bug.

### 2026-04-24 — blackboard declared-roles Stage 2 (Auditor + contract + hard caps)

Completes the ollama-swarm spec alignment started in Stage 1. Closes
P0 gaps from the 2026-04-24 declared-roles audit: no auditor role, no
criterion contract, no "all criteria met" feedback loop, no hard-cap
enforcement. Four self-contained commits (3ffb9c9, 3cb09c0, a68d824,
this one), smoke-tested between each.

**Stage 2.1 — Criterion as BoardItemKind (3ffb9c9).**
- New `kind='criterion'` on `BoardItem`; status values reused per-kind
  (open=pending, done=met, blocked=unmet, stale=wont-do).
- `stripCriterionTag` parser for `[criterion]` content prefix;
  composes with existing tags.
- Planner prompt teaches the LLM to author 3-6 criteria at boot + add
  new ones on later sweeps (never rewrite existing ones — frozen
  contract text).
- `buildPlannerBoardContext` surfaces criteria with verdict labels
  (`[MET]` / `[UNMET]` / `[pending]`) so re-sweeps target unmet.
- UI: new diamond glyph `◆` for kind='criterion' in board-rail +
  board-preview (amber).
- Coordinator picker already filtered by kind — criteria safely
  excluded from worker dispatch without code change.

**Stage 2.2 — Auditor session + batch review (3cb09c0).**
- `lib/server/blackboard/auditor.ts` — mirror of critic.ts; per-run
  mutex; batch audit (N criteria → N verdicts in one prompt/reply).
- `auditCriteria({ swarmRunID, auditorSessionID, criteria,
  recentDoneSummaries, currentTier })` → verdicts `met|unmet|
  wont-do|unclear`.
- Opt-in `enableAuditorGate` + `auditEveryNCommits` on
  `SwarmRunRequest` + `SwarmRunMeta`. Blackboard-family only.
- Route Step 2.7 spawns dedicated auditor session at run creation;
  fail-open on spawn failure (same as critic/verifier).
- finalize-run + auto-ticker cleanup paths all abort the auditor
  session on run end.

**Stage 2.3 — Audit cadence in auto-ticker (a68d824).**
- Three triggers: every K commits (fire-and-forget), on tier
  escalation (AWAITED so verdicts are in the next sweep's prompt
  context), on run-end (fire-and-forget).
- `maybeRunAudit(state, reason)` applies verdicts via
  `transitionStatus`:
    - MET → done (from 'open'|'blocked')
    - UNMET → blocked (criteria can oscillate)
    - WONT_DO → stale
    - unclear → no transition (retry next audit)
- `TickerState`: `commitsSinceLastAudit`, `auditInFlight`,
  `auditEveryNCommits` (lazy-synced from meta).

**Stage 2.4 — Hard caps + MAX_TIER continuity (this commit).**
- User's 2026-04-24 termination precedence: ratchet wins over
  "all criteria met"; run continues until a hard cap or manual stop.
- `SwarmRunBounds` extended: `commitsCap` (default 200),
  `todosCap` (default 300). `minutesCap` already existed, now
  enforced (default 480 = 8h).
- `StopReason` gains `'hard-cap'`.
- `checkHardCaps(state)` runs on every commit (via tickSession) and
  every liveness tick (60s — catches wall-clock on quiet runs).
- `attemptTierEscalation`: MAX_TIER NO LONGER stops the ticker —
  caps `nextTier` at MAX_TIER and re-sweeps there. Subsequent
  cascades re-sweep at MAX_TIER again (throttled by
  MIN_MS_BETWEEN_SWEEPS). `tierExhausted` stays as a diagnostic
  flag but no longer feeds into any stop path.
- Deleted the `if (state.tierExhausted) stopAutoTicker('auto-idle')`
  branch from the idle-cascade tick logic.
- Route validator accepts `bounds.commitsCap` + `bounds.todosCap`
  as positive integers.

Design decisions pending (from 2026-04-24 design conversation):
- ✅ #1 Criterion shape: BoardItemKind='criterion' + free-text content
- ✅ #2 Authorship timing: refine-as-you-go (planner can add on later
       sweeps; auditor can also add; neither rewrites existing)
- ✅ #3 Termination precedence: ratchet wins; at MAX_TIER keep going
       until hard cap or manual stop
- ✅ #4 Audit cadence default: K=5; audit on tier escalation (yes);
       audit at run-end (yes)

Typecheck clean through all four commits. Smoke tests green:
- _parser_smoke.mjs         — 30 passed
- _stage1_smoke.mjs         — 20 passed
- _ollama_smoke.mjs         — 55 passed
- _team_models_smoke.mjs    — 11 passed

### 2026-04-24 — blackboard declared-roles Stage 1 (CAS hardening)

Stance revision: user rescinded "blackboard is self-organizing, no
declared roles" after practical testing with ollama-swarm. The
blackboard pattern now carries declared roles and proper CAS
protection on file claims — closer alignment with the ollama-swarm
spec that proved out in production. Stage 1 is the CAS-hardening
bundle; Stage 2 (auditor + criterion contract + hard caps) designed
separately.

- **Declared blackboard roles.** `roleNamesBySessionID` now returns
  `{session[0]: 'planner', sessions[1..N]: 'worker-<N>'}` for
  `pattern='blackboard'`. Visible in roster chips, board chips,
  tokens drill-down. NEW helper `opencodeAgentForSession` keeps
  dispatch routing scoped to hierarchical patterns only — blackboard
  roles are DISPLAY-ONLY so users aren't forced to add synthetic
  `planner` / `worker-<N>` agents to their opencode.json.
- **`expectedFiles[]` on BoardItem.** New `expected_files_json`
  column (idempotent migration); `BoardItem.expectedFiles?: string[]`
  field. Planner emits via a `[files:<path>[,<path>]]` prefix capped
  at 2 paths per todo (smaller = smaller CAS contention surface).
  Third tag in the family alongside `[verify]` and `[role:X]`;
  composes with both in spec order.
- **Planner prompt updated** with the `[files:...]` instruction block
  directly above the `[verify]` instruction. Old todos (no prefix)
  remain valid — empty expectedFiles preserves pre-Stage-1 behavior
  (no CAS protection, worker unconstrained).
- **Work prompt now scopes worker to expectedFiles** when declared.
  Adds "DO NOT edit files outside this list" section with the
  per-todo file scope so workers know the contract. Soft instruction
  today; hard CAS-drift rejection at commit makes it effectively
  binding.
- **Claim-time hash anchoring.** Coordinator reads + SHAs each
  `expectedFile` BEFORE transitioning `open → claimed`; stores
  `(path, sha)` pairs in `fileHashes`. Empty-sha sentinel marks
  files absent at claim (worker expected to create them). Todos
  without expectedFiles get `fileHashes: null` as before.
- **Commit-time CAS drift rejection.** Before the critic gate, re-
  hash every expectedFile; if any file's current hash differs from
  claim-time AND the file is NOT in this worker's edited paths,
  the commit is rejected as stale with `[cas-drift:<path>]` note.
  Self-edits (file in editedPaths) pass through — own hash changes
  are expected. Matches ollama-swarm spec's "1. Re-hash claimed
  files → reject if any changed" commit-gate step.
- **Smoke tests.** `scripts/_stage1_smoke.mjs` — 20 assertions over
  role declaration + opencodeAgentForSession + pure drift logic.
  `scripts/_parser_smoke.mjs` extended with `stripFilesTag` cases
  (+9 assertions, 25 total). All four smokes green end-to-end.

**Stage 2 (designed, not started):** Auditor role + Criterion contract
+ hard-cap enforcement (wall-clock / 200 commits / 300 todos). Design
conversation needed before code — decisions pending on contract
shape, audit cadence default, termination precedence.

### 2026-04-24 — team-picker → dispatch wiring

Made the team picker actually pin per-session models. Prior state: the
new-run-modal picker set `teamSize` but the selected models were
cosmetic — opencode used its default agent per session. Now every
session index carries its own `model` through the dispatch path.

- **`SwarmRunRequest.teamModels?: string[]`** — per-session model list,
  length === resolved teamSize. Validator enforces length; unset keeps
  current default-agent behavior.
- **`SwarmRunMeta.teamModels?: string[]`** — persisted survivor-remap.
  Partial spawn failures reindex to surviving slots before persist, so
  `meta.teamModels[j]` is always the model for `meta.sessionIDs[j]`.
- **`postSessionMessageServer({ model? })`** — gains a `model` opt
  passed as `body.model` on opencode's `/prompt_async`. When agent
  AND model are both set, opencode's agent-config takes precedence.
- **Blackboard fully wired:** `coordinator.ts::tickCoordinator` looks
  up `meta.teamModels[sessionIDs.indexOf(sessionID)]` on every worker
  dispatch. `planner.ts::runPlannerSweep` passes `meta.teamModels[0]`
  on the planner prompt; pinned model overrides the default
  `agent: 'plan'` override so "this run runs on ollama" actually
  sticks through the planner too.
- **Route directive broadcast wired:** the broadcast-directive path
  in `app/api/swarm/run/route.ts` (council / map-reduce /
  deliberate-execute) carries `teamModels[s.idx]` into each
  session's first directive.
- **new-run-modal flattens teamCounts → teamModels** via deterministic
  catalog-order iteration — counts expand to per-slot model IDs.
- **Known limitation (follow-up).** Non-ticker orchestrators' follow-up
  rounds don't yet consume `meta.teamModels`: council Rounds 2/3,
  critic-loop iterations, debate rounds, orchestrator-worker intros,
  role-differentiated post-intro dispatch. Each is a mechanical one-
  line addition (`model: meta.teamModels?.[i]` on the
  `postSessionMessageServer` call). Tracked; not blocking blackboard
  testing.
- **Smoke test:** `scripts/_team_models_smoke.mjs` — 11 assertions
  over the flatten logic + survivor remap + catalog roundtrip. Green.

### 2026-04-24 — ollama tier (three-tier reversal)

Stance reversal. `zen + go only` → `zen + go + ollama`. Motivated by
cost: opencode-go usage ceilings cap below sustained runs' needs, and
opencode-zen pay-per-token is affordable but not subscription-cheap;
ollama-max's monthly-flat shape is strictly better for hours-long
autonomous runs.

- **`Provider` union extended** to include `'ollama'`. `providerOf()`
  in `lib/opencode/transform.ts` buckets any `providerID` containing
  `ollama` into the new tier.
- **5 ollama-max models in catalog** (`lib/model-catalog.ts` +
  `lib/zen-catalog.ts`): `nemotron-3-super:cloud`, `gemma4:31b-cloud`,
  `kimi-k2.6:cloud`, `glm-5.1:cloud`, `mistral-large-3:675b-cloud`.
  All with pricing 0 (subscription-billed) and `limitTag: 'ollama max'`.
- **Pricing lookup precedence.** Ollama pattern (`/ollama[/_-]/`) lands
  first in `LOOKUP` so `ollama/kimi-k2.6:cloud` doesn't accidentally
  hit the zen `kimi-k2-6` row and get charged per-token.
- **UI surfaces extended:** `ProviderBadge`, `ProviderStats`,
  `RoutingModal` (ollama ceiling slider + dispatch-stack row),
  `RoutingBounds` (new `ollamaCeiling` field, defaults to 100 because
  subscription = no runaway). The new-run-modal + spawn-agent-modal
  pickers list the 5 ollama models via `zenModels[]` with
  `family: 'ollama'` (overloaded family marker).
- **Docs cascade:** DESIGN.md §4 + §9 rewritten with history note,
  CLAUDE.md "Never" updated, WHAT_THIS_PROJECT_IS_NOT.md's
  "multi-provider" section rewritten around the three-tier scope,
  README's design-stance bullet + Prerequisites updated,
  docs/ARCHITECTURE.md gains §1.5.0 Provider tiers block.
- **Prerequisite:** user must configure opencode's `opencode.json`
  with a provider block routing `ollama/*:cloud` IDs to ollama. The
  `github.com/kevinkicho/ollama_swarm` sibling repo is the reference
  implementation for the ollama provider shape.

### 2026-04-23 — ambition-ratchet stack + Go routing + validation

One day, large ship run. Grouped by theme.

**Autonomous-long-run layers (SWARM_PATTERNS.md §"Tiered execution"):**

- **Ambition ratchet / tier escalation** — when a blackboard-family run
  drains its board and would auto-idle-stop, the auto-ticker instead
  fires a planner sweep at the next tier (polish → structural →
  capabilities → research → vision; MAX_TIER=5). Stops only when every
  tier returns empty. TickerSnapshot carries `currentTier` /
  `tierExhausted` / `maxTier`.
- **Anti-busywork critic gate** (opt-in via `enableCriticGate: true`) —
  dedicated critic session spawned at run creation; coordinator
  consults it between "turn completed" and `to: 'done'`. Busywork
  verdict → item stale with `[critic-rejected]` note. Fail-open on
  malfunction. **Validated live 2026-04-23:** 2 busywork rejections
  observed with reasons like *"No file edits produced; the fix was
  already attributed to a prior turn"* — real catch, not rubber stamp.
- **Playwright grounding / verifier gate** (opt-in via
  `enableVerifierGate: true` + `workspaceDevUrl`) — dedicated verifier
  session runs `npx playwright` via bash against the target dev server,
  replies `VERIFIED` / `NOT_VERIFIED` / `UNCLEAR`. Planner flags
  UX-outcome todos with a `[verify]` prefix; `latestTodosFrom` strips
  it and sets `requiresVerification` on the board item. Schema
  extended with `requires_verification` column (idempotent migration).
- **Hierarchical pattern set** (retired the "no role hierarchy"
  stance): `orchestrator-worker`, `role-differentiated`,
  `debate-judge`, `critic-loop`, `deliberate-execute`. Each with its
  own kickoff orchestrator in `lib/server/`.

**Session / process safety:**

- **Non-ticker pattern session cleanup** — council / map-reduce /
  debate-judge / critic-loop orchestrators now wrap their kickoff
  body in a try/finally that calls `finalizeRun(swarmRunID, ctx)`
  (shared helper in `lib/server/finalize-run.ts`). Aborts every
  session on run end, including exception paths. Closes the
  session-leak story across all 9 patterns.

- **`zen-rate-limit` vs `opencode-frozen` distinction.** The
  liveness watchdog now probes the opencode log for recent
  `statusCode":429` entries before declaring a freeze. If found
  → `stopReason: 'zen-rate-limit'` with retry-after logged.
  Otherwise → `stopReason: 'opencode-frozen'` as before. Helper
  in `lib/server/zen-rate-limit-probe.ts`, respects
  `OPENCODE_LOG_DIR` env for non-default log locations.

- **Retry-after countdown chip.** New `RetryAfterChip` in
  `swarm-topbar.tsx` renders next to the tier chip when a run is
  stopped with `stopReason: 'zen-rate-limit'` and a parseable
  retry-after was captured. Ticks once per second showing the
  remaining window (`retry 3h 47m` → `retry 3h 46m` → …) and
  self-terminates once the window elapses. Server-side:
  `TickerState.retryAfterEndsAtMs` set by the watchdog when it
  detects a Zen 429; surfaced on both server + client
  `TickerSnapshot`.

- **Partial SSE-merge in `useLiveSwarmRunMessages`.** When an SSE
  event carries the full `message.part.updated` or `message.updated`
  payload, the hook splices it directly into the local message
  buffer in O(1) instead of triggering a full session-history
  refetch. Falls back to refetch (with the existing 2 s cooldown
  throttle) only when the event doesn't carry enough data or the
  target message isn't yet in the buffer. The cost of an active
  run's stream drops from O(N × total_messages) per interval to
  O(N) — the dominant cost that made the run view slow on busy
  runs. The initial hydrate is still a parallel `Promise.all` of
  full fetches; that's the remaining first-paint cost.

- **Liveness decay when backend vanishes.** New
  `useBackendStale()` hook (in `lib/opencode/live.ts`) wraps
  `useOpencodeHealth` with a 2-consecutive-offline debounce.
  Consumed by `SwarmTopbar` (RunAnchorChip + TierChip fade to
  opacity-50 + grayscale with a "status shown is pre-disconnect
  cache" tooltip) and `SwarmTimeline` (lane status circles drop
  their animation + switch to a neutral fog dot). Fixes the
  "offline badge says offline but blinking circle still blinks"
  mixed-signal problem we saw after dev shutdown.

- **Periodic-mode tier escalation** — `runPeriodicSweep` now tracks
  `consecutiveDrainedSweeps`. When ≥ 2 consecutive sweeps produce
  zero new work AND the board has zero active items (open +
  claimed + in-progress), fires `attemptTierEscalation`. Default
  20-min sweep cadence means ~40 min of drained quiet before the
  ratchet climbs. Resets on any sweep that seeds work or leaves
  active board items.

- **Ambition-ratchet tier state persists.** `attemptTierEscalation`
  writes `currentTier` to `SwarmRunMeta` via a new `updateRunMeta`
  helper; `ensureSlots` reads it back on the first fanout of a
  fresh ticker lifecycle. A ticker restart mid-run now resumes at
  the persisted tier instead of dropping back to 1. Fire-and-forget
  write — a failed persist doesn't stall the ticker; next bump
  overwrites.

- **Demo-log retention now runs on dev boot.** New module
  `lib/server/demo-log-retention.ts::pruneDemoLog()` walks `demo-log/`,
  gzips large `events.ndjson` / `board-events.ndjson` files
  (≥ 64 KB), and — *only when `DEMO_LOG_AUTO_DELETE=1` env is set* —
  rm-rf's run directories older than `DEMO_LOG_RETENTION_DAYS`
  (default 30). Called from auto-ticker's startup pass alongside
  orphan-session cleanup. Compression is always on and
  non-destructive; deletion stays opt-in. Manual
  `scripts/prune_demo_log.mjs` still works for ad-hoc runs.

- **Per-pattern zombie threshold.** `coordinator.ts` now reads
  `meta.pattern` and picks from `ZOMBIE_TURN_THRESHOLDS_MS`: 10 min
  default for blackboard / orchestrator-worker / role-differentiated;
  15 min for deliberate-execute (synthesis phase legitimately takes
  longer). Easy to tune further as real-run data accumulates.

- **Per-pattern turn-timeout.** Same treatment as the zombie
  threshold but on the `waitForSessionIdle` deadline: `TURN_TIMEOUTS_MS`
  map + `turnTimeoutFor(pattern)` helper. `deliberate-execute` gets
  15 min; the rest default to 10 min. Matches the zombie boundary so
  the picker doesn't clip legitimately long turns.

- **Per-todo `preferredRole` soft routing for role-differentiated.**
  Board items gained an optional `preferredRole` field (DB migration
  `preferred_role TEXT` column). Planner parses a `[role:<name>]`
  prefix on todowrite content (symmetric to the `[verify]` prefix)
  and sets the field. Coordinator picker adds role affinity as a
  primary sort key: matching session×item pairs win over heat/age,
  neutrals (no role or no preferredRole) stay in the existing sort,
  mismatches are de-prioritized but still claimable — soft bias, not
  hard routing. Role-differentiated kickoff now persists resolved
  `teamRoles` to meta so `roleNamesBySessionID` sees them even when
  the request omitted them. Planner prompt extended with role-tag
  instructions when `meta.pattern === 'role-differentiated'`.

- **Run chaining / continuity (`continuationOf`).** New optional
  field on `SwarmRunRequest` + `SwarmRunMeta`. When set, the new run
  inherits the prior run's workspace + source + `currentTier`, so
  commits keep landing on the same checkout and the ambition ratchet
  resumes at the prior tier instead of resetting to 1. Validation
  rejects a workspace mismatch (silent-fork prevention). Directive,
  pattern, teamSize, bounds, and roles stay per-run. Unlocks the
  "unleash a swarm on this repo for a week, bouncing through patterns
  as needed" usage. `runPlannerSweep` now reads `meta.currentTier` as
  a fallback when `opts.escalationTier` is unset, so continuation
  runs get tier-appropriate planning on their first sweep without
  touching every kickoff call site.

- **Opt-in opencode auto-restart** on `stopReason: 'opencode-frozen'`.
  New `OPENCODE_RESTART_CMD` env var; when set, the frozen watchdog
  spawns it via `child_process.spawn({ shell, detached, stdio:
  'ignore' })` so the user's launcher (PowerShell, systemd, Docker
  restart) brings opencode back without human intervention. Module-
  level 10-min debounce prevents restart hammering on still-broken
  opencode. Zero-config behavior unchanged — ticker stays stopped
  when the env var is unset. `lib/server/opencode-restart.ts`.

- **Cross-run comparison surface** at `/projects/[slug]`. Repo-leaf
  slug lands on a page that lists every run targeting the workspace,
  grouped into continuation chains built from `continuationOf`
  pointers. Per-run row: pattern, status, tier (with `↗` marker for
  inherited runs), duration, tokens, cost, age. Chain header
  aggregates total tokens/cost/duration so "this lineage burned $X
  over Y hours" is visible at a glance. Existing `/projects` matrix
  rows now link through. `app/projects/[slug]/page.tsx` +
  `components/repo-runs-view.tsx`.

- **Validation runbook** at `docs/VALIDATION.md`. Consolidates every
  validation-debt item (Playwright gate, pattern benchmark, tier
  escalation, non-ticker patterns, overnight safety) with setup /
  invocation / pass-fail signals so a real-run pass can execute
  without re-deriving the plan each time. Plus `scripts/_parser_smoke.mjs`
  — 16 assertions over `stripVerifyTag` / `stripRoleTag`, run with
  `npx tsx scripts/_parser_smoke.mjs`, exits 0 on pass.

- **Auto-abort on worker-timeout.** When `tickCoordinator`'s
  `waitForSessionIdle` returns `{ ok: false, reason: 'timeout' }`, the
  coordinator now calls `abortSessionServer` immediately instead of
  leaving the turn in flight for the zombie-picker to catch ≥ 10 min
  later. `'errored'` path skips the abort — opencode already produced
  a terminal signal. Fire-and-forget, same pattern as the zombie
  auto-abort. Saves up to 10 min of dead token consumption per
  timeout.

- **Auto-abort on every stop path** — `stopAutoTicker` aborts all
  session turns (workers + critic + verifier) on auto-idle,
  tier-exhausted, opencode-frozen, and manual stop.
- **Shutdown hook awaits aborts** — SIGTERM/SIGINT/beforeExit run an
  async shutdown that clears timers, awaits all abort HTTP calls
  (5s cap), then `process.exit`. Closes the fire-and-forget race.
- **Startup auto-cleanup** — on first module load the auto-ticker
  iterates recent runs (< 48h) and aborts any still-in-flight turns.
  Covers SIGKILL / crash / reboot gaps.
- **Zombie auto-abort** in the coordinator picker (10-min threshold)
  catches hanging assistant turns.
- **HMR-resilient exports** on `coordinator.ts` / `planner.ts` /
  `auto-ticker.ts` via globalThis stashes — edits take effect on live
  tickers without restart.

**Billing / routing:**

- **`opencode-go/<id>` prefix** is the right default for paid runs —
  routes through Go subscription first, falls through to Zen per the
  user's opencode settings toggle. `opencode/<id>` (bare) goes
  straight to Zen pay-per-use. Distinction cost us ~$2 in Zen credit
  before we figured it out; captured in
  `memory/feedback_zen_model_preference.md`.
- **Per-agent model override** via opencode.json `agent.plan.model`;
  our planner code posts with `agent: 'plan'`. Lets a single config
  run planner on smart paid model + workers on cheap/free.
- **Opencode silent-freeze diagnosis** traced to Zen free-tier 429s,
  not process wedging. `memory/reference_opencode_freeze.md`
  documents diagnosis path + recovery via retry-stale.

**Endpoints:**

- `GET /api/swarm/run/:id/tokens` — per-session + aggregate
  token/cost breakdown; role-labeled for hierarchical patterns.
- `POST /api/swarm/run/:id/board/retry-stale` — bulk reopen of
  stale items; auto-restarts the ticker for ticker-driven patterns.

**UI:**

- **Tier indicator chip** in the run topbar (`tier 3/5 · capabilities`
  live as the ratchet climbs).
- **Topbar de-mocked** — bundle-cost fallback via `derivedCost` so
  big-pickle runs show real $ estimates; fake `goTier` 5h chip
  removed; fake `StatsStream` popover removed from BudgetChip + roster.
- **Pattern-specific affordances**: `JudgeVerdictStrip` (debate-judge),
  `CriticVerdictStrip` (critic-loop), `OrchestratorActionsStrip`
  (orchestrator-worker nudges), phase-aware empty-state + deliberation
  round counter (deliberate-execute), bundle banner on cost-dashboard,
  per-row bundle chip on cost-dashboard.
- **Roster role labels** — coordinator tags worker prompts with
  `agent={role}` so hierarchical runs show role names, not "build."
- **Topbar simplified** — removed `LiveSessionPicker` + duplicate
  `SwarmRunsPicker`. Topbar is run title + anchor chip + tier chip +
  abort chip, nothing duplicated.
- **Timeline scroll fixes** — two-phase rAF snap on fresh load
  (reliable default-to-bottom), 48 px tight stick-threshold,
  56 px padding so the "latest" button no longer overlays the last
  row.
- **Browser `ChunkLoadError` auto-reload** with a brief overlay.

**Tooling + scripts:**

- `scripts/_pattern_benchmark.mjs` — runs coordinator-backed patterns
  sequentially on the same workspace, reports tokens/cost/commits/
  critic-rejections/verifier-rejections per pattern.
- `scripts/prune_demo_log.mjs` — dry-run-by-default pruner; gzips
  ≥ 64 KB events.ndjson; `--delete --days N` removes old run dirs.
- `scripts/_hierarchical_smoke.mjs` — pattern smoke skeleton.

**Tertiary plumbing:**

- SSE shaping (`lib/server/sse-shaping.ts`) — strips redundant diff
  patches, coalesces part.updated at 250 ms, dedupes replay. ~50 %
  byte reduction on real runs.
- Planner prompt rewrite — mission-anchored, auto-embeds README (32 KB
  cap), anti-pattern list bans passive verifications. Todo count
  6-15 with a mix of sizes.
- `useLiveSwarmRunMessages` refetch throttle — 2 s cooldown +
  trailing refresh, cuts server fan-in ~10× on busy runs. (Deeper
  partial-SSE-merge fix tracked below.)

### Earlier (see `git log` for specifics)

- **Blackboard parallelism fix** (2026-04-22) — per-session tick
  fan-out; fixed 1-of-N sessions claiming all work.
- **Council auto-rounds** (2026-04-22) — rounds 2/3 fire server-side.
- **Map-reduce v2** — synthesis as a board-claimed `synthesize` todo.
- **Stigmergy v0 + v1** — per-file edit heat observation + picker
  weighting in `tickCoordinator`.
- **Opencode port isolation** — `:4097` with separate `XDG_DATA_HOME`
  so this app's session list doesn't mix with the ollama-swarm sibling.

---

## Known limitations — things that work but have sharp edges

### Orchestration / runtime

- **HMR covers only 3 server modules** (`coordinator.ts`,
  `planner.ts`, `auto-ticker.ts`). Edits to other `lib/server/`
  files need a dev-server bounce to take effect on live tickers.
  Low priority — those files change rarely.

- **Silent-freeze is now auto-distinguished.** The liveness watchdog
  probes the opencode log for a recent `statusCode":429` before
  declaring a freeze. If found → `stopReason: zen-rate-limit`
  (with retry-after logged). Otherwise → `stopReason:
  opencode-frozen`. UI-side polish (chip showing the retry-after
  countdown) still queued below.

### Pattern reliability under GEMMA defaults (2026-04-25 validation)

Empirical findings from the 8-pattern × 60-min validation run. The
governing structural property: **patterns where work concentrates in
one critical session crash on a single silent turn; patterns where
work is parallel-redundant survive**.

**Pattern reliability tiers:**

- **Robust** — `blackboard`, `council`, `role-differentiated`
  (post-fix). Distributed work, no single point of failure. Use
  these for important runs.
- **Fragile** — `orchestrator-worker` (orchestrator critical),
  `critic-loop` (2 sessions sequential), `debate-judge` (judge
  critical). Reach partial completion (~8-12 done items) before
  F1 declares opencode-frozen.
- **Asymmetric fragility** — `map-reduce` MAP phase robust,
  REDUCE phase brittle (synthesizer reading ~30K tokens of N
  mapper drafts produces silent turns under GEMMA reliably).
- **Uniquely broken** — `deliberate-execute` reproducibly silent
  on initial deliberation directive (both fresh and replay
  spawns). Investigation queued (#66).

**Specific failure modes observed:**

1. **F1 silent-turn aborts iterative loops mid-flow.** When an
   orchestrator/critic/judge hits a silent turn, the
   `waitForSessionIdle` returns reason='silent', loop aborts,
   no recovery. Fix queued as #73 (silent-turn cascade hardening).
2. **map-reduce REDUCE single-synthesizer bottleneck.** Synth
   item bounces forever. Workaround queued as #72 (pin synth to
   stronger model).
3. **opencode silently drops POSTs with `agent` param outside
   built-ins** (build/compaction/explore/general/plan/summary/title).
   Returns HTTP 204 but never persists. 4 patterns silently broken
   for unknown duration before fix on 2026-04-25 (commits 0c79175 +
   23a21f7). See `docs/POSTMORTEMS/2026-04-25-agent-name-silent-drop.md`
   when written (#69).

Pattern reliability is captured in `memory/reference_pattern_reliability_ranking.md`
for cross-session use. When picking a pattern for a real run, prefer
the robust tier unless the work specifically benefits from a fragile
shape (debate divergence, critic iteration).

### UI performance

- **Live run view — initial hydration cost on very big runs** (not
  related to SSE now). Partial SSE-merge shipped — `useLiveSwarm-
  RunMessages` now splices `message.part.updated` / `message.updated`
  payloads locally in O(1) instead of full-history refetch. That
  was the dominant cost during active runs. The remaining load
  cost is the initial `Promise.all` of N parallel full-history
  fetches on first mount; still worst-case for a brand-new tab
  opening a run with 100s of messages per session. Mitigations:
  stagger the initial hydrate (first session's data renders before
  the Nth's lands), or range-limit the initial fetch to the last
  K messages (full history on scroll up). Not urgent now.


---

## Queued — designed but not started

### Closed since this section was last revised (audit 2026-04-25)

The audit found six items in this list that had silently shipped without
the doc catching up. Removed from the "Next-up" block below; recording
here so anyone re-reading old context knows what landed:

- Lane meter `out — in —` fallback → SHIPPED (transform.ts emits
  `tokensIn` / `tokensOut`; swarm-timeline.tsx LaneMeter falls back to
  `compact(tokensOut)` when both rates are zero)
- `latest ↓` 4-phase synchronous snap → SHIPPED (`scroll-to-bottom.tsx`
  uses sync + rAF + 120 ms + 400 ms passes)
- Auto-ticker startup-cleanup recent-activity guard → SHIPPED
  (`STARTUP_CLEANUP_RECENT_ACTIVITY_MS` skip + `skippedAlive` log)
- board/ticker `stopReason` SQLite persistence → SHIPPED as
  PATTERN_DESIGN/blackboard.md I3 (`persistTickerSnapshot` /
  `readTickerSnapshot`)
- Tokens endpoint `lastActivityTs` zombie-threshold guard → SHIPPED
  (`deriveSessionStatus` user-trailing branch checks
  `ZOMBIE_THRESHOLD_MS`)
- `item.note` retry chip on board rows → SHIPPED (board-rail.tsx
  surfaces `retried Nx` chip with note tooltip)

Pattern-design ledgers (PATTERN_DESIGN/*.md) for the per-pattern tabs +
mechanics gaps are also nearly fully closed: only map-reduce I1
(synthesis-critic gate), role-differentiated I4 (per-role token
budgets), and stigmergy heat-picked-timeline-chip remain PROPOSED — all
need a live run to validate before shipping.

### Next-up (high leverage, < 1 day each)

- **Cold-load 30s+ delay on first navigation in dev (artifact, not
  bug).** Next.js compiles each route + each lazy modal chunk on the
  first request, serially. Measured 27s per modal chunk, ~38s
  user-perceived "first populated data" in dev (perf:cold benchmark
  2026-04-24). NOT a real performance problem — `npm run prod`
  serves all pre-compiled chunks in <1s. Documented for future-me
  who'll wonder why dev feels slow.

- **30-minute project review checklist** (`docs/REVIEW_CHECKLIST.md`)
  — structured walkthrough of every major surface in 7 phases. Run
  this whenever bugs feel like they're piling up; capture findings
  as new entries here. First run not yet completed.

- **Dev wrapper SIGTERM 143 → SHIPPED 2026-04-25.** The
  `npm run dev` wrapper would survive after next-server died,
  hanging in the task tracker. Root cause: dev.mjs's signal
  handlers called `killGroup(signal)` but never scheduled an
  exit fallback — if `killGroup` failed, throws, or the child was
  already dead before our SIGCHLD landed, `child.on('exit')` would
  never fire and dev.mjs would wait forever. Fix: shutdown handler
  now schedules a 5s force-exit timeout (.unref() so it doesn't
  block clean shutdowns); double-signal protected via
  `shutdownInFlight` flag.

- **Heat tab: file-tree toggle (VSCode-style).** Button in the heat-rail
  header flips between the current heat-list view and a tree view of
  the workspace files. Files in the tree show heat chips (edit counts)
  so the value add over the list is "navigate by structure instead of
  by heat score." Click a file → same file-heat inspector opens. Shape
  A from the 2026-04-24 design exchange. Needs `GET /api/swarm/run/:id/tree`
  (or a workspace-scoped variant) for the filesystem enumeration,
  gitignore-aware, short cache. ~2-3 h scope.

- **Run-health surfacing (2026-04-24 audit) — 4 of 5 sub-items shipped.**
  Audit found 5 places the app masked opencode signals. The ones
  shipped are listed in the "Closed since this section was last
  revised" block above (lastActivityTs zombie-threshold guard,
  persistTickerSnapshot, item.note retry chip, deriveSilentSessions).
  All 5 sub-items are now closed:
  - **Retry-exhausted → ticker stalls without re-kick** → SHIPPED
    (audit 2026-04-25). Coordinator picker now filters
    `[retry:N≥MAX_STALE_RETRIES]` opens out of the candidate queue —
    matches the predicate the periodic-sweep path (auto-ticker.ts
    ~L1252) already uses for the ambition-ratchet drained-board
    check. Before this fix the standard auto-idle path saw twice-
    refused items as active work and the ratchet stayed dormant
    indefinitely (run_mob31bx6_jzdfs2 stranded at 22.33M).

- **Nemotron-through-opencode → GEMMA across all 6 default seats.**
  Two retests 2026-04-25 with `--log-level DEBUG` reproduced a
  step-loop cost behaviour that affects every nemotron seat in
  opencode's wrapper:
  1. **run_modx3mv5_cpwh93** (orchestrator-worker): 18 turns in
     200s, each calling `todowrite` and re-emitting the same 10
     items, board never seeded.
  2. **run_modxga1j_kh4j8k** (council, 3 nemotron drafters): real
     output produced (drafts were good) but in 20+ tiny step-finish
     turns per session, each re-reading 47K input tokens to emit
     ~150 output tokens — **~50× more expensive than necessary**
     for a 3-sentence directive.
  Same root cause: opencode's wrapper handling of step-tool-step
  loops on nemotron specifically. Direct ollama `/api/generate` +
  `/v1/chat/completions` work normally for the same model.
  Swapped NEMOTRON → GEMMA in `patternDefaults` for orchestrator-
  worker, council, map-reduce, role-differentiated, debate-judge,
  and deliberate-execute. The `auditorModel: NEMOTRON` on the
  blackboard pattern's optional auditor gate is left — non-default,
  user-opted-in, distinct role from drafting/planning seats.

### Designed but deprioritized

- **Route C "writers-room"** (memory/project_a2a_routes.md). Deferred
  with B/D; Route A covers current needs.

---

## Validation debt

Things we shipped but haven't exercised against real runs. See
`docs/VALIDATION.md` for the per-item runbook (setup / invocation /
pass-fail signals).

**Audit 2026-04-25 partial coverage:**
- Council pattern partially exercised in run_modxga1j_kh4j8k
  during the nemotron retest above — drafts produced correctly,
  per-member content scaled to teamSize=3. Cost was the bottleneck,
  not correctness. After the GEMMA swap a fresh council run
  should validate at <10× the prior cost; not yet re-run.
- Other validation areas (Playwright grounding, pattern benchmark,
  ambition-ratchet tier-2+, overnight-safety stack) all need
  dedicated runs that cost real money. Each is documented in
  VALIDATION.md with the exact curl invocation; ready to fire
  when someone wants to spend the budget.

- **Playwright grounding (`enableVerifierGate: true`)** — schema + code
  wired, never exercised live. Blocked on: user running the target
  repo's dev server + passing `workspaceDevUrl` on a test run. Needs
  observation of whether the planner actually uses the `[verify]`
  prefix appropriately and whether the verifier composes usable
  Playwright scripts.

- **Pattern benchmark script** — `scripts/_pattern_benchmark.mjs`
  works (syntax-checked); never invoked. ~$12 / ~1 h wall-clock for
  the default 3-pattern run.

- **Ambition-ratchet tier escalation** — tier-2 and beyond have never
  fired in anger. Today's runs stopped at tier 1 before the board
  fully drained. Needs a run that either drains naturally or has a
  short directive.

- **Non-ticker patterns (council / map-reduce / debate-judge /
  critic-loop)** — type-checked, but nobody's load-tested them on a
  real repo. Combined with the session-leak gap above.

- **Overnight-safety stack end-to-end.** 2026-04-23 runs reached
  89 % completion across 6 sessions before a Zen quota cliff.
  Zombie-abort validated (9 `[retry:N]` notes fired). What's
  missing: a full 8 h run that *doesn't* hit the quota wall at
  ~35 min, so we can see behavior across the full duration.

---

## How to use this file

**Adding:** shipped → under the current date heading; in-progress /
blocking → "Known limitations"; designed-not-built → "Queued" with
effort estimate.

**Removing:** shipped from Queued → move to Shipped; limitation fixed
→ delete (commit has the record); abandoned → move justification to
`WHAT_THIS_PROJECT_IS_NOT.md` and delete here.

**When in doubt:** durable advice → 5 durable docs. Time-scoped
("right now we have X") → here.
