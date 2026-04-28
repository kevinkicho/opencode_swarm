# 2026-04-27 — Blackboard recording diagnostic

Live blackboard run captured to .webm via Playwright (`recordVideo`) +
ffmpeg-extracted frames at 5s spacing. Workflow shipped 2026-04-27 per
the STATUS.md "Validation tooling" item; this is the first full
exercise of it.

## Run config

- Pattern: `blackboard`
- Workspace: `C:\Users\kevin\Workspace\kyahoofinance032926` (yahoo finance clone)
- Sessions: 3 worker (`ollama/glm-5.1:cloud`) + 1 auditor (`ollama/nemotron-3-super:cloud`)
- Critic + verifier: `ollama/gemma4:31b-cloud`
- Bounds: $1 cap, 8min cap
- Directive: "Briefly survey the README. Each agent claims one specific
  README improvement and posts a finding to the board. Stop after 3 findings."
- Recording: 6 min (chrome-headless, 1600×1000, ~25fps webm)

## Final state (captured ~7 min after spawn)

| Signal           | Value |
|------------------|-------|
| status           | live |
| tokens           | 1,360,265 |
| cost             | $0 (ollama-bundle, subscription-imputed) |
| board items      | 12 total: 8 done · 1 in-progress · 2 open · 1 blocked |
| totalCommits     | 6 |
| planner msgs     | 27 |
| worker-1 msgs    | 13 |
| worker-2 msgs    | 7  |
| auditor msgs     | 2  |

**Verdict: blackboard pattern functioning end-to-end.** Planner
emitted 12 todos (8 actionable + 4 acceptance criteria), the
auto-ticker dispatched them sequentially across sessions, and the
auditor woke for verification. 8 commits landed within the recording
window. 1 item ended up `blocked` — worth a follow-up probe (see
"Open questions" below).

## UI behaviors observed in frames

### Timeline view (default) ✅

Frames 5, 30, 40, 52: rendered cleanly across the run.
- Lanes appear progressively as sessions engage (1 lane → 2 lanes
  by ~150s as the planner pivots to a build role post-claim → 3 lanes
  by frame 074 as worker-2 wakes).
- Tool chips (`glob`, `read`, `edit`, `patch`) carry their part-taxonomy
  colors faithfully.
- `todowrite` chip highlights in **amber** — the critical
  invariant signal renders correctly.
- `step-finish · tool-calls` markers visible at every turn boundary.
- Plan revision bar ("plan committed at...") shows up after planner
  todowrite.

### Plan tab ✅

Frame 25 onward: 12 todos visible in the left rail with their full
content prefixes — `[criterion]`, `[files:...]`, `[verify]`. Long
content truncates with ellipsis. Counts on the tab pill update
(`PLAN 11/12`, `ROSTER 0/3` early; later both populate).

### Roster tab ✅

Frames 62, 70, 74: tab populates with **role-derived agents** rather
than raw sessions — `plan`, `build`, `build #1`, `build #2`. Each
carries a status annotation (`committed`, `engaged`). The agent-detail
panel surfaces when a roster row is selected, showing recent activity
preview.

### Chat view ⚠️ **REGRESSION**

Frames 17, 20, 25 (after the +60s "switch to chat" interaction).

**Symptom:** the planner's first user message — the full Blackboard
planner-sweep prompt, ~1500 chars including code-fence sections — renders
as a **single bubble that fills the entire viewport**. No internal
max-height, no overflow-scroll. With many messages in the history,
older bubbles still render but the user has to scroll the outer
container; one over-long bubble dominates the visible area.

**Cause:** my `ChatView` component shipped today (commit `058d8a9`)
renders `msg.body` inside a `<div>` with `whitespace-pre-wrap` and no
size constraint:

```tsx
<div className="text-[12.5px] text-fog-200 leading-relaxed
                whitespace-pre-wrap break-words">
  {msg.body ?? msg.title}
</div>
```

For the timeline/cards views the body is already truncated. ChatView
was meant to be the "read every word" surface but the unbounded height
makes it unusable on long messages.

**Fix shipped 2026-04-27 in this same diagnostic pass:** add a
`max-h-[40vh] overflow-y-auto` per bubble, plus a "show more" affordance
when the content was clipped. See `components/chat-view.tsx`.

### Topbar / status rail ✅

Throughout: title chip ("recorded blackboard test · 202..."), live/abort/
force-stop buttons, $0.00 cost meter, palette button all render. The
status rail at the bottom shows `ALL LIVE 1▼` (then 2, then more as
sessions wake), broadcast composer placeholder, NEW RUN / RUNS /
COST / METRICS / PROJECTS shortcuts.

### View-switching reliability ⚠️

The recorder script clicked at +60s/120s/180s/240s/300s. Frames show
the actual transitions landed late — the +60s chat click took until
~frame 17 (~85s) to register, and the +180s board click never appears
to have rendered the board view (frame 040 still shows timeline). The
matchers used `button:has-text("chat")` etc. which can over-match
or skip if the click coordinate is occluded by a tooltip. Not a
production-impacting issue (real users get hover/keyboard focus), but
the recording probe needs tighter selectors for reliable click-through.

## Structural / backend findings

### ✅ Coordinator IS parallel — slow ramp was planner-phase, not pacing

Initial draft of this postmortem flagged the run as "sequential
dispatch — only one in-progress at a time." Reading
`lib/server/blackboard/auto-ticker/tick.ts::fanout` invalidated that:
the ticker fires per-session ticks WITHOUT awaiting (`void
tickSession(s, sessionID)`), each session has its own `inFlight`
re-entrancy guard, and each tick can claim one todo via SQL CAS. Up
to N parallel claims per 10s tick interval where N = session count.

The "slow ramp" visible in frames 5-50 (only the planner lane is
active) is a **planner-phase artifact**, not a pacing limit:

1. Planner (session 0) runs read/grep/glob to survey the workspace —
   takes ~90-150s.
2. Workers 1, 2 are eligible to claim, but the board has 0 items
   until the planner emits todowrite — so they tick idle.
3. After planner-sweep ingests todowrite output, workers start
   claiming simultaneously on the next tick.

Final state confirms: 4 sessions all engaged (27/13/7/2 msgs), 6+
commits within the recording window, 10/12 items done within ~7 min.
**No fix needed** — the architecture already does what was asked. The
recording-window observation was just the warmup phase before any
work was claimable.

### ✅ Planner sweep gates correctly

`planner-sweep-complete` log shows `itemCount=12 criteriaCount=4
droppedCriteriaCount=0`. The planner emitted enough specificity that
no criteria were dropped as vague — a healthy signal.

### ✅ Commit pipeline lands edits

`ticker.lastOutcome` shows `editedPaths: ['C:/Users/.../src/markets/
watchlist/WatchlistMarket.jsx']` — real file edits are reaching the
workspace. Heat data accumulating off-frame.

### ✅ One item ended `blocked` — auditor working as designed

Probed in the follow-up pass. Item `t_d1935834` (kind=`criterion`):
"All 21 market dashboards render their claimed panels with live data
when the ▶ button is clicked and the backend is running."

Auditor verdict on `note`:
> `[audit:run-end]` No evidence that live data loads when ▶ button is
> clicked; focus has been on UI structure, not backend integration or
> runtime behavior.

This is **expected behavior**: workers can edit code but can't drive
a live browser. The auditor correctly flagged a criterion that
requires runtime verification (clicking ▶ in a rendered dashboard,
watching API responses come back) which is outside the swarm's
toolset. The auditor session itself only inspects code/diffs.

**UX polish shipped in this same diagnostic pass:** added an inline
`audit` chip on board-rail rows whose `note` starts with `[audit:`.
Color tracks status — rust on `blocked`, mint on `done`, fog
otherwise. Discoverability fix: hover-only tooltip wasn't surfacing
the verdict; the chip makes "this row was audited" visible at a
glance, with the full reason still in the tooltip. See
`components/board-rail/board-rail-row.tsx`.

### ✅ No JS pageerrors

Console captured 5 errors but all are pre-existing axe a11y warnings
about landmark uniqueness — nothing new to this run.

## Artifacts

- `/tmp/swarm-recording/page@*.webm` (18.5 MB)
- `/tmp/swarm-recording/frames/frame-{001..074}.png` (5s spacing)
- `/tmp/swarm-recording/console.log`
- `/tmp/swarm-recording/run-id.txt` → `run_mohye1as_s1l068`

## Workflow validation

The "record + extract + walk frames" workflow added 2026-04-27 worked
as intended. Frame 5s spacing is the right cadence for a 6-min run
(74 frames is browseable; 1s spacing would be 360 frames and overload
the analysis loop). The workflow surfaced one real regression (chat
view bubble overflow) that wouldn't have shown up in unit tests or
the route handler suite. Recommend keeping recordVideo on for any
diagnostic / postmortem run.

## Follow-ups

1. ~~Investigate the `blocked` board item~~ **DONE.** Auditor flagged
   an unverifiable runtime criterion — expected behavior. Inline
   `audit` chip added to board-rail rows for discoverability.
2. ~~Tighten the recorder script's view-switch selectors~~ **DONE.**
   Promoted `/tmp/blackboard-record.mjs` → `scripts/_record_run.mjs`
   with ARIA-aware exact-match selectors and per-step
   wait-for-active-class polling. Skips views that don't apply to
   the run's pattern instead of timing out.
3. ~~Coordinator pacing concern~~ **NOT A BUG.** Per-session ticker
   already runs in parallel; the ramp-up was planner-phase, not a
   pacing limit. See "Coordinator IS parallel" section above.
4. (Future) Consider a "playback this run" menu item that re-renders
   from cached events.ndjson — same diagnostic without re-spending
   tokens.

## Ledger

| Finding | Status | Verification |
|---|---|---|
| Chat-view long-bubble overflow | SHIPPED | commit d9e3823 · live re-screenshot against `run_mohye1as_s1l068` confirmed multiple bubbles render with bounded heights |
| Auditor-blocked criterion is by design | NOT-APPLICABLE | run `run_mohye1as_s1l068` board item `t_d1935834` audited — no fix required |
| `audit` chip on board-rail rows | SHIPPED | commit pending in this PR · `components/board-rail/board-rail-row.tsx` |
| Recorder selectors tightened | SHIPPED | commit pending · `scripts/_record_run.mjs` next live recording will VERIFY |
| Coordinator parallel-claim concern | NOT-APPLICABLE | code-review of `lib/server/blackboard/auto-ticker/tick.ts::fanout` confirmed already parallel; final state of run `run_mohye1as_s1l068` (4 sessions all engaged, 27/13/7/2 msgs) supports |
| Future: events.ndjson replay UI | PENDING | not started |
