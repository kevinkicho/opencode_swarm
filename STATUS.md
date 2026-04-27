# STATUS.md

Where the project is right now. Time-scoped — check when asking "where are
we?" Not for *how* things work (use `DESIGN.md`), not a changelog (`git log`),
not a roadmap.

Maintenance: prune + rewrite every couple months. Remove items when shipped
or abandoned.

**Last updated:** 2026-04-26.

---

## Current state

**Functioning prototype.** UI complete, backend wired to real opencode
sessions, 9 orchestration patterns shipped end-to-end. Personal-use only,
never SaaS.

Recent (last 7 days):
- Phase 8 reliability hardening complete (~53 items: atomic writes,
  globalThis-keyed caches, server-only enforcement, typed opencode errors,
  per-run dispatch mutex, swarm-registry split into fs/derive halves, 7
  pattern integration tests, dispatch unit tests, postmortem ledger
  template, LRU bounds on every cache, useMutation + SSE migrations).
- Status terminology rewrite: `live` (ticker + producing), `idle` (ticker
  alive but quiet), `error` (real failure), `stale` (ticker stopped),
  `unknown`. Picker visual realigned: live=mint pulse, idle=mint solid,
  stale=fog gray. Old schema's "completed cleanly = idle" was confusing
  ("are these still alive?").
- Chatbox `all live` broadcast fan-outs to every session in the roster
  (was: only primary).
- Critic-loop runaway-token leak fixed: `waitForSessionIdle` now aborts
  the opencode session on deadline expiry when a turn is still in-progress.
  See `docs/POSTMORTEMS/2026-04-26-critic-loop-runaway-token.md`.

Active substrate:
- opencode :4097 launched via Windows Startup `.vbs`.
- Provider universe: zen + go + ollama (all routed through opencode).
- Workspace: reuse the same local directory across runs so commits
  accumulate. Don't abort mid-turn or the spend produces no durable artifact.

---

## Known limitations

**Pattern reliability under GEMMA defaults.** Empirical from the 8-pattern ×
60-min validation. Governing property: patterns where work concentrates in
one critical session crash on a single silent turn; parallel-redundant
patterns survive.

| Profile | Patterns | Notes |
|---|---|---|
| **Robust** | blackboard, council, role-differentiated | Use for important runs |
| **Serial-critical** | orchestrator-worker, critic-loop, debate-judge | F1 silent-turn aborts mid-flow; partial completion before failure |
| **Asymmetric** | map-reduce | MAP robust, REDUCE brittle (synthesizer reads ~30K tokens of N drafts → silent turns under GEMMA) |

When picking a pattern for a real run, prefer the robust tier unless the
work specifically benefits from a fragile shape (debate divergence, critic
iteration).

**HMR limited.** HMR covers only `coordinator.ts`, `planner.ts`,
`auto-ticker.ts`. Edits to other `lib/server/` files need a dev-server
bounce to take effect on live tickers. Low priority.

**Initial hydration on huge runs.** SSE-merge means active runs splice
`message.part.updated` in O(1), but first-mount fan-out still does N
parallel full-history fetches. Worst-case for a fresh tab opening a run
with 100s of messages per session. Mitigation paths: stagger initial
hydrate, or range-limit to last K messages with full history on scroll up.
Not urgent.

---

## Queued

**High-leverage, < 1 day each:**

- **30-minute project review checklist** (`docs/REVIEW_CHECKLIST.md`) —
  structured walkthrough of every major surface in 7 phases. Not yet drafted.
- **Heat tab file-tree toggle (VSCode-style).** Button in heat-rail header
  flips between heat-list and tree view of the workspace. Files in the tree
  show heat chips. Click → file-heat inspector. Needs a workspace-tree
  endpoint, gitignore-aware, short cache.

**Validation debt** (shipped but not exercised live — see `docs/VALIDATION.md`
for invocation):

- **Playwright grounding** (`enableVerifierGate: true`) — schema + code
  wired, never run live. Blocked on user spinning up the target repo's dev
  server + passing `workspaceDevUrl`.
- **Pattern benchmark script** (`scripts/_pattern_benchmark.mjs`) — works,
  never invoked. ~$12 / ~1h wall-clock for the default 3-pattern run.
- **Ambition-ratchet tier escalation** — tier-2+ has never fired in anger.
  Today's runs stop at tier 1 before drain.
- **Overnight 8h run** — closest we have is 89% completion across 6 sessions
  before a Zen quota cliff at ~35min. A real 8h run that doesn't hit the
  quota wall would be the first real signal.

**Pattern-design improvements** (need a live run to validate):
- map-reduce I1: synthesis-critic gate.
- role-differentiated I4: per-role token budgets.
- stigmergy: heat-picked-timeline-chip.

---

## Postmortem follow-ups

| Postmortem | Status |
|---|---|
| `2026-04-24-orchestrator-worker-silent.md` | F1/F3/F6 VERIFIED. F2/F4/F7/F8/F9 SHIPPED, organic re-validation pending. |
| `2026-04-25-agent-name-silent-drop.md` | F1 VERIFIED. Closed. |
| `2026-04-26-critic-loop-runaway-token.md` | F1 VERIFIED via synthetic test (`wait-deadline-abort.test.ts`). Live re-validation deferred to organic critic-loop runs. |

When babysitting a new run, walk the validation procedure for any postmortem
that touches its pattern. Update VERIFIED annotations with run id + log
excerpt when they pass against real data.
