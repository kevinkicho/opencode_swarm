# STATUS.md

Where the project is right now. Time-scoped — check when asking "where are
we?" Not for *how* things work (use `DESIGN.md`), not a changelog (`git log`),
not a roadmap.

Maintenance: prune + rewrite every couple months. Remove items when shipped
or abandoned.

**Last updated:** 2026-04-27.

---

## Current state

**Functioning prototype.** UI complete, backend wired to real opencode
sessions, 7 orchestration patterns shipped end-to-end (blackboard,
council, stigmergy, orchestrator-worker, debate-judge, critic-loop,
map-reduce — `deliberate-execute` and `role-differentiated` were cut as
non-load-bearing). Personal-use only, never SaaS.

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
| **Robust** | blackboard, council | Use for important runs |
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

- **Heat tab file-tree toggle (VSCode-style).** Button in heat-rail header
  flips between heat-list and tree view of the workspace. Files in the tree
  show heat chips. Click → file-heat inspector. Needs a workspace-tree
  endpoint, gitignore-aware, short cache.

**Validation debt** (shipped but not yet exercised live — see
`docs/VALIDATION.md` for invocation):

- **Overnight 8h run** — closest we have is 89% completion across 6 sessions
  before a Zen quota cliff at ~35min. A real 8h run that doesn't hit the
  quota wall would be the first real signal.

**Pattern-design improvements** (need a live run to validate):
- map-reduce I1: synthesis-critic gate.
- stigmergy: heat-picked-timeline-chip.

**UI bugs queued (deferred):**
- **Inspector pane doesn't open when clicking timeline blocks** (reported
  2026-04-27). Repro: click a message card on the timeline. Expected:
  inspector drawer slides in showing the part detail. Actual: nothing.
  Suspect chain: timeline card `onClick → onFocus(msgId)` →
  `setFocusedMsgId` → Drawer renders when `drawerOpen && focusedMsgId`.
  One of those three steps is broken — likely either drawerOpen isn't
  being set on focus, or onClick isn't propagating from the card. Files
  to check: `app/page.tsx` (Drawer wiring), `components/timeline-flow/
  sub-components.tsx` (EventCard onClick), `app/page-internals/use-
  page-state.ts` or similar (focus state handler).

**UI/UX test surface gaps the sweep can't reach** (560 assertions
live; only items below pass the right-size gate per
`feedback_right_size_prototype.md` — the items I previously listed
that don't pass the gate, like cross-browser and WCAG AA, are
intentionally omitted):

- **End-to-end run lifecycle.** spawn → land on home → see lanes →
  broadcast → see responses → close. Each piece is unit-tested but the
  flow itself isn't. The actual answer to "is this app working as
  intended?" lives here. Best done as a mocked Playwright e2e
  (stubs `/api/opencode/**`) for CI + a gated live spec for real-
  signal verification.
- **Streaming / SSE realtime updates.** No test exercises "agent
  emits token → lane row updates / part chip animates." Worth fencing
  because silent breakage means the user sees frozen runs and
  doesn't know why. Needs a fake SSE server or controlled live run.
- **Form validation on new-run modal.** Source URL parsing + cap
  edge values are the most likely regression vectors; the rest is
  trivial. Worth a small vitest + userEvent test on the new-run
  form alone, not the other modals.

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
