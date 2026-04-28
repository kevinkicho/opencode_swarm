# 2026-04-27 — Extended blackboard run with periodic re-sweeps

User asked for an extended blackboard run. Configured for 25-min watch
budget + 30-min cap, `persistentSweepMinutes=10` to exercise the
periodic re-sweep path, deeper "survey 8 markets" directive that gives
workers genuine analytical work, and Playwright recordVideo.

## Run config

- Pattern: `blackboard`
- Run ID: `run_moi2gc24_r4p5i1`
- Workspace: yahoo-finance clone
- Sessions: 3 worker (`ollama/glm-5.1:cloud`) + 1 auditor (`ollama/nemotron-3-super:cloud`)
- Bounds: $3 cost cap, 30 min wall-clock cap
- `persistentSweepMinutes`: 10 (periodic re-sweep cadence)
- Recording: 25 min headless chromium @ 1600×1000

## Final state (30 min wall-clock)

| Signal | Value |
|---|---|
| stop reason | `wall-clock-cap` |
| tokens | 5,980,886 |
| cost | $0 (ollama subscription) |
| commits | 6 |
| plan revisions | 3 (1 initial + 2 periodic re-sweeps) |
| todos | 19 total: 6 done · 1 in-progress · 12 open |
| criteria | 12 total: 4 done (met) · 8 blocked (unmet/unverifiable) |
| sessions engaged | 4 of 4 |

## What got validated

### ✅ Periodic re-sweep at 10-min cadence

Two re-sweeps fired exactly on schedule:

```
[board/auto-ticker] periodic sweep enabled at 10-min cadence
  ... +10 min ...
[board/auto-ticker] periodic sweep seeded 11 new open todo(s) — resetting idle counters
  ... +20 min ...
[board/auto-ticker] periodic sweep seeded 8 new open todo(s) — resetting idle counters
```

Plan revisions counter advanced from 1 → 2 → 3 in step. Idle counters
reset correctly so the run never auto-idled despite gaps in commit
activity. **This is the headline feature for extended runs and worked
end-to-end.**

### ✅ Auditor cadence verdict

After ~3 commits the auditor session woke and judged the original 5
pending criteria:

```
[board/auto-ticker] audit (cadence) — judging 5 pending criteria
[board/auto-ticker] audit (cadence) done — met=4 unmet=1 wont-do=0 unclear=0
```

The verdicts updated board statuses (4 → done, 1 → blocked).

### ✅ Run-end audit on wall-clock cap

When the 30-min cap fired, the auto-ticker ran one more audit pass
across ALL pending criteria before fully stopping:

```
[board/auto-ticker] wall-clock cap breached — 30min >= 30min. Stopping.
[board/auto-ticker] audit (run-end) — judging 8 pending criteria
[board/auto-ticker] stop(wall-clock-cap) aborted 4 session(s)
```

This is the right shape — even on cap-stop, criteria get a final
verdict pass instead of being left hanging.

### ✅ All 4 sessions engaged in parallel

Per-session ticking from the auto-ticker fanout fired across all 4
sessions (3 workers + auditor when due). No hung session, no zombie
turns, no silent freeze for the full 30 minutes.

### ✅ Cost = $0

5.98M tokens consumed, all on the ollama subscription. The run cap of
$3 was never approached because ollama-cloud is bundle-priced.

## What was inconclusive

### Auto-idle-drained didn't fire

The board never drained — workers couldn't keep pace with the
re-sweep additions. Each re-sweep added 8-11 new todos faster than
workers consumed them; the queue grew over the run window
(open: 5 → 8 → 12). So my new `auto-idle-drained` path was never
exercised. It's a trade-off: persistent-sweep mode is designed exactly
for this scenario where work flows in faster than workers consume.
The fact that wall-clock cap fired correctly is the meaningful
signal — the system terminates cleanly when work isn't drainable.

### Worker velocity slower than expected

6 commits in 30 minutes = ~5 min per commit. The "survey 8 markets"
directive turns out to be heavy enough that workers do extensive
file-reading and surveying per claim. With shorter directives we
saw 5 commits in 6 minutes earlier today. The throughput is content-
sensitive.

## Artifacts

- `/tmp/swarm-recording/page@*.webm` (87 MB, 25 min capture)
- `/tmp/swarm-recording/run-id.txt` → `run_moi2gc24_r4p5i1`
- `/tmp/swarm-recording/console.log`
- run state stored in `.opencode_swarm/runs/run_moi2gc24_r4p5i1/`

## Ledger

| Finding | Status | Verification |
|---|---|---|
| Periodic re-sweep at 10-min cadence | VERIFIED | run_moi2gc24_r4p5i1 dev-server.log shows 2 sweeps firing exactly on schedule, plan revisions 1→2→3 |
| Auditor cadence verdict | VERIFIED | run_moi2gc24_r4p5i1 — "audit (cadence) done — met=4 unmet=1" mid-run |
| Run-end audit on wall-clock | VERIFIED | run_moi2gc24_r4p5i1 — "audit (run-end) — judging 8 pending criteria" before stop |
| All 4 sessions engaged in parallel | VERIFIED | run_moi2gc24_r4p5i1 — no zombie/freeze across 30 min |
| auto-idle-drained path | PENDING | board never drained because workers couldn't keep pace; needs a "shorter directive + smaller sweep" run to exercise |
| Recorder --persistent-sweep-min flag | SHIPPED | commit 8dc26b6 · run_moi2gc24_r4p5i1 |
| Recorder --directive=extended flag | SHIPPED | commit 8dc26b6 · run_moi2gc24_r4p5i1 |

## Follow-ups

- Live-verify `auto-idle-drained` with a shorter directive (single
  market survey) so workers drain the board before the next re-sweep
- Consider reducing default `persistentSweepMinutes` cadence from 10
  to 5 for short workspaces — re-sweeps every 10 min on a 30-min cap
  only fire 2-3 times, not enough to amortize the planner sweep cost
