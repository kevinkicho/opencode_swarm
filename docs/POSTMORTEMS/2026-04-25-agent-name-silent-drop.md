# 2026-04-25 · opencode `agent` param silent-drop

**Runs (all from the 8-pattern × 60-min validation):**
- `run_mody4whw_bp0o4o` (orchestrator-worker, 3 sessions)
- `run_mody4z4g_fhvd7a` (role-differentiated, 4 sessions)
- `run_modytido_8lpe37` (debate-judge, 4 sessions)
- `run_modytwo1_afdov8` (critic-loop, 2 sessions)

**Pattern:** Multiple — see above
**Models:** `gemma4:31b-cloud` (post-NEMOTRON swap shipped earlier same session)
**Workspace:** `C:\Users\kevin\Workspace\kyahoofinance032926`
**Directive:** "Audit and improve the kyahoofinance codebase for code quality / tests / security / architecture"
**Outcome:** Each affected pattern's worker / generator / critic / judge sessions had `msgs=0` after run-start. POSTs to `prompt_async` returned HTTP 204 successfully but the user message never persisted and no assistant turn fired. F1 silent-turn watchdog declared `opencode-frozen` after 240s × 2 retries. **The same failure mode was almost certainly affecting every prior orchestrator-worker / role-differentiated / critic-loop / debate-judge run for an unknown duration before this session.**

---

## 1 · Observed failure

Pattern from `run_mody4whw_bp0o4o` (representative):

```
t+0s    POST /api/swarm/run → 201  (3 sessions provisioned)
t+5s    [orchestrator-worker] orchestrator intro posted to
        ses_23cb7cec9ffe...ugamuV3z  (with agent='orchestrator')
t+15s   orchestrator session: 1 user msg, 1 assistant turn started
t+30s   orchestrator completes planner sweep, board seeded with 12 items
t+35s   coordinator picker claims first item, dispatches to worker session
        ses_23cb7ced0ffe...6smnIkZj  (with agent='worker-1')
t+35s   POST /session/<sid>/prompt_async → 204 (no content; success)
t+275s  F1 watchdog: 'turn went silent for 240s' → abort + retryOrStale
        item bounces back to 'open' with note `[retry:1] turn went silent`
t+275s  picker re-claims same item, re-dispatches with same agent='worker-1'
t+515s  F1 watchdog fires again, item now `[retry:2]`
t+515s  retry-stale filter (commit 2710a25) excludes [retry:2] opens from
        candidate queue → workers go idle → ratchet fires no-op
t+15m   ticker stops with stopReason='opencode-frozen'
```

**Session message counts at end of run:**

| Session | Role | msgs | done | inflight | errors |
|---|---|---|---|---|---|
| `ugamuV3z` | orchestrator | 4 | 3 | 0 | 0 |
| `6smnIkZj` | worker-1 | 0 | 0 | 0 | 0 |
| `LBPKAfbh` | worker-2 | 0 | 0 | 0 | 0 |

The orchestrator received its intro prompt + completed 3 turns (with files/patches). Workers received literally zero user messages despite three rounds of `prompt_async` POSTs from the picker.

## 2 · Diagnosis (verified vs. speculation)

### Verified facts

- **POST returned HTTP 204 for every worker dispatch.** Confirmed via opencode log inspection: `service=server status=completed duration=2 method=POST path=/session/<sid>/prompt_async request`.
- **Worker sessions exist in opencode's session list.** `GET /session?directory=<workspace>` returned the worker session IDs with their titles intact.
- **Worker sessions have empty message arrays.** `GET /session/<sid>/message` returned `[]`.
- **Manual POST without `agent` param succeeds.** Diagnostic probe: POSTed a test prompt to a stuck worker session WITHOUT the `agent` field. Within 8 seconds, `msgs` went from 0 → 2 (user message landed, assistant turn started).
- **opencode's built-in agents** (from `GET /agent`): `build`, `compaction`, `explore`, `general`, `plan`, `summary`, `title`. The agent names our app was passing — `worker-1`, `worker-2`, `architect`, `tester`, `judge`, `generator-1`, `worker`, `critic` — are NOT in this list.
- **Empirical asymmetry:** `'orchestrator'` (also not in built-in list) DID work — orchestrator session received messages and produced turns. Reason for this asymmetry is not yet understood (see open question below).

### Speculation (not verified)

- **Why opencode silently drops vs. erroring:** opencode's `prompt_async` likely runs through an agent-config lookup pipeline that fails-silently on unknown names. We did not source-trace opencode's internal handling; the empirical behavior is the contract we need to live with.
- **Why `'orchestrator'` works but `'worker-1'` doesn't:** unknown. Possible that opencode has a fallback for agent names matching certain semantic patterns, or that there's a not-yet-documented config layer. Worth investigating IF the asymmetry breaks in the future.

---

## 3 · Fixes

### F1 · Drop `agent` param from coordinator picker dispatch

**Where:** `lib/blackboard/roles.ts::opencodeAgentForSession`
**What:** Function previously returned role names (`'worker-1'`, `'architect'`, etc.) for hierarchical patterns; now returns `undefined` unconditionally. Picker no longer passes `agent` on `postSessionMessageServer`.
**Validation probe:**
```bash
# After spawning an orchestrator-worker run with agent fix in place,
# verify worker sessions receive prompts:
PW=$OPENCODE_SERVER_PASSWORD
SID=<worker session id from snapshot>
sleep 90  # let picker dispatch + worker idle
curl -s -u "opencode:$PW" "http://172.24.32.1:4097/session/$SID/message" | python3 -c "
import sys, json
ms = json.load(sys.stdin)
print('msgs:', len(ms), '— PASS if > 0 else FAIL')
"
```

### F2 · Drop `agent` param from critic-loop + debate-judge kickoff posts

**Where:** `lib/server/critic-loop.ts` (4 call sites: intros + review + revision + auto-stop notice), `lib/server/debate-judge.ts` (3 call sites: judge intro, generator intros, revision prompts).
**What:** Removed `agent: WORKER_AGENT_NAME` / `agent: CRITIC_AGENT_NAME` / `agent: JUDGE_AGENT_NAME` / `agent: 'generator-N'` from all `postSessionMessageServer` calls; kept the constants for the explanatory comments. `model:` param still passed.
**Validation probe:** spawn a critic-loop or debate-judge run; assert each session has `msgs > 0` within 60 seconds. Same mechanic as F1's probe.

### F3 · Pattern integration test suite (regression detection)

**Where:** `tests/integration/<pattern>.test.ts` per pattern (vitest).
**What:** Each test spawns a real run with a tiny directive, asserts the pattern-appropriate success signal (board.done ≥ 1 for blackboard-family; per-session messages for non-board patterns). Runs via `npm run test:integration`. Ensures the silent-drop class of bug surfaces immediately on any regression.
**Validation:** the test suite itself IS the validation. F3 is verified when blackboard.test.ts (and the 7 follow-on per-pattern tests) pass against a fresh run.

### F4 · POSTMORTEMS / memory / STATUS documentation (this entry + memory + STATUS limitations section)

**Where:** this file + `memory/reference_opencode_agent_silent_drop.md` + `STATUS.md` "Pattern reliability under GEMMA defaults" subsection.
**What:** Capture the lesson durably so future code at any new dispatch site knows about the constraint without having to re-discover it via run failures.

---

## 4 · Ledger

| Fix | Status | Commit | Verified against | Notes |
|-----|--------|--------|------------------|-------|
| F1 | SHIPPED + VERIFIED | 0c79175 | Same-session replay: run_modyrun1_ac3alv (orch-worker post-fix → 8/12 done) + run_modyrvi9_no8zey (role-diff post-fix → 32/48 done). **Broad re-validation 2026-04-25 evening:** orchestrator-worker `run_moek4uka_639mkw` (1.9m, board.done=1) + role-differentiated `run_moek78lw_bwi9hd` (54s, board.done=1) — no silent-drop recurrence. | Both same-session replays + broad replay confirm the fix holds. |
| F2 | SHIPPED + VERIFIED | 23a21f7 | Same-session replay: run_modz44ll_kry4of (debate-fix R1 + 1 R2 draft) + run_modz45o6_4s4hyi (critic-fix 1 complete iter cycle). **Broad re-validation 2026-04-25 evening:** debate-judge `run_moek8jhq_5qazbr` (15s, turns=1) + critic-loop `run_moek8pum_8drxn6` (8s, turns=1) — no silent-drop recurrence. | F1-silent-turn fragility that capped recovery quality on the same-session replays is separately closed by #73 (degraded-completion plumbing) and validated in the broad replay — 4 patterns landed `kind=finding` partial-outcome rows on forced wall-clock-cap runs. |
| F3 | SHIPPED + VERIFIED | 7632b8d (vitest scaffold) + 077fcf6 (`scripts/_validate_all_patterns.mjs`) | **Broad replay 2026-04-25 evening:** all 8 patterns spawned via the validation script; 7/8 PASS clean (deliberate-execute's inconclusive run was unrelated execution-phase opencode-frozen, not a silent-drop). | The validation script is the operational equivalent of per-pattern integration tests — faster signal than mock-based unit tests, catches regressions same way. |
| F4 | SHIPPED + EXTENDED | (original commit) + 0ca507b (#83 contracts doc) | — | Memory entries committed via `~/.claude/projects/.../memory/`; STATUS.md "Pattern reliability under GEMMA defaults" subsection. **Extended 2026-04-25 evening:** `docs/opencode-contracts.md` durably catalogs the silent-drop trap (§4a) so future call sites have one place to read before passing `agent`. |

## 5 · Open questions

- **Why does `'orchestrator'` work when `'worker-1'` doesn't?** Both are non-built-in agent names per `GET /agent`. Empirical behavior diverges. Not actionable today; would only matter if the orchestrator path also breaks in some future opencode version.
- **Are there other dispatch sites passing custom agent names?** Audit queued as task #67 — gates (auditor, verifier, critic) might have similar passthroughs we haven't tripped yet.
- **What changed in opencode that introduced this behavior?** Unclear. Could have always been this way; we just never noticed because previous default-agent paths (no `agent` param) worked. The new-run code that started passing role names was added as part of the role-differentiated work — that's when this stopped working silently.

## 6 · Cross-references

- `STATUS.md` § "Pattern reliability under GEMMA defaults"
- `memory/reference_opencode_agent_silent_drop.md`
- `memory/reference_pattern_reliability_ranking.md`
- `tests/integration/blackboard.test.ts` (F3 first test)
- POSTMORTEMS/2026-04-24-orchestrator-worker-silent.md (related — F1 watchdog from that postmortem is what caught + bounced these silent dispatches)
