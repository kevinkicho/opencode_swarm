# 2026-04-27 — Six-pattern live validation sweep

User asked to "test running other swarm modes one by one and fix one by
one." Ran every available pattern back-to-back via the
`scripts/_record_run.mjs` workflow shipped earlier today. One pattern
(`map-reduce`) surfaced two real bugs, both fixed in the same session;
five others ran clean on first attempt.

## Results

| Pattern              | Run ID                  | Outcome                                     |
|----------------------|-------------------------|---------------------------------------------|
| blackboard           | run_mohye1as_s1l068     | ✅ 10/12 done (validated earlier today)     |
| map-reduce (broken)  | run_mohzmgie_vfdmxw     | ❌ aborted at synthesis-claim — phantom-no-tools rejected the synthesis |
| map-reduce (broken)  | run_mohzsz7c_dtzd4l     | ❌ kickoff failed — circuit breaker too aggressive |
| **map-reduce (fixed)** | **run_mohzzh1i_op1hxa** | **✅ synthesis APPROVED by critic on attempt 1, run finalized clean** |
| council              | run_moi026mo_divib0     | ✅ 3 rounds, 3/3 members each round         |
| orchestrator-worker  | run_moi051p2_qpqejv     | ✅ 5/5 todos done, 5 commits (1 criterion open is expected) |
| critic-loop          | run_moi0bi8b_7twudu     | ✅ APPROVED on iter 1                       |
| debate-judge         | run_moi0f86g_9ggo8i     | ✅ round 1 → MERGE verdict                  |

## Bugs found and fixed

### 1. `phantom-no-tools` guard rejects synthesize items

`lib/server/blackboard/coordinator/dispatch/run-gate-checks.ts` rejects
text-only assistant turns as fake work. Map-reduce inserts a `synthesize`
board item whose canonical output IS a text paragraph — the reducer
reads N drafts and writes a synthesis, no tools needed. The guard
treated this as fake work and marked every map-reduce run stale.

**Fix:** exempt `todo.kind === 'synthesize'` from the guard.

**Test:** new regression in
`lib/server/blackboard/coordinator/__tests__/dispatch.test.ts`:
"does NOT bounce phantom on synthesize items (text IS the output)".

### 2. Circuit breaker too aggressive for parallel patterns

The slow-load fix earlier today set the breaker at 3-failures-in-2s
with an 8s per-call timeout. Live map-reduce showed parallel /message
fetches on large sessions hitting the 8s timeout simultaneously,
registering as 3 hard failures, tripping the breaker, and the
synthesized 503 propagated up as "opencode unreachable" — false alarm.

**Fix:**
- 8s → 20s default timeout (matches the docstring's "10-15s for huge
  sessions" reality)
- 3-fail-in-2s → 6-fail-in-5s threshold (room for 3-session parallel
  fan-outs while still tripping instantly on a real outage where 130+
  parallel calls would all fail)
- Stop counting `AbortError` as a failure — timeouts are our own
  choice, not a network signal. Only `TypeError`-shaped fetch
  rejections (connection-refused / DNS / ECONNRESET) count toward
  the trip threshold.

**Test:** updated breaker tests for new threshold + added "does NOT
trip on AbortError (timeout from our own timer)" case.

## Workflow notes

The `_record_run.mjs` script worked across every pattern with a single
flag-set. Pattern-specific defaults (teamSize=2 pinned for critic-loop,
≥3 for debate-judge) and pattern-specific knobs
(`enableSynthesisCritic`, `criticMaxIterations`, `debateMaxRounds`)
flow through cleanly. One small adjustment shipped during the sweep:
the script now derives teamSize per pattern instead of hard-coding 3,
so critic-loop spawns don't 400.

The fix-and-revalidate loop on map-reduce was tight: ~5 min from
"phantom-no-tools rejected" to "synthesis APPROVED." The recording
artifact wasn't actually used here — the dev-server log was richer
than frame-walking for this kind of pipeline failure. The .webm
becomes more useful for UI-rendering bugs (like yesterday's chat
bubble overflow).

## Ledger

| Finding | Status | Verification |
|---|---|---|
| phantom-no-tools exempts synthesize | SHIPPED | commit 72df147 · run_mohzzh1i_op1hxa synthesis APPROVED · `lib/server/blackboard/coordinator/__tests__/dispatch.test.ts` regression |
| Circuit breaker re-tuned | SHIPPED | commit 72df147 · `lib/opencode/__tests__/circuit-breaker.test.ts` 3 cases including AbortError exclusion |
| map-reduce live | VERIFIED | run_mohzzh1i_op1hxa |
| council live | VERIFIED | run_moi026mo_divib0 |
| orchestrator-worker live | VERIFIED | run_moi051p2_qpqejv |
| critic-loop live | VERIFIED | run_moi0bi8b_7twudu |
| debate-judge live | VERIFIED | run_moi0f86g_9ggo8i |
| recorder script handles all 6 patterns | SHIPPED | commit pending · `scripts/_record_run.mjs` exercised on each |
