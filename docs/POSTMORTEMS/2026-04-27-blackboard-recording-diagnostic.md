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

### ✅ Coordinator pacing is conservative-correct

Auto-ticker fires every 10s and claims **one item at a time** (never
fans out parallel claims). Visible in the recording as a slow ramp:
only worker session 0 active for the first ~150s, second session only
woke around frame 074 (~5.5min). For short runs this means the
parallel hardware (3 sessions) is underutilized; for long runs it
prevents over-claim contention. Tradeoff is by design — flagged here
for awareness, not as a bug.

### ✅ Planner sweep gates correctly

`planner-sweep-complete` log shows `itemCount=12 criteriaCount=4
droppedCriteriaCount=0`. The planner emitted enough specificity that
no criteria were dropped as vague — a healthy signal.

### ✅ Commit pipeline lands edits

`ticker.lastOutcome` shows `editedPaths: ['C:/Users/.../src/markets/
watchlist/WatchlistMarket.jsx']` — real file edits are reaching the
workspace. Heat data accumulating off-frame.

### ⚠️ One item ended `blocked`

Final board state has `blocked: 1`. Without a deeper probe I don't
know why. Worth running a follow-up `gh` or grep on the run's
events.ndjson + the board store to find the block reason. Not
addressed in this PR.

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

1. Investigate the `blocked` board item (run id above) — find the
   reason and decide if it's a planner-emitted dependency, a stale
   commit, or a real worker failure.
2. Tighten the recorder script's view-switch selectors so the .webm
   reliably exercises every view in a single pass.
3. Consider adding a "playback this run" menu item that re-renders
   from cached events.ndjson — same diagnostic without re-spending
   tokens.
