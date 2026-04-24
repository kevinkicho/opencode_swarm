# 30-minute project review checklist

Structured walk-through that exercises every major surface of the app
in order. The goal is to catch the bugs that have piled up across the
last several days of layered work — each phase is ~5 min so the whole
sweep stays bounded. Mark `[x]` as you go; capture findings as new
todos in `STATUS.md` and / or postmortem entries.

## Pre-flight (1 min)

- [ ] Confirm `npm run dev` is running and tracked as a background task
  (sidebar shows the dev server, not just an orphan PID)
- [ ] Confirm opencode :4097 is up:
  `curl -sS -u opencode:<pass> http://172.24.32.1:4097/project`
- [ ] Hard-refresh the browser tab (Ctrl+Shift+R) to drop any stale JS
- [ ] Open DevTools → Console tab + React Query devtools (bottom-left)

---

## Phase 1 — Cold load (4 min)

Goal: confirm the page hydrates correctly and renders all expected
chrome on first paint.

- [ ] Navigate to `http://localhost:49187/` (root, no swarmRun) — should
  render the empty shell within 2 seconds
- [ ] Note: TTFB, FCP, time-to-any-button, time-to-data-populated
- [ ] Verify no `Internal error: Error: No QueryClient set` in dev log
- [ ] Verify no `ChunkLoadError` in the browser console
- [ ] Open the runs picker (RUNS dropup at bottom of status rail) —
  should fetch + populate within ~1 second of opening, NOT before

---

## Phase 2 — Run-state correctness (5 min)

Goal: catch any "lying status" behaviors. The picker should never claim
something is alive that's actually dead.

- [ ] In the runs picker, verify status colors match reality:
  - `live` (green) only on runs whose last activity is < 10 minutes ago
  - `stale` (amber) on runs whose last activity is older
  - `error` (rust) on runs whose last assistant turn errored
  - `idle` (fog) on runs whose last assistant turn completed cleanly
- [ ] Click a `stale` run from yesterday → does it actually navigate?
- [ ] Click an `error` run → navigation works, page renders historical
  state without crashing
- [ ] Click the current `live` run → navigates to it, populated data
  arrives within ~5s
- [ ] Verify topbar status dot reflects the same status as the picker

Known bugs (mark + reference STATUS.md entries):
- [ ] orphan runs from prior sessions showing as live (FIXED 2026-04-24
  in lib/server/swarm-registry.ts; verify after HMR)
- [ ] picker click navigation broken on some entries (todo)

---

## Phase 3 — Left-pane tabs (4 min)

Goal: each tab populates with real data; lane headers are honest.

- [ ] **PLAN tab** — todos load, status counts accurate (`N/M`),
  clicking a todo opens its detail drawer
- [ ] **ROSTER tab** — agents listed, each shows model + token count;
  spawn button visible; clicking an agent opens inspector
- [ ] **BOARD tab** (only on blackboard runs) — items listed by status,
  retry-stale button works, ticker state visible
- [ ] **HEAT tab** (only when files have been touched) — files sorted
  by edit count, clicking a file opens file-heat inspector
- [ ] **Lane headers (top of timeline)** — `out` / `in` / `tok` / `$`
  values populated, NOT em-dashes
  - Known bug: `out — in —` on idle/dead runs (todo)

---

## Phase 4 — Right-pane views (5 min)

Goal: each view renders quickly + correctly; tab-switch UX feels snappy.

- [ ] **timeline** — events flow chronologically; cross-lane wires
  visible; chips dock under their owning lane
- [ ] **cards** — turn cards group by agent in columns; horizontal
  scroll works; expand on click
  - Known bug: scroll jumps when smooth-scrolling latest (todo)
- [ ] **board** view (when blackboard) — full board with item details;
  CAS drift indicators visible
- [ ] Switching between timeline / cards / board within ~600ms in dev
- [ ] `latest ↓` button: when clicked, reaches actual bottom AND keeps
  view glued as new SSE events arrive
  - Known bug: smooth-scroll target races SSE → partial scroll (todo)

---

## Phase 5 — Modals + drawers (5 min)

Goal: every secondary surface opens, renders, dismisses cleanly.

- [ ] **CMD+K palette** opens, has actions, jumps to nodes
- [ ] **NEW RUN modal** — opens, all 9 patterns selectable, validates
  required inputs, fires successfully
- [ ] **Glossary modal** — opens, content readable, dismisses on Esc
- [ ] **Routing modal** — opens, current bounds visible, save persists
- [ ] **Spawn agent modal** — opens (blackboard only), spawns a new
  session attached to the run
- [ ] **Inspector drawer** (focused message / agent / file heat) —
  opens, close button works, click-outside dismisses, Esc dismisses

---

## Phase 6 — Live behavior (3 min)

Goal: while a run is actively producing, the UI reflects reality.

- [ ] Start a fresh run via NEW RUN — verify:
  - Topbar shows `live session`
  - ABORT button appears
  - Lane headers populate with model + tokens within 30s
  - Timeline events stream in
  - Token count + cost in topbar increments
- [ ] After ~1 min of activity, click ABORT — verify:
  - Status flips to error or idle
  - All sessions stop receiving new tokens
  - Picker reflects the new status within ~10s

---

## Phase 7 — Edge / failure (3 min)

Goal: graceful behavior when things go wrong.

- [ ] Kill opencode (Windows Task Manager → end opencode.exe) — verify:
  - Topbar status dot flips to offline / stale within ~10s
  - SSE error doesn't crash the page
  - Restart opencode → status recovers without a page reload
- [ ] Switch the dev server off briefly (Ctrl+C) — verify:
  - ChunkErrorReload component triggers a clean reload when chunks
    fail to load
  - Page resumes once dev is back
- [ ] Hard-refresh during active SSE stream — verify the stream
  reconnects without duplicate events

---

## Wrap-up (1 min)

- [ ] Capture every new finding as a STATUS.md `Queued` entry with
  effort estimate + concrete fix path
- [ ] If a finding is severe enough (broke a flow, lost data, crashed),
  open a `docs/POSTMORTEMS/<date>-<slug>.md` entry
- [ ] If a finding affects a specific pattern's expected mechanics,
  cross-reference the relevant `docs/PATTERN_DESIGN/<pattern>.md`
- [ ] Total findings count + brief one-line summary at the bottom of
  this file's "run history" section

---

## Run history

| date | runner | findings | new bugs | severity |
|---|---|---|---|---|
| 2026-04-24 (template) | first walkthrough due | — | — | — |
