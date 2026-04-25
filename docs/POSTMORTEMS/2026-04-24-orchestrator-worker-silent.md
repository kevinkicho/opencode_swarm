# 2026-04-24 · orchestrator-worker 15-min silent failure

**Run:** `run_mod5dy6n_utsb32`
**Pattern:** orchestrator-worker (5 sessions: 1 orchestrator + 4 workers)
**Models:** orchestrator=`nemotron-3-super:cloud` (ollama), workers=`gemma4:31b-cloud` (ollama)
**Workspace:** `C:\Users\kevin\Workspace\kyahoofinance032926`
**Directive:** README-anchored — implement unfulfilled README claims
**Outcome:** 0 tokens across all sessions in 18 min; planner sweep timed out at t+15m; no assistant response ever generated; board stayed empty.

---

## 1 · Observed failure

Dev server console (`/tmp/claude-1000/.../bcpqhmobq.output`):

```
t+0s    POST /api/swarm/run → 201  (5 opencode sessions provisioned)
t+1s    [model-prewarm] nemotron-3-super:cloud warm in 1.4s  ✓
t+1s    [model-prewarm] gemma4:31b-cloud warm in 0.5s        ✓
t+5s    [orchestrator-worker] orchestrator intro posted to
        ses_23f98a060ffeow5TqoqIVzIq3Z  (~1.1 KB prompt)     ✓
t+5s    runPlannerSweep begins on same session
t+5s — t+15m    CONSOLE SILENT. No token delta. No SSE event.
                No opencode error. No ollama error. Nothing.
t+15m   [orchestrator-worker] initial planner sweep failed:
        planner sweep timed out after 900000ms
t+18m   SSE /board/events long-poll completes (1,106,902 ms)
```

Session 0: 1 user message, 0 assistant messages. Sessions 1-4: 0 messages
(sweep never produced todos, so workers were never dispatched).

## 2 · Diagnosis (verified vs. speculation)

### Verified facts

- **Model native context limits** (from ollama `/api/show`):
  - nemotron-3-super:cloud · 262,144
  - glm-5.1:cloud · 202,752
  - gemma4:31b-cloud · 262,144
- **`~/.config/opencode/opencode.json` overrides** applied to ollama models:
  - nemotron-3-super:cloud · `limit.context = 131072` (half native; asymmetric)
  - glm-5.1:cloud · `limit.context = 202752` (matches native)
  - gemma4:31b-cloud · `limit.context = 262144` (matches native)
- **Windows opencode daemon log** (`/mnt/c/Users/kevin/.local/share/opencode/log/2026-04-23T212244.log`)
  during run window (16:52–17:11 UTC) contains **only** `service=bus type=file.watcher.updated`
  events and `service=snapshot prune=7.days cleanup`. No `session.created`, no
  `service=server method=POST path=/session/...`, no provider errors.
- **Session ID `ses_23f98a06*` appears zero times** in any opencode log on either
  Windows or WSL.
- **The session did exist in opencode** — our subsequent `GET /session/:id/message`
  returned HTTP 200 with the 1 user message. So opencode accepted the POST and
  created session state.
- **`postSessionMessageServer`** (`lib/server/opencode-server.ts:134-179`) awaits
  only the HTTP acknowledgment from opencode's `/prompt_async` endpoint. That
  endpoint is asynchronous by design — it returns as soon as the prompt is
  queued, not after the assistant produces anything.
- **`waitForSessionIdle`** (`lib/server/blackboard/coordinator.ts:416-455`) polls
  `/session/:id/message` every 1s for up to 15 min. Completion is detected via
  `info.time.completed` being set; error via `info.error`. A message with
  neither set is treated as "still running."

### NOT verified (hypotheses only)

- **Whether the 131072 context override caused the hang.** opencode may enforce
  the override as a hard cap (in which case a >131k prompt would fail silently)
  OR use it only as a hint (in which case it's irrelevant). We have no evidence
  of opencode rejecting the prompt on this basis.
- **Whether ollama was contacted at all.** The Windows opencode log doesn't
  record provider calls at default log level; we have no independent signal
  that ollama saw a request.
- **Why the ollama_swarm sibling project's opencode logs showed 200+
  `error= failed` entries.** Those are from a separate opencode instance
  handling a different project. The empty error body is a generic log
  formatter issue in opencode itself.

### Root-cause statement

**We do not know what failed.** The orchestrator session accepted the user
prompt and never produced an assistant response. From our app's position
we cannot distinguish among: ollama silently rejected the request · opencode
failed to forward to ollama · ollama started generating and hung ·
ollama↔opencode connection dropped · opencode's AI SDK adapter hit an error
and swallowed it. The reason we can't distinguish is **the actual bug**:
our app emits no observations between dispatch and the 15-min timeout.

## 3 · Fixes

### P0 — observability (unblocks every other fix)

#### F1 · Dispatch watchdog

- **Where:** `lib/server/blackboard/coordinator.ts`, parallel to `waitForSessionIdle`
- **What:** every 30s, count new message parts since dispatch. Log WARN at 90s
  of silence, ERROR + abort at 240s.
- **Validation:** on a run with a deliberately-unreachable model, the dev-server
  console must show `[coordinator] session X silent 90s on item Y` within 2 min
  of dispatch (instead of 15 min of silence). Grep the captured dev log:
  ```
  grep -E 'silent [0-9]+s on' <dev-output>
  ```

#### F2 · Tail opencode log into dev stdout

- **Where:** new `lib/server/opencode-log-tail.ts`, started from dev server init
- **What:** `tail -F /mnt/c/Users/kevin/.local/share/opencode/log/<active>.log`,
  filter out `file.watcher.updated` / `snapshot prune`, prefix `[opencode]`,
  forward to stdout.
- **Validation:** after dev-server start, provoke an opencode error (e.g. POST
  to a non-existent session). Dev log must contain an `[opencode]`-prefixed
  line within 5s. Grep:
  ```
  grep -E '^\[opencode\]' <dev-output> | head
  ```

### P1 — active probing

#### F3 · Raise opencode log level

- **Where:** `C:\Users\kevin\bin\opencode-web-4097.ps1` (launcher script)
- **What:** pass `OPENCODE_LOG=debug` (or equivalent documented flag) so
  session creation, message POST, and provider dispatch are logged.
- **Validation:** after relaunch, run any session creation. The Windows opencode
  log must contain `service=session id=ses_... created` and
  `service=server method=POST path=/session/.../message` entries for that
  session. Grep:
  ```
  grep -E 'service=(session|server method=POST path=/session)' <opencode-log> | wc -l
  ```
  Should be > 0 per run (was 0 for run_mod5dy6n_utsb32).

#### F4 · Ollama `/api/ps` liveness probe in waitForSessionIdle

- **Where:** `lib/server/blackboard/coordinator.ts`
- **What:** every 30s during wait, hit ollama's `/api/ps`. If target model not
  in running list, mark turn as `provider-unavailable` and fail fast.
- **Validation:** on a run where ollama is stopped mid-dispatch, turn must fail
  within 30s with reason `provider-unavailable` (not `turn timed out`). Board
  item note must match `/provider-unavailable/`.

#### F5 · Session-level error read

- **Where:** `lib/opencode/transform.ts` + `lib/server/blackboard/coordinator.ts`
- **What:** check `GET /session/:id` for a session-level error field distinct
  from per-message `info.error`. If present, surface before timeout.
- **Validation:** pending F3 (need opencode to actually log session errors to
  know the field name). Open question until debug logs available.

### P2 — config hygiene

#### F6 · Reconcile opencode.json overrides

- **Where:** `/mnt/c/Users/kevin/.config/opencode/opencode.json`
- **What:** raise nemotron's `limit.context` from 131072 to 262144 (native), OR
  add a comment explaining the half-native cap.
- **Validation:** after edit + opencode restart, `curl http://172.24.32.1:4097/model`
  must return `nemotron-3-super:cloud` with `limit.context=262144`.

#### F7 · Preflight prompt-size estimate

- **Where:** `lib/server/opencode-server.ts` (in `postSessionMessageServer`)
- **What:** estimate `approx_tokens(prompt_text + tool_defs_size_estimate)`
  before dispatch. Refuse at >85% of model's `limit.context`; log WARN at >60%.
- **Validation:** craft a prompt that exceeds nemotron's limit; dispatch must
  be refused with a clear error naming the model's limit, NOT silently hang.

### P3 — UI surfacing

#### F8 · Run-health banner

- **Where:** `components/run-topbar.tsx` (chip slot)
- **What:** aggregate `sessions silent > 60s`, `items retry-maxed`,
  `ticker stopReason`, `last opencode error`. Click to expand.
- **Validation:** manual — in a healthy run, chip is green. In a run with any
  of the failure conditions, chip is amber/red and expands to show the cause.

#### F9 · Retry-exhausted chip on board item rows

- **Where:** `components/board-rail.tsx:293` area
- **What:** when an item's `note` matches `/^\[retry:\d+\]/`, show an
  amber chip in the row itself (not just the hover tooltip).
- **Validation:** on `run_mob31bx6_jzdfs2` (has 6 items with `[retry:2]`
  notes), every row in the open section must show the amber chip.

## 4 · Ledger

Update as fixes land. Each VERIFIED entry cites a subsequent run that
exhibited the fix working.

| Fix | Status | Commit | Verified against | Notes |
|-----|--------|--------|------------------|-------|
| F1  | VERIFIED | d824bf4 | `run_modn6mrg_hxvssz` (orchestrator-worker, 2026-04-24 evening) | dispatch watchdog inside waitForSessionIdle: WARN at 90s of no-new-parts, ERROR + abort at 240s; new reason='silent' on the ok=false return. **Fired 3+ times during pattern 2 of the live multi-pattern test** — 1 WARN + 2 abort on real silent sessions (planner + worker sessions) without false positives. The 240s abort prevented the previously-observed 15-min-of-zero-signal failure mode. |
| F2  | SHIPPED | (next commit) | — | lib/server/opencode-log-tail.ts polls /mnt/c/Users/<user>/.local/share/opencode/log for the newest .log; tails on 1s cadence; filters file.watcher.updated + snapshot prune + session.idle noise; started from instrumentation.ts on Node runtime |
| F3  | VERIFIED | (launcher edit 2026-04-25) | 2026-04-25 restart (PID 26812) | `OPENCODE_LOG=debug` env var was a wrong-name guess — `opencode web --help` confirms the actual flag is `--log-level [DEBUG\|INFO\|WARN\|ERROR]`. opencode-web-4097.ps1 now passes `--log-level DEBUG` to the `opencode web` invocation. Post-restart log (`2026-04-25T051723.log`) shows DEBUG-level entries flowing where every prior log had zero. Args line in the log confirms: `args=["web","--log-level","DEBUG",...]`. |
| F4  | SHIPPED | (next commit) | — | probeOllamaPs() inside watchdog, fires once silence ≥ 30s, throttled to every 30s; on /api/ps unreachable returns reason='provider-unavailable' + aborts session |
| F5  | WONTFIX | (investigation 2026-04-25) | run_modwae52_unv2lt log + GET /session/:id probe | F5 hypothesised a session-level error field on `GET /session/:id` distinct from per-message `info.error`. Now that F3 enabled DEBUG logging, the actual evidence shows: (a) `GET /session/:id` response carries only `{id, slug, projectID, directory, title, version, summary, time}` — **no `error` field exists** (matches `OpencodeSession` type def in `lib/opencode/types.ts:14`); (b) every error in the debug log is either `service=server error= failed` (HTTP transport noise, empty content) or `service=session.processor session.id=<sid> messageID=<mid> error=<text>` — always tied to a `messageID`, surfaces as the per-message `info.error` we already track. The imagined gap doesn't exist. Coverage is already complete via per-message `info.error` (deriveSessionStatus), F1 silent-turn watchdog (90s WARN / 240s abort), and F2 log tail (transport errors → dev console). |
| F6  | VERIFIED | (config edit 2026-04-25) | 2026-04-25 restart (PID 26812) | `~/.config/opencode/opencode.json` nemotron-3-super:cloud `limit.context` bumped 131072 → 262144. Authenticated `GET /global/config` confirms server returns `nemotron-3-super:cloud → {context: 262144, output: 131072}`. |
| F7  | SHIPPED | (next commit) | — | postSessionMessageServer preflight: estimateTokens vs getModelContextLimit (cached opencode /model TTL=5m). Refuses ≥85%, WARN ≥60%. Only fires when opts.model is set — agent-default path is unchecked because we don't know the resolved modelID at dispatch time |
| F8  | SHIPPED | (next commit) | — | RunHealthChip in swarm-topbar.tsx: aggregates ticker stopReason + retry-exhausted board items into green/amber/red dot + tooltip breakdown. "sessions silent > 60s" + "last opencode error" deferred — F1 watchdog logs WARN to dev console, F2 tail surfaces opencode errors there |
| F9  | SHIPPED | c041edd | — | board-rail.tsx renders ↻N amber chip on rows with [retry:N] notes (Phase 0.4) |

## 5 · Cross-references

- `STATUS.md` §Queued — mirror of fix queue with effort estimates
- `memory/feedback_probe_before_blame.md` — the corrective lesson
- `memory/reference_opencode_zombie_messages.md` — prior art on the
  "no completed, no error" zombie case that F1 specifically targets
- `memory/reference_opencode_4097_launcher.md` — where the launcher
  script (relevant to F3) lives

## 6 · Baseline signals (for future regression comparison)

The "before" signals for this run, recorded so future runs can be
compared against the improvement:

| Signal | Value (this run) | Target (post-fixes) |
|---|---|---|
| Time-to-first-observable-signal after dispatch | ∞ (only 15-min timeout) | ≤ 90s (F1) |
| Opencode errors visible in dev console | 0 | all non-filewatcher entries (F2) |
| Session lifecycle events in opencode log | 0 (default log level) | > 0 per run (F3) |
| Provider-unavailable detection latency | never detected | ≤ 30s (F4) |
| Assistant-silent chip in UI | absent | visible within 60s (F8) |
| Prompt-size preflight failures | 0 checked | refuse at >85% limit (F7) |
