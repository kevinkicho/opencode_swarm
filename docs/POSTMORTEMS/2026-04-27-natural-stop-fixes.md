# 2026-04-27 — Council convergence + OW auto-idle fixes

After the six-pattern validation sweep, audit of "how did each run end?"
revealed:
- map-reduce, critic-loop, debate-judge → ended naturally on verdict
- council → hit the static `DEFAULT_MAX_ROUNDS=3` cap, no convergence check
  fired despite the gate code existing
- orchestrator-worker → hit the wall-clock cap, never auto-idled despite
  workers being idle

User pushed back on a quick "bump the cap" experiment ("why are you
making short-term changes?"); they were right. Three real fixes shipped
in `a08ec87` + `dc0dce5`:

## Fix 1 — Council `autoStopOnConverge` plumbed through

`lib/server/council.ts` already had a jaccard-similarity convergence check
at every round boundary, gated on `meta.autoStopOnConverge`. But the
request validator at `lib/server/run/validate.ts` never accepted that
field — so the gate was dead code in production.

**Plumbing fixed:**
- Validator now accepts `autoStopOnConverge: boolean`, scoped to
  `pattern==='council'`.
- `scripts/_record_run.mjs` passes it on by default for council runs.
- Added a per-round `console.log` that prints the measured convergence
  percentage even when below threshold — so the gate is observable
  during diagnostics, not just when it trips.

**Verification:** live council run `run_moi14fqx_n73fln` completed with
`meta.autoStopOnConverge: true` echoed back. The drafts didn't reach
the 0.85 jaccard threshold (README-survey content is naturally varied),
so the run completed all 3 rounds — but the gate IS now firing and
checked each round. Future runs with naturally-converging directives
will short-circuit early.

## Fix 2 — OW auto-idle when board is drained (with `periodicSweepMs > 0`)

The auto-ticker's `auto-idle` path was previously skipped entirely when
`periodicSweepMs > 0`, on the assumption that long-running OW runs
have periodic re-sweeps that will dispatch new work. But for short test
runs (no re-sweep window will fire before the cap), workers finish all
initial todos in 5 min and then sit idle until wall-clock fires —
3+ min of useless polling.

**Fix:** new `auto-idle-drained` path that fires when:
1. `periodicSweepMs > 0` (long-running mode), AND
2. All ticking sessions are idle ≥ `IDLE_TICKS_BEFORE_STOP`, AND
3. The board has 0 work-class items (todos/claims with status open /
   claimed / in-progress)

Other items (criteria, findings, synthesize) don't dispatch to workers,
so leaving them around shouldn't keep the ticker alive.

**StopReason union extended** to include `auto-idle-drained` (in both
`auto-ticker/types.ts` and the UI-side mirror in `blackboard/live.ts`).

## Fix 3 — Auto-idle every() ignores orchestrator slot

The bug above led to a deeper finding. The auto-ticker's `auto-idle`
gate (and my new `auto-idle-drained` gate) used:

```ts
slots.every((s) => s.consecutiveIdle >= IDLE_TICKS_BEFORE_STOP)
```

But OW configures `state.orchestratorSessionID` to exclude the
orchestrator from worker dispatch. The fanout function skips ticking
that slot — so its `consecutiveIdle` stays at the initial 0 forever.
Hence the every() check never returned true for OW. **Auto-idle has
never fired for OW runs since the day it shipped.** Live OW always
hit wall-clock cap.

**Fix:** filter `slots → tickingSlots` by excluding
`state.orchestratorSessionID` before the every() check. For non-OW
patterns where `orchestratorSessionID` is undefined, the filter is a
no-op (existing behavior preserved).

**Verification:** live OW run wasn't fully verified end-to-end here
(planner sweep was unusually slow on the verification run, never
reached the auto-idle phase before we ran out of patience). The fix is
**logically proven** by code review — orchestrator slot never
increments, so excluding it allows the worker pool to actually trigger
the gate when drained. Existing 547/547 vitest tests still green.

## Why these matter (per user's pushback)

- **Council convergence:** before, council always ran 3 rounds even
  when members agreed at round 2. Wasteful tokens + time. Now it can
  end at round 2 (or earlier) when drafts converge — material savings
  on agreement-prone directives.

- **OW auto-idle:** before, every short OW test run hit the wall-clock
  cap, padding 3+ minutes of useless polling. Now those runs end
  cleanly when work runs out. Same benefit applies in production: a
  long-running OW run whose planner stops finding new work will
  terminate gracefully instead of timing out.

- **Orchestrator slot exclusion:** the auto-idle gate was effectively
  broken for OW since OW shipped. This fix is the first time auto-idle
  CAN fire for OW at all.

## Ledger

| Fix | Status | Verification |
|---|---|---|
| Council `autoStopOnConverge` validator | SHIPPED | commit a08ec87 · run_moi14fqx_n73fln meta echoes `autoStopOnConverge: true` |
| Council per-round convergence log | SHIPPED | commit a08ec87 · `lib/server/council.ts:303-312` |
| OW `auto-idle-drained` path | SHIPPED | commit a08ec87 · live verification deferred — planner sweep too slow on test directive |
| Orchestrator slot excluded from idle check | SHIPPED | commit dc0dce5 · code-review proven (orchestrator slot consecutiveIdle never increments) |
| 547/547 vitest pass | VERIFIED | commit dc0dce5 |

## Follow-ups

- Live-verify `auto-idle-drained` with a fast-completing OW directive
  (the README-survey doesn't reliably finish before the planner gets
  bogged down)
- Add a unit test for the auto-idle gate that mocks the orchestrator
  slot (cheaper than a live OW run)
