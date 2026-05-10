# 30-minute project review checklist

Structured walk-through that exercises every major surface of the app
in order. The goal is to catch the bugs that have piled up across the
last several days of layered work — each phase is ~5 min so the whole
sweep stays bounded. Mark `[x]` as you go; capture findings as new
todos in `STATUS.md` and / or postmortem entries.

**Last review**: 2026-05-09 — virtual audit (no live dev server). 57 tests pass, `tsc` clean (2 pre-existing errors). All 19 composite plan items shipped. Queue empty.

## Pre-flight (1 min)

- [ ] Confirm `npm run dev` is running on port 8044
- [ ] Confirm opencode :4097 is up:
  `curl -sS -u opencode:<pass> http://172.24.32.1:4097/project`
- [ ] Hard-refresh the browser tab (Ctrl+Shift+R) to drop any stale JS
- [ ] Run `npx tsx scripts/pm-frequency.ts` — confirm rate is known
- [ ] Run `npx tsc --noEmit` — confirm 2 pre-existing harvest-drafts errors only

---

## Phase 1 — Cold load (4 min)

Goal: confirm the page hydrates correctly and renders all expected
chrome on first paint.

- [ ] Navigate to `http://localhost:8044/` — empty shell within 2s
- [ ] Note: TTFB, FCP, time-to-any-button, time-to-data-populated
- [ ] Verify no `Internal error: Error: No QueryClient set` in dev log
- [ ] Verify no `ChunkLoadError` in the browser console
- [ ] Open the runs picker (RUNS dropup at bottom of status rail) —
  should fetch + populate within ~1s of opening

---

## Phase 2 — Run-state correctness (5 min)

Goal: catch any "lying status" behaviors. The picker should never claim
something is alive that's actually dead.

- [ ] In the runs picker, verify status colors match reality:
  - `live` (mint pulse) only on runs with recent activity
  - `idle` (mint solid) on quiet-but-running runs
  - `completed` (mint/70) on cleanly finished runs — SHIPPED 2026-05-07
  - `stale` (fog gray) on stopped/zombie runs
  - `error` (rust) on runs with session errors
- [ ] Click a `stale` run from yesterday → does it actually navigate?
- [ ] Click a `completed` run → retro button visible in topbar? — NEW
- [ ] Click the current `live` run → navigates to it, populated data
  arrives within ~5s
- [ ] Verify topbar status dot reflects the same status as the picker

Known bugs (verified fixed):
- [x] orphan runs from prior sessions showing as live (fixed 2026-04-24)
- [x] planner error badge showing tool name instead of error message (fixed 2026-05-08)
- [x] timeline + roster flashing after run ended (fixed 2026-05-08)
- [x] gate sessions showing as "planner" in roster (fixed 2026-05-08)

---

## Phase 3 — Left-pane tabs (4 min)

Goal: each tab populates with real data; lane headers are honest.

- [ ] **PLAN tab** — todos load, status counts accurate (`N/M`),
  clicking a todo opens its detail drawer
- [ ] **ROSTER tab** — agents listed, each shows model + token count;
  spawn button visible; clicking an agent opens inspector
- [ ] **BOARD tab** (only on blackboard runs) — items listed by status,
  **filter chips visible** (open/in-progress/done/stale + todo/criterion/finding) — NEW
  retry-stale button works, ticker state visible
- [ ] **HEAT tab** (only when files have been touched) — files sorted
  by edit count, clicking a file opens file-heat inspector
- [ ] **Lane headers (top of timeline)** — `out` / `in` / `tok` / `$`
  values populated, NOT em-dashes

---

## Phase 4 — Right-pane views (5 min)

Goal: each view renders quickly + correctly; tab-switch UX feels snappy.

- [ ] **timeline** — events flow chronologically; cross-lane wires
  visible; chips dock under their owning lane
- [ ] **cards** — turn cards group by agent in columns; horizontal
  scroll works; expand on click
- [ ] **board** view (when blackboard) — full board with item details;
  CAS drift indicators visible
- [ ] Switching between timeline / cards / board within ~600ms in dev
- [ ] `latest ↓` button: when clicked, reaches actual bottom AND keeps
  view glued as new SSE events arrive

---

## Phase 5 — Modals + drawers (5 min)

Goal: every secondary surface opens, renders, dismisses cleanly.

- [ ] **CMD+K palette** opens, has actions, jumps to nodes
- [ ] **NEW RUN modal** — opens, all 8 patterns selectable
  (`none · blackboard · map-reduce · council · orchestrator-worker ·
  debate-judge · critic-loop · pipeline`), **pattern recommender chip** visible
  when typing directive — NEW, **template dropdown** visible when templates
  saved — NEW, **save template** button in bottom bar — NEW,
  cost-per-todo badge in topbar ($0.034/todo) — NEW
- [ ] **Glossary modal** — opens, content readable, dismisses on Esc
- [ ] **Routing modal** — opens, current bounds visible, save persists
- [ ] **Spawn agent modal** — opens from the roster `+` icon
- [ ] **Diagnostics modal** — opens from footer right
- [ ] **Metrics modal** — opens from topbar, cross-preset cost dashboard
- [ ] **Projects modal** — opens from topbar
- [ ] **Run retro modal** — opens from topbar "retro" button on
  completed/stale runs — NEW
- [ ] **Inspector drawer** (focused message / agent / file heat) —
  opens, close button works, click-outside dismisses, Esc dismisses
- [ ] **Provider-stats popover** — opens from topbar provider badge on click — SHIPPED

---

## Phase 6 — Live behavior (3 min)

Goal: while a run is actively producing, the UI reflects reality.

- [ ] Start a fresh run via NEW RUN — verify:
  - Topbar shows `live session`
  - **Cost-per-todo badge** ($X.XXX/todo) appears after first commit — NEW
  - **Budget warning chip** (amber %) appears at 90% cost cap — NEW
  - ABORT button appears
  - Lane headers populate with model + tokens within 30s
  - Timeline events stream in
  - Token count + cost in topbar increments
- [ ] After ~1 min of activity, click ABORT — verify:
  - Status flips to error or idle
  - All sessions stop receiving new tokens
  - Picker reflects the new status within ~10s

---

## Phase 7 — New features (4 min)

Goal: verify features shipped 2026-05-08/09 work end-to-end.

- [ ] **Pattern recommender** — type a directive like "fix bugs in auth"
  in the new-run modal, verify suggested pattern chip appears
- [ ] **Run templates** — save a template via "save template" button,
  reload modal, verify it appears in dropdown, load it, verify form fills
- [ ] **Board filters** — on a blackboard run with items, verify
  status/kind filter chips dim non-matching items
- [ ] **Cost-per-todo badge** — verify topbar shows `$0.XXX/todo` with
  tooltip showing MC baseline
- [ ] **Silent session chip** — verify amber "X silent" chip in
  RunHealthChip when sessions are silent
- [ ] **Run retro modal** — on a completed/stale run, click "retro" in
  topbar, verify agent table + summary row renders
- [ ] **Historical recommendation** — type a directive matching a past
  run, verify data-driven recommendation chip below pattern selector
- [ ] **Auto-pilot** — check server logs for `[auto-pilot]` lines during
  a live run (logging-only, not auto-executing)
- [ ] **Human-in-the-loop** — the SwarmComposer at page bottom is wired
  with target picker + send button. Type a message to a live agent.

---

## Phase 8 — Edge / failure (3 min)

Goal: graceful behavior when things go wrong.

- [ ] Kill opencode (Windows Task Manager → end opencode.exe) — verify:
  - Topbar status dot flips to offline / stale within ~10s
  - SSE error doesn't crash the page
  - Restart opencode → status recovers without a page reload
- [ ] Switch the dev server off briefly (Ctrl+C) — verify:
  - ChunkErrorReload component triggers a clean reload
  - Page resumes once dev is back
- [ ] Hard-refresh during active SSE stream — verify the stream
  reconnects without duplicate events
- [ ] Submit a run with `workspace: "../../etc"` — verify 400 rejection
  (path traversal guard — SECURITY S1) — NEW
- [ ] Submit a webhook without `WEBHOOK_SECRET` configured — verify 401
  (SECURITY PenTest V1) — NEW
- [ ] Try accessing `/_debug/` endpoints in production mode — verify 403
  (DEBUG_ENABLED gate — SECURITY S3) — NEW

---

## Wrap-up (1 min)

- [ ] Capture every new finding as a STATUS.md entry
- [ ] If a finding is severe enough, open a postmortem entry
- [ ] Run `npx tsc --noEmit` to confirm no new type errors
- [ ] Run `npx vitest run` to confirm no new test failures (expect 2 pre-existing
  harvest-drafts + 30+ ELF header errors in WSL)
- [ ] Run `npx tsx scripts/pm-frequency.ts` to log current postmortem rate
- [ ] Total findings count + brief one-line summary below

---

## Run history

| date | runner | findings | new bugs | severity |
|---|---|---|---|---|
| 2026-04-24 | template | — | — | — |
| 2026-05-09 | virtual audit | 0 | 0 | — |

**2026-05-09 notes**: Virtual audit (no live dev server available in WSL). All code changes typechecked and tested. 57 dedicated tests pass. Queue empty. 19 composite plan items shipped. 5 future directions shipped. Pre-existing: 2 harvest-drafts type errors, 30+ WSL SQLite native module test failures. Next live review should run phases 6-7-8 against a real opencode daemon.
