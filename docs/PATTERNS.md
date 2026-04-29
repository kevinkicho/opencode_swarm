# PATTERNS.md

Orchestration patterns the swarm can run. Pick by the work's shape, not by
ideology — both self-organizing and hierarchical patterns are first-class.

A run = one or more opencode sessions. The pattern controls how those
sessions coordinate and which roles, if any, are pinned.

The current pattern set is **6 + 1 native**:
`blackboard · council · orchestrator-worker · debate-judge · critic-loop
· map-reduce`, plus `none` (single-session opencode native).
`deliberate-execute` and `role-differentiated` were cut as
non-load-bearing after the original 8-pattern sweep.

Note on heat: agents leave traces (file edits, heat counts) and the
heat-rail (left panel `heat` tab) surfaces edit pressure per file. This
is a **UI affordance** that lights up on every pattern when ≥1 file has
been touched — it isn't a separate pattern.

---

## Self-organizing (no pinned roles)

### blackboard

Planner emits atomic todos onto a shared SQLite-backed board. N agents
claim items via CAS, execute, post file hashes back. Re-plan after every
commit so todos stay tiny and current. Auto-ticker drives at 10s cadence
with idle auto-stop.

**Files.** `lib/server/blackboard/store.ts` (SQLite), `coordinator/`
(claim/dispatch), `auto-ticker/` (loop), `planner/` (sweep).

**Strengths.** Survives single-session shocks (parallel-redundant); easy
to scale by adding sessions. Best fit for "many independent units of
work" — refactors, file-by-file edits, scattered bug fixes.

**Sizing.** Recommended teamSize ≤6. Above that the planner prompt
overflows holding 8-session state.

### council

N sessions work the same directive in parallel for ≥1 round. Reconcile
strip surfaces divergent outputs for human merge OR auto-converge if
token-jaccard ≥0.85. Round 2/3 fire server-side automatically.

**Files.** `lib/server/council.ts`, `components/council-rail.tsx`,
`reconcile-strip.tsx`.

**Strengths.** Multiple perspectives on the same problem. Good for
critical decisions where a single agent might miss a constraint.

**Sizing.** ≤5. Above that drafts don't converge in cap.

---

## Hierarchical (pinned roles)

### orchestrator-worker

One orchestrator session decomposes the directive into work items, then
dispatches each to a worker session (tagged with `[todo:<id>]` so the
plan↔task binding survives). Workers report back; orchestrator decides
next step.

**Files.** `lib/server/orchestrator-worker.ts`, `OrchestratorActionsStrip`.

**Strengths.** Clean accountability. The only pattern that scaled cleanly
to teamSize=8 in the 2026-04-26 stress test.

**Sizing.** Up to 8.

### debate-judge

N generator sessions each propose a solution; one judge session picks a
winner OR requests revisions. Verdict surfaces in `JudgeVerdictStrip`.

**Files.** `lib/server/debate-judge.ts`, `components/debate-rail.tsx`.

**Strengths.** Forces explicit comparison. Useful for design decisions.

**Sizing.** ≤4. Judge can't fit more generator drafts.

### critic-loop

One worker session + one critic session, hard-locked. Worker proposes;
critic reviews; worker revises. Iterates until critic approves or
`criticMaxIterations` hit. Verdict surfaces in `CriticVerdictStrip`.

**Files.** `lib/server/critic-loop.ts`.

**Strengths.** Single concentrated review path. Catches issues a single
session would commit and move on from.

**Sizing.** Always 2 (1 worker + 1 critic). Pattern shape locks this.

### map-reduce

N mapper sessions work pieces of the input in parallel. One reducer
session synthesizes. Per-draft 80K-char cap keeps the synthesis prompt
bounded. Optional synthesis-critic enables a post-reduce review loop.

**Files.** `lib/server/map-reduce.ts`, `SynthesisStrip`.

**Strengths.** Parallel exploration with explicit synthesis. Good for
"survey N approaches and combine."

**Sizing.** ≤5. Synthesizer context can't hold more drafts.

---

## Reliability profile

Empirical from real runs:

| Profile | Patterns |
|---|---|
| **Parallel-redundant** (survives single-session shocks) | blackboard, council |
| **Serial-critical** (one stalled session crashes the run) | orchestrator-worker, critic-loop, debate-judge, map-reduce reduce-phase |

Pick parallel-redundant when:
- The work decomposes into independent units
- You'd rather have partial results than no results
- Cloud models are flaky (likely)

Pick serial-critical when:
- Each step depends on the previous
- "All or nothing" is the right outcome shape
- You want one durable line of authority

Both are legitimate. The pattern picker exposes recommended teamSize
ceilings (`patternMeta[*].recommendedMax`) and surfaces a kickoff WARN
when the request exceeds them.

---

## Pattern picker hints

When the human picks a pattern in the new-run modal:

- The tile description names the shape ("planner+workers self-organize",
  "judge picks among generators").
- Recommended max teamSize visible inline.
- Reliability profile (parallel-redundant / serial-critical) named.

The picker is a hint, not a wizard. The human reads the work and chooses.
