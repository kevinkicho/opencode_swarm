# Weekly Review Runbook — opencode_swarm

Run every Monday. Estimated time: 10 minutes. Goal: track the metric that
matters (postmortem rate) and tighten the parse-failure loop.

## Step 1: Postmortem Frequency (1 min)

```
npx tsx scripts/pm-frequency.ts
```

| Rate | Action |
|------|--------|
| ≥ 2.5/week 🔴 | **No feature work.** Only ship reliability fixes. Re-run analyze scripts. |
| 1.0–2.4/week 🟡 | Continue reliability cadence. Defer new features. |
| 0.5–0.9/week 🟢 | Begin feature work. Maintain weekly monitoring. |
| < 0.5/week ✅ | Steady state. Normal operations. $15.6K/yr maintenance target. |

## Step 2: Parse Failure Check (3 min)

Find the most recent completed run ID, then check parse failures:

```bash
# Get latest completed run
RUN=$(curl -s http://localhost:8044/api/swarm/run | python3 -c "
import sys,json
runs=json.load(sys.stdin).get('runs',[])
done=[r for r in runs if r.get('status')=='completed']
if done: print(done[0]['meta']['swarmRunID'])
")

# Check parse failures
if [ -n "$RUN" ]; then
  curl -s "http://localhost:8044/api/_debug/swarm-run/$RUN/parse-failures" | python3 -m json.tool | head -30
fi
```

**If parse failures exist**: Open the relevant parser file (critic.ts, verifier.ts,
auditor.ts, debate-judge.ts, etc.) and tighten the regex for the top-3
failure patterns. Commit. Deploy. Next week, re-check — did unclear verdicts
decrease?

## Step 3: Cost-Per-Todo Trend Check (2 min)

Check the topbar cost-per-todo badge during a live run, or compute from logs:

```bash
# Quick estimate from the most recent completed run
curl -s http://localhost:8044/api/swarm/run | python3 -c "
import sys,json
runs=json.load(sys.stdin).get('runs',[])
done=[r for r in runs if r.get('status')=='completed']
if done:
    r=done[0]
    cost=r.get('costTotal',0)
    commits=r.get('meta',{}).get('currentTier',0)*7  # rough estimate
    if cost>0 and commits>0:
        print(f'Cost/todo: \${cost/commits:.3f} (target: \$0.029–\$0.042)')
"
```

| Drift | Action |
|-------|--------|
| < $0.029 | Model may be under-reporting tokens. Investigate. |
| $0.029–$0.042 | Normal range (MC P5-P95). |
| > $0.042 | Planner token consumption elevated. Check prompt size, model efficiency. |

## Step 4: Pipeline Health Probe (3 min, monthly only)

Run on the first Monday of each month:

```
npx tsx scripts/probe-pipelines.ts
```

If any pipeline returns prose-only (no tool calls): switch the affected model
to a working provider in `swarm-patterns.ts`. Document in
`docs/opencode-quirks.md` §10.

## Step 5: Decision Check (1 min)

Before starting ANY new feature work:

```
npx tsx scripts/decide.ts --desc "<feature description>" --effort <hours> --is-feature
```

If the output is **SKIP**, do not build it. The postmortem rate is too high
for feature work to have ROI. Focus on reliability instead.

## Weekly Log

| Date | PM Rate | Parse Failures | Cost/Todo | Action Taken |
|------|---------|---------------|-----------|-------------|
| 2026-05-10 | 5.0/week 🔴 | — | — | Baseline established. Reliability-only mode. |
| | | | | |
| | | | | |

## When to Stop

When the PM rate drops below 0.5/week for 4 consecutive weeks AND parse
failures reach zero for 4 consecutive weeks: steady-state achieved.
Switch to monthly monitoring. Begin feature work.
