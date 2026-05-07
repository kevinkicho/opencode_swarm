# STATUS.md

Where the project is right now. Time-scoped — check when asking "where are
we?" Not for *how* things work (use `DESIGN.md`), not a changelog (`git log`),
not a roadmap.

Maintenance: prune + rewrite every couple months. Remove items when shipped
or abandoned.

**Last updated:** 2026-05-07.

---

## Current state

**Functioning prototype.** UI complete, backend wired to real opencode
sessions, 6 orchestration patterns shipped end-to-end (blackboard,
council, orchestrator-worker, debate-judge, critic-loop, map-reduce)
plus `none` (single-session opencode native). Personal-use only,
never SaaS.

Recent (last 7 days, newest first):
- **`completed` status + ollama cost/token fix** (2026-05-07). Runs that
  finish cleanly now show `completed` (mint dot, "done" label) instead
  of `stale` (fog gray). The `stale` status is reserved for
  zombie/aborted runs. Ollama-routed models now report real costs
  ($0.02/1M ollama-bundle rate) and estimated token counts instead of
  $0.00/0 tokens. Stuck detector gains a `messageCount` fallback for
  zero-token providers. Smoke-tested all 7 patterns.
- **Smart smoke test + monitor scripts** (2026-05-06). `scripts/smart-smoke-test.sh`
  runs all 7 patterns sequentially with per-pattern timeouts, stall
  detection, auto-nudge, and progress logging. `scripts/swarm-monitor.sh`
  provides a periodic dashboard of all active runs.
- Phase 8 reliability hardening complete (~53 items: atomic writes,
  globalThis-keyed caches, server-only enforcement, typed opencode errors,
  per-run dispatch mutex, swarm-registry split into fs/derive halves, 7
  pattern integration tests, dispatch unit tests, postmortem ledger
  template, LRU bounds on every cache, useMutation + SSE migrations).
- Status terminology rewrite: `live` / `idle` / `completed` / `error` /
  `stale` / `unknown`. Picker visual realigned: live=mint pulse,
  idle=mint solid, completed=mint/70 "done", stale=fog gray.
- Critic-loop runaway-token leak fixed: `waitForSessionIdle` now aborts
  the opencode session on deadline expiry when a turn is still in-progress.

Active substrate:
- opencode :4096 launched via Windows Startup `.vbs`.
- Provider universe: zen + go + ollama (all routed through opencode).
- Workspace: reuse the same local directory across runs so commits
  accumulate. Don't abort mid-turn or the spend produces no durable artifact.
- Dev server on port 8044 (`.env` with `OPENCODE_URL=http://172.24.32.1:4096`).

---

## Known limitations

**Pattern reliability under GEMMA defaults.** Empirical from the original
8-pattern × 60-min validation (`deliberate-execute` and `role-differentiated`
were cut after that sweep, leaving the 6 patterns below). Governing
property: patterns where work concentrates in one critical session crash
on a single silent turn; parallel-redundant patterns survive.

| Profile | Patterns | Notes |
|---|---|---|
| **Robust** | blackboard, council | Use for important runs |
| **Serial-critical** | orchestrator-worker, critic-loop, debate-judge | F1 silent-turn aborts mid-flow; partial completion before failure |
| **Asymmetric** | map-reduce | MAP robust, REDUCE brittle (synthesizer reads ~30K tokens of N drafts → silent turns under GEMMA) |

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

- ~~**Heat tab file-tree toggle (VSCode-style).**~~ **ALREADY SHIPPED.**
  HeatRail header has three view modes — `list` (hot-first flat),
  `tree` (grouped by dir, hot only), `all` (full workspace tree, cold
  files muted, gitignore-aware via `/api/swarm/run/<id>/tree` with 5min
  staleTime via TanStack Query). Click any row → file-heat inspector.

**Validation debt** (shipped but not yet exercised live — see
`docs/VALIDATION.md` for invocation):

- **Overnight 8h run** — closest we have is 89% completion across 6 sessions
  before a Zen quota cliff at ~35min. A real 8h run that doesn't hit the
  quota wall would be the first real signal.

**Pattern-design improvements** (need a live run to validate):
- ~~map-reduce I1: synthesis-critic gate.~~ **SHIPPED 2026-04-27.**

**Smoke-test / operational** (shipped, exercised live 2026-05-06):
- ~~**Smart smoke test**~~ **SHIPPED 2026-05-06.** All 7 patterns tested
  against ktopologymath040226 workspace. 6/7 passed (productive-stale
  with real tokens/cost). The `none` pattern stalled due to an ollama
  session that never produced token counts — now mitigated by the
  `completed` status and messageCount fallback in stuck detection.

**UI redesign queued (deferred):**
- ~~**Chat-bubble view as alternate main**~~ **REWRITE SHIPPED 2026-04-28.**

**Validation tooling** (queued 2026-04-27 — improves the live-run
diagnostic loop, not the app itself):

- **Playwright video + frame extraction post-mortem.** Today the watcher
  takes 30s-tick screenshots (PNGs, callable mid-run) and writes a single
  `.webm` recordVideo at session-end. The `.webm` is binary — useless
  inline in chat — but valuable post-mortem if a workflow extracts frames
  from it. Add a post-terminal hook that locates
  `runs/_monitor/<runId>/playwright/video/page@*.webm`, runs
  `ffmpeg -i page.webm -vf fps=1/5 frame-%04d.png` to dump frames every
  5s, walks frames + flags anomalies (no-op diffs, missing bubbles,
  broken streaming, unexpected layout), writes findings to
  `runs/_monitor/<runId>/post-mortem.md`.

**UI/UX test surface gaps the sweep can't reach** (560 assertions
live; only items below pass the right-size gate per
`feedback_right_size_prototype.md`):

- ~~**End-to-end run lifecycle.**~~ **SHIPPED 2026-04-27.**
- ~~**Streaming / SSE realtime updates.**~~ **SHIPPED 2026-04-27.**
- ~~**Form validation on new-run modal.**~~ **SHIPPED 2026-04-27.**

---

## Postmortem follow-ups

| Postmortem | Status |
|---|---|
| `2026-04-24-orchestrator-worker-silent.md` | F1/F3/F6 VERIFIED. F2/F4/F7/F8/F9 SHIPPED, organic re-validation pending. |
| `2026-04-25-agent-name-silent-drop.md` | F1 VERIFIED. Closed. |
| `2026-04-26-critic-loop-runaway-token.md` | F1 VERIFIED via synthetic test. Live re-validation deferred to organic critic-loop runs. |

When babysitting a new run, walk the validation procedure for any postmortem
that touches its pattern. Update VERIFIED annotations with run id + log
excerpt when they pass against real data.