# 2026-04-26 · critic-loop runaway-token leak (waitForSessionIdle deadline-no-abort)

**Run:** `run_mof0de0o_z31ohi`
**Pattern:** critic-loop (2 sessions: 1 worker + 1 critic, hard-locked)
**Models:** worker=`gemma4:31b-cloud` (ollama), critic=`glm-5.1:cloud` (ollama)
**Workspace:** `/mnt/c/Users/kevin/Desktop/opencode_enhanced_ui`
**Directive:** stress-test uniform — "Investigate the codebase and ship one small, concrete improvement. Read a few files to orient. Be thoughtful about scope."
**Outcome:** Worker turn ran for 30+ minutes producing tokens but never completing. ~955K tokens burned, 0 done items. Run still showed `status: live` at user-stop. Captured as part of `MAXTEAM-2026-04-26` (`docs/STRESS_TESTS/2026-04-26-max-team-size-8.md`).

---

## 1 · Observed failure

From the stress test:

```
critic-loop teamSize=2 → 955K tokens / 0 done / status=live at test stop
- Worker turn ran for 30+ minutes producing tokens but never completing
- F1 silent-watchdog wouldn't fire (worker IS emitting parts)
- Per-iteration ITERATION_WAIT_MS (15min) should have but didn't
```

The critic-loop orchestrator (`lib/server/critic-loop.ts`) sets a 15-minute
`workerDeadline = Date.now() + ITERATION_WAIT_MS` and calls
`waitForSessionIdle(workerSID, …, workerDeadline)`. After 15 minutes the
helper returns `{ ok: false, reason: 'timeout' }` and the orchestrator
records a partial outcome and exits the loop.

That's correct from the orchestrator's POV. But the *opencode session*
itself is left alive. The model continued producing tokens until the user
manually stopped the run at T+31m.

## 2 · Diagnosis (verified vs. speculation)

### Verified facts

- F1 silent watchdog (`waitForSessionIdle` lines 707-721 of pre-fix
  `coordinator.ts`) only fires when `totalParts !== lastTotalParts`
  STAYS UNCHANGED for `SILENT_ERROR_MS` (240s). The runaway worker was
  emitting parts the whole time, so silence never crossed threshold.
- Tool-loop detector requires *consecutive identical* tool errors
  (`TOOL_LOOP_THRESHOLD = 10`). The worker wasn't tool-looping; it was
  just emitting many small text parts.
- Provider-unavailable probe only fires once silence already crossed
  `PROBE_AFTER_MS=30s`. Same gating issue as silent watchdog.
- Deadline-expiry path (`while (Date.now() < deadline)` exit, line 810
  pre-fix) returned `{ ok: false, reason: 'timeout' }` **without
  calling `abortSessionServer`**. Every other watchdog branch (silent,
  tool-loop, provider-unavailable) explicitly aborts the session before
  returning. The plain timeout branch did not.

### Net effect

The orchestrator's 15-minute cap stopped the orchestrator from waiting
further, but did nothing about the worker's still-active turn in opencode.
opencode has no per-turn wall-clock cap of its own (turn duration is bound
by token budget, not time), so the abandoned turn kept producing tokens
indefinitely. Visible in dev logs as a session whose `tokensTotal` kept
climbing while the run's coordinator had no remaining outstanding waits.

### Speculation (not directly verified)

- The same leak likely affects every other pattern that uses
  `waitForSessionIdle` with a deadline (planner sweep, blackboard worker
  dispatch, council/debate-judge/role-differentiated/orchestrator-worker
  sub-waits). Critic-loop just made it most visible because its outer
  loop has no per-iteration retry/escalation that would have cancelled
  the session anyway.

## 3 · Fixes

### F1 — abort the session on deadline expiry when a turn is still in-progress

**File:** `lib/server/blackboard/coordinator.ts`
**Function:** `waitForSessionIdle`
**Change shipped:** `209cbf1` follow-up commit (this fix's commit).

Track an in-progress flag inside the poll loop:

```ts
let lastSeenInProgress = false;
while (Date.now() < deadline) {
  // …
  if (newAssistants.length === 0) { lastSeenInProgress = false; continue; }
  // …
  if (newAssistants.some((m) => !m.info.time.completed)) {
    lastSeenInProgress = true;
    continue;
  }
  // all completed
  lastSeenInProgress = false;
  // quiet-window check…
}
// deadline expired
if (lastSeenInProgress) {
  console.error(`[coordinator] session ${sessionID} timeout with in-progress turn — aborting (task #100)`);
  try { await abortSessionServer(sessionID, workspace); } catch { /* non-fatal */ }
}
return { ok: false, reason: 'timeout' };
```

Doesn't abort when the last poll saw all turns completed (those are just
stuck on the `SESSION_IDLE_QUIET_MS` quiet-window buffer; the session is
already idle and aborting would be theater).

## 4 · Validation

### F1 validation procedure

**Probe — production:** Reproduce a long-emitting turn that exceeds
`ITERATION_WAIT_MS`. Easiest reproducer is a critic-loop run with a
prompt that pushes the worker to write thousands of tokens of plan-then-
execute output (the empirical pattern from `run_mof0de0o_z31ohi`).

After T = ITERATION_WAIT_MS + a few seconds, check:

1. **Dev log line present:**
   `[coordinator] session ses_<id> timeout with in-progress turn — aborting (task #100)`
2. **Session token counter stops climbing.** Poll
   `/api/swarm/run/:id/snapshot` and look at `tokensTotal` for the run.
   Should plateau within ~30 s of the abort log line. Pre-fix, it
   would keep climbing for many more minutes.
3. **opencode session abort visible:** `GET /session/:id/message` on
   the worker session — the in-progress assistant message should now
   carry an `info.error` (post-abort), not still-streaming parts.

**Probe — synthetic (faster):** A unit test with a mocked
`getSessionMessagesServer` that returns an in-progress message
indefinitely should:

1. Drive `waitForSessionIdle` with a tiny deadline (e.g. 100ms).
2. Assert that `abortSessionServer` is called with the session ID.
3. Assert the return value is `{ ok: false, reason: 'timeout' }`.

Synthetic test is queued — not blocking the fix because the production
probe is sufficient and already-recorded stress-test runs serve as
historical baselines.

## 5 · Ledger

| Fix | Status | Shipped commit | Verified against |
|---|---|---|---|
| F1 abort-on-timeout | **SHIPPED** | (this commit) | pending — re-run a critic-loop stress with a token-heavy directive and check for the new log line |

Re-validation cadence: walk this probe against any future critic-loop
or long-deadline run. Add VERIFIED annotation with run ID + log-line
excerpt when it passes against real data. If a future stress test
shows a long-emitting turn outliving its deadline without the
"aborting (task #100)" line, the fix has REGRESSED — open a new
postmortem entry referencing this one.

## 6 · Knock-on effects

- **All deadline-cleanup callers benefit.** Beyond critic-loop, every
  use of `waitForSessionIdle(..., deadline)` now has the abort
  guarantee: planner sweep timeouts, blackboard worker dispatch
  timeouts, council/debate/orchestrator-worker sub-waits. The
  orchestrators above didn't need code changes — they already returned
  partial-outcome on timeout; now the session-side bleed stops too.
- **Stuck-deliberation detector (#104) becomes more useful.** With the
  bleed fixed, a stuck-deliberation run accumulates tokens *only*
  while orchestrator-side waits are alive, so #104's "high tokens, no
  output" classifier has a cleaner signal.
- **Recommended teamSize ceilings still hold.** This fix limits the
  damage from over-recommended teamSize but doesn't change the
  ceilings themselves — patterns that crashed at the high end did so
  for orthogonal reasons (synthesis-context overflow, planner-prompt
  bloat, etc.).
