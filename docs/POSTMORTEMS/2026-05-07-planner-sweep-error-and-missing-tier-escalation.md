# 2026-05-07 · Planner sweep error + missing tier escalation

**Run:** `run_mouwgsmj_41g5ek`
**Pattern + models:** blackboard · glm-5.1:cloud (planner) + gemma4:31b-cloud (2 workers) + nemotron-3-super:cloud (worker + critic + auditor)
**Outcome:** Run auto-stopped after 35 min with `auto-idle-drained`. 7/9 todos completed, 2 stale (critic-rejected), 2 criteria blocked. Planner (glm-5.1:cloud) errored on two consecutive sweeps producing degraded-completion findings instead of fresh work.

## What broke

**Two planner sweep errors** at ~03:37 UTC and ~03:40 UTC:

- Finding t_6c4a0f1f: planner sweep aborted with "reason: error" at 5/9 todos done
- Finding t_9df7d5e1: planner sweep aborted again at 7/9 todos done

After the second error, the board had 0 open work-class items. All sessions hit the idle threshold and the ticker stopped with `auto-idle-drained`.

**Monitor script (`swarm-monitor.sh`) did not detect the errors** — it only polls `/api/swarm/run` for status/tokens/cost, with no alerting on:
- Planner sweep errors (degraded-completion findings)
- Premature `auto-idle-drained` stops
- Stale/blocked item counts

## Why

Verified:
- The planner session (glm-5.1:cloud) consumed 6.5M input tokens (84% of total) and was aborted mid-sweep, consistent with known serial-critical reliability issues
- `auto-idle-drained` correctly stops the ticker when the board has no work-class items and all sessions are idle — the stop itself is correct, but the run ran out of work to dispatch because the re-sweep mechanism couldn't produce new todos
- The tier escalation / ambition ratchet was **designed but never implemented** — `currentTier` is referenced in comments across `auto-ticker/*.ts`, `audit.ts` accepts `'tier-escalation'` as an audit reason, `prompt.ts` mentions "tier escalation preamble" in its module header, and `PlannerExports` accepts `escalationTier?: number` in `runPlannerSweep` — but no code actually calls it

Speculation:
- The planner errors may correlate with long context (6.5M tokens in) causing OOM or context truncation on the glm-5.1:cloud provider
- Without tier escalation, each re-sweep produces the same scope of work (bug fixes, small improvements) instead of progressively larger ambitions, so the board exhausts easy work and can't refill

## What we did

- **F1.** Implemented the ambition ratchet (tier escalation): `currentTier` state in `TickerState`, `attemptTierEscalation()` that bumps the tier when the board drains, persists it via `updateRunMeta`, and passes it to `runPlannerSweep` so the planner prompt gets an ambition-scaling preamble. The planner now produces progressively larger-scoped work across tiers:
  - Tier 1: fix bugs, polish, small improvements
  - Tier 2: refactor, extract, add missing features
  - Tier 3: cross-cutting, architectural, new features
  - Tier 4: integrations, end-to-end, missing spec claims
  - Tier 5+: ambitious bets, multi-area improvements

- **F2.** Improved `swarm-monitor.sh` to detect and alert on: planner sweep errors (findings with `degraded-completion`), premature stops (`auto-idle-drained` with low commit counts), stale/blocked item counts, and tier escalation events.

## How we'd know it regressed

- F1: A blackboard run that completes all tier-1 work and then stops with `auto-idle-drained` instead of escalating to tier-2. Check the board for an escalation finding (`[ratchet]` prefix) between tiers.
- F2: Run `./scripts/swarm-monitor.sh` during a live run — it should show `[!] alerts` for sweep errors and premature stops.

## Ledger

| Finding | Status | Verification |
|---|---|---|
| F1. Ambition ratchet / tier escalation | SHIPPED | `lib/server/blackboard/auto-ticker/escalation.ts` + `tick.ts` — attemptTierEscalation fires before auto-idle-drained stop |
| F2. Monitor script improvements | SHIPPED | `scripts/swarm-monitor.sh` — detects sweep errors, premature stops, tier escalation events |