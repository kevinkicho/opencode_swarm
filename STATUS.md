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
  Validator now accepts `enableSynthesisCritic`; new-run modal surfaces
  the toggle when pattern==='map-reduce'; the gate code already existed
  in `lib/server/map-reduce.ts::runSynthesisCriticGate`.
- stigmergy: heat-picked-timeline-chip. **DEFERRED — needs schema work.**
  BoardItem doesn't currently carry a `taskMessageID` link, so the
  EventCard can't look up `pickedByHeat` for a given message. Two design
  paths: (a) add `taskMessageID` on the BoardItem at claim time and join
  in the transform, or (b) emit a stigmergy-decision event onto the
  timeline at pick time. Path (a) is cheaper but couples the schemas;
  path (b) is cleaner but adds a new event channel. Either way is more
  than a half-day; punt until a live run shows the demand.

**UI bugs queued (deferred):**
- ~~**Inspector pane doesn't open when clicking timeline blocks**~~
  **VERIFIED FIXED 2026-04-28.** Empirical Playwright probe against
  `run_moi2gc24_r4p5i1` (199 messages, populated state per
  `feedback_verify_populated_state.md`): clicking a timeline chip
  fires the `onClick`, the drawer ASIDE (`class="fixed right-0 top-12
  bottom-7 z-50"`) renders with "message inspector" content + the
  part details. Already fixed by the 2026-04-27 Popover refactor
  (`components/ui/popover.tsx`): `cloneElement` now merges the
  trigger child's existing `onClick` with the popover's reference
  props, so `<Popover><button onClick={() => onFocus(m.id)}>` no
  longer drops the inner handler.
- ~~**Runs picker line-item click + retro link don't work**~~
  **VERIFIED FIXED 2026-04-28.** Empirical probe: opened picker,
  enumerated rows — each row has 2 valid anchors (`/?swarmRun=<id>`
  + `/retro/<id>`). Clicking the row link navigated cleanly from
  `run_moi2gc24` → `run_moistttk` (the topmost row's id). Already
  fixed by the same 2026-04-27 Popover refactor: the floating-tree
  `onMouseDown stopPropagation` was removed because Floating UI's
  `useDismiss({outsidePress})` already excludes the floating tree
  from outside-press detection — so the stopPropagation served no
  purpose AND was killing anchor navigation on Next.js `<Link>`
  inside the popover.
- ~~**Run-detail URL takes 30+ seconds to load** (reported 2026-04-27).~~
  **FIXED 2026-04-27.** Measurement showed two long poles when opencode
  :4097 is unreachable: /api/swarm/run fanned out 130 runs × N session
  fetches each waiting ~10s on TCP timeout (11s total), and the proxy's
  /api/opencode/project did the same. Fix: opencodeFetch now defaults to
  an 8s timeout with a circuit breaker (3 failures in 2s → trip for 5s)
  that synthesizes a 503 instead of waiting; /api/swarm/run probes
  reachability once up front and short-circuits the per-session derive
  fan-out when opencode is down. Result: /api/swarm/run dropped from 11s
  to 1.8s with circuit-breaker armed, and to ~130ms once tripped.

**UI redesign queued (deferred):**
- ~~**Chat-bubble view as alternate main**~~ **MVP SHIPPED 2026-04-27.**
  Added `chat` view alongside `timeline` and `cards` in the main-view
  toolbar (`app/page.tsx` VIEW_PATTERN_GATES). Renders messages as a
  chronological bubble stream — author + part-type + body, A2A
  recipients shown as a "→ <agent>" header line, consecutive tool
  calls collapse into a chip row instead of N bubbles. Lives at
  `components/chat-view.tsx`. Default view is still `timeline` —
  promoting `chat` to default is a UX call that should land with a
  user-facing announcement, not silently. Empty state ("no messages
  yet") renders correctly when opencode is reachable but the run hasn't
  produced any output.

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
  `runs/_monitor/<runId>/post-mortem.md`. Keeps screenshots as the
  mid-run probe (live answer to "what looks weird?") and adds video as
  the post-run scrub artifact. Label which artifact is being read from
  when describing UI state mid-run ("(latest 30s-tick screenshot)").

**UI/UX test surface gaps the sweep can't reach** (560 assertions
live; only items below pass the right-size gate per
`feedback_right_size_prototype.md` — the items I previously listed
that don't pass the gate, like cross-browser and WCAG AA, are
intentionally omitted):

- ~~**End-to-end run lifecycle.**~~ **SHIPPED 2026-04-27.** Mocked
  Playwright e2e at `tests/visual/run-lifecycle.spec.ts` — stubs
  `/api/opencode/**` + intercepts `POST /api/swarm/run`, opens the
  modal, fills source/workspace/pattern, adds 2 agents on glm-4.6,
  clicks launch, asserts the captured request body matches the form
  fields. Catches form↔body decoupling silently breaking the only
  spawn path.
- ~~**Streaming / SSE realtime updates.**~~ **SHIPPED 2026-04-27.** SSE
  event routing extracted from `useLiveSwarmRunMessages` into a pure
  helper at `lib/opencode/live/sse-filter.ts::classifySseFrame` and
  unit-tested (9 cases) — covers parse-error, no-session, unknown
  session, message.part.updated → part decision, message.updated →
  info decision, malformed payloads → refetch fallback, other typed
  events → refetch.
- ~~**Form validation on new-run modal.**~~ **SHIPPED 2026-04-27.** 14
  tests at `components/new-run/__tests__/helpers.test.ts` covering
  extractRepoName (URL→folder parsing) + useNewRunForm (clamping,
  zero-removal, reset, clearTeam preserving other fields).

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
