# Postmortem: blackboard planner-sweep error stops run prematurely

**Date:** 2026-05-08  
**Run:** `run_mowhf24a_8h62fc`  
**Pattern:** blackboard  
**Duration:** ~24 min (21:56 → 22:20 UTC)  
**Outcome:** degraded-completion (planner error)  
**Tokens:** 11.8M  
**Cost:** $0.04

---

## Summary

A blackboard run with 4 workers (1× glm-5.1 planner, 3× gemma4:31b workers + nematron auditor) produced 18 completed todos, 5 completed criteria, and 13 findings before the planner's opencode session errored on a sweep. The ticker's `no-claimable-work` stop fired 4 consecutive idle ticks (1 retry-exhausted item excluded) — ending the run with 1 open todo and 5 open criteria still on the board.

The same failure mode hit the earlier run `run_mowg068w_o8q7kf` (first attempt), which aborted on the *first* planner sweep, producing zero work.

---

## Timeline

| Time | Event |
|------|-------|
| 21:56 | Run launched. Team: glm-5.1 planner + 3× gemma4:31b workers |
| 21:57–22:10 | Workers claim and complete 6 first-tier todos (tick.test.ts fixes, consecutiveNoClaimableWork guard, STATUS.md update). Ratchet escalates to tier 2. |
| 22:10–22:17 | Workers complete 7 more todos (batch 2 + 3). Ratchet escalates through tiers 2→5. Auditor verifies 11 criteria. |
| 22:17 | Planner sweep on session `l8JHXleX` errors (reason: error). Board had 19 todos (18 done, 1 open), 16 criteria, 12 findings. |
| 22:17–22:20 | Ticker enters `consecutiveNoClaimableWork` countdown. 4 idle ticks with "1 retry-exhausted excluded". |
| 22:20 | Ticker stops: `stopReason: no-claimable-work`. 1 open todo (`map-reduce-model.test.ts`), 5 open criteria unfulfilled. |

## Root causes

### F1: Planner session error kills sweep, produces no fallback plan

When the planner's opencode session errors (ollama model error, context overflow, or gateway timeout), `runPlannerSweep` catches the error and creates a `finding` item with `degraded-completion blackboard error`, but the board is left with no new proposals. If all remaining open items are already claimed or stale-with-retry-exhausted, the `consecutiveNoClaimableWork` counter increments on each tick and the run stops.

**Impact:** The run had 1 retry-exhausted item and 5 open criteria. With no new planner output, the ticker had nothing to assign and stopped after 4 idle ticks (below the 6-idle-threshold, but `consecutiveNoClaimableWork` has its own counter that starts from the stale-sweep count).

**Severity:** High. This is the same root cause as `run_mowg068w_o8q7kf` (the earlier attempt that produced zero work).

### F2: `consecutiveNoClaimableWork` increments on "no claimable todos" even with open criteria

The idle-outcome `skipped` with reason `"no claimable todos (1 retry-exhausted excluded)"` counts as an idle tick, but there were still 5 open *criteria* that workers could satisfy. The `boardHasWorkInFlight()` guard (added in the 2026-05-07 batch) checks whether items are *in-progress*, not whether *criteria are still open and unclaimed*.

**Impact:** The run stopped with claimable work still on the board. The 5 open criteria would have been satisfiable if workers had been dispatched.

### F3: Error badge popover shows tool name ("bash") instead of error message

When a tool error appears in the roster's attention badge, clicking the badge opens a popover that renders `msg.title` — which for tool parts is just the tool name (e.g. `"bash"`, `"edit"`) from `synthesizeTitle()`. The actual error text lives in `msg.body` or `msg.toolPreview`, which the `AttentionTable` component never renders.

**Impact:** Users see a popover listing "bash" or "edit" with no indication of what went wrong, making the error badge nearly useless for diagnosis.

### F4: Ratchet findings are duplicated (4× per tier escalations)

Each periodic planner sweep re-evaluates the board and re-emits ratchet escalation findings even when the same tier has already been escalated. The board shows 4 identical `[ratchet] Escalated to tier 2` findings, 4 identical tier-3 findings, etc.

**Impact:** Board clutter. Not a run-stopping bug but makes the board state harder to read.

---

## Fixes

| # | Fix | Status |
|---|-----|--------|
| F1 | Planner sweep error should not kill the run — blackboard kickoff now wraps `runPlannerSweep` in try/catch; on error, starts the ticker if salvageable work exists on the board. Periodic sweep catch block now increments `consecutiveNoClaimableWork` instead of resetting to 0, so repeated sweep errors eventually stop the ticker. | **Shipped** |
| F2 | `boardHasWorkInFlight()` now returns true when open/blocked criteria exist (pending auditor verification). This prevents `consecutiveNoClaimableWork` from stopping the ticker while criteria still need judging. | **Shipped** |
| F3 | `AttentionTable` should render `msg.body` or `msg.toolPreview` truncated to 2 lines when `msg.status === 'error'` and `msg.part === 'tool'`. The error message is in `body` (for tool calls, the command that failed) or `msg.toolPreview` (the first line of stderr output). | **Shipped** (in earlier session) |
| F4 | Ratchet findings deduped: before inserting `[ratchet] Escalated to tier N` or `[ratchet] Tier-N sweep error`, checks whether a same-prefix finding already exists on the board. Skips if so. | **Shipped** |

---

## Validation

For each fix, the pass signal:

- **F1:** A blackboard run where the planner's opencode session errors mid-sweep should NOT stop. The ticker should continue with periodic sweeps; the idle counter should increment; the board should retain its previous state intact (no degrade finding).
- **F2:** A run with open criteria and no in-flight todos should NOT stop due to `no-claimable-work`. Workers should pick up criteria verification work.
- **F3:** Clicking the error badge in the roster should show the actual error message (e.g. "exit code 1" or "command not found"), not just the tool name.
- **F4:** A run with multiple ratchet escalations should produce at most 1 finding per tier, not 4.

---

## Artifacts

**Board state at abort (19 todos, 16 criteria, 13 findings):**
- 18 todos completed (tick.ts fixes, test fixes, STATUS.md, map-reduce dispatch deadline)
- 1 todo open with `[retry:1] tool-loop` (map-reduce-model.test.ts)
- 11 criteria done (auditor verified test suites pass)
- 5 criteria open (all requesting `npm test` 0 failures)
- 12 ratchet findings (duplicated across 4 escalations)
- 1 blackboard-error finding (planner sweep error)

**Worker performance:**

| Worker | Model | Tokens In | Tokens Out | Tool Calls | Outcome |
|--------|-------|-----------|------------|------------|---------|
| planner | glm-5.1:cloud | 7.2M | 17.2K | 81 | aborted |
| build #1 | gemma4:31b-cloud | 2.5M | 3.3K | 40 | merged |
| build #2 | gemma4:31b-cloud | 1.1M | 4.1K | 25 | merged |
| build #3 | gemma4:31b-cloud | 0.96M | 2.6K | 29 | merged |

**Git changes:** 47 files changed (1,708 insertions, 635 deletions) — all uncommitted working-tree changes from the workers' edits.