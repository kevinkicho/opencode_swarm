# Validation runbook

Features that shipped but haven't been exercised against a real run.
This document is the "how do I actually verify X works?" companion to
STATUS.md's **Validation debt** section — each entry includes setup,
invocation, and the concrete signal that separates pass from fail.

Run these against the real opencode at `OPENCODE_URL` and a real
workspace. Smoke scripts in `scripts/_*.mjs` hit the same endpoints
the browser does; nothing here requires a new sandbox.

---

## 1. Playwright verifier gate

**What it does.** When a run sets `enableVerifierGate: true` + a
`workspaceDevUrl`, todos the planner prefixes with `[verify]` route
through a dedicated opencode session that calls `npx playwright`
against the running target app. `NOT_VERIFIED` verdicts bounce the
item back to `stale` so a worker retries with the failure log.

**VALIDATED 2026-04-26** — run_moez4chh_xo7rnm against
kyahoofinance032926's live Vite dev server with
`enableVerifierGate: true` + `enableCriticGate: true`, 6 sessions,
30min cap. All three observables fired:

| Observable | Result |
|---|---|
| Planner emits `[verify]` prefix on UX todos | 11/23 items had `requiresVerification: true` |
| Verifier composes Playwright via bash | Real `playwright.chromium.launch()` scripts hitting localhost:5173 |
| `[verifier-rejected]` notes flow back to stale | 7 items with concrete rejection reasons |

Example verifier-rejected rejections (real output, not synthetic):
- "The correlations bento panel and ECharts heatmap were not detected on the page."
- "No indicators of supply/demand data, surpluses, or deficits were found on the page."

7 critic-rejected items also landed in parallel — the critic and
verifier gates run together correctly without stepping on each other.

**Setup (one-time).**
1. Pick a target repo with a runnable dev server (the kyahoofinance
   repo works — `npm run dev` on port 3000).
2. Ensure Playwright is installed in the target repo: `npx playwright
   install chromium`.
3. Start the target dev server in a separate shell: `cd <repo> && npm
   run dev`. Note the port (default 3000).

**Re-validation invocation.**
```bash
curl -X POST http://localhost:<this-app-port>/api/swarm/run \
  -H 'Content-Type: application/json' \
  -d '{
    "pattern": "blackboard",
    "workspace": "/abs/path/to/target/repo",
    "directive": "Verify the README claims render in the dashboard and fix any gaps.",
    "teamSize": 3,
    "enableVerifierGate": true,
    "workspaceDevUrl": "http://localhost:3000"
  }'
```

**Pass signals (watch the run in the UI or tail logs):**
- Planner todos with user-observable claims carry the `[verify]`
  prefix; `latestTodosFrom` strips it and sets `requires_verification=1`
  on those board rows.
- On a verify-flagged todo completion, the coordinator posts a
  `verifier` prompt to `meta.verifierSessionID` after the critic gate
  approves.
- Verifier session responds `VERIFIED` / `NOT_VERIFIED` / `UNCLEAR`.
- `NOT_VERIFIED` → item flips to `stale` with note
  `[verifier-rejected] ...`; worker picks it up on next tick.
- `VERIFIED` / `UNCLEAR` → item transitions to `done` (UNCLEAR is
  fail-open — verifier malfunction shouldn't block progress).

**Fail signals.**
- Planner never emits `[verify]` prefixes → prompt didn't land, check
  `buildPlannerPrompt` path.
- Verifier session spawned but never receives a prompt → coordinator
  isn't reading `meta.verifierSessionID`, check
  `lib/server/blackboard/coordinator.ts` around the post-critic
  section.
- Verdicts are always `UNCLEAR` → check verifier prompt framing +
  Playwright installation in the target repo.

**Artifacts.** The verifier session's transcript (opencode's own UI)
shows every `npx playwright` invocation and its stdout. That's the
ground truth when verdicts look off.

---

## 2. Pattern benchmark script

**What it does.** `scripts/_pattern_benchmark.mjs` runs the same
directive through multiple patterns sequentially and reports
wall-clock / tokens / cost / commit count per pattern. Answers "is
pattern X worth its cost premium over pattern Y on this kind of work?"

**VALIDATED 2026-04-26** — invoked with `scripts/_pattern_benchmark.mjs
--workspace ... --patterns blackboard --max-done 1 --max-minutes 3`.
Script ran end-to-end: spawned a swarm run, polled progress with
timestamps every ~15s, hit max-minutes terminal correctly, produced
the comparison table, persisted JSON to
`/tmp/pattern-benchmark-<ts>.json`. The 0-done result is expected for
the tight 3-minute cap; the script MACHINERY works.

**Setup.** Start the Next.js dev server. Ensure `OPENCODE_URL` points
at a live opencode. Pick a target workspace.

**Re-validation invocation.**
```bash
node scripts/_pattern_benchmark.mjs \
  --workspace /abs/path/to/target/repo \
  --directive "Improve test coverage on the data layer." \
  --patterns blackboard,council,map-reduce
```

**Expected cost.** ~$12 and ~1 h wall-clock for the default 3-pattern
run on a moderately-sized repo. Budget more if you add `deliberate-
execute` (has a 15-min turn ceiling vs 10-min default).

**Pass signals.**
- Every pattern completes (status `idle`, not `error` or `stale`).
- Output table has numbers in every column.
- Cost deltas follow intuition (e.g., council ≥ blackboard on the same
  directive because it runs N drafts in parallel).

**Fail signals.**
- One pattern times out or returns zero commits → orchestrator has a
  real bug; don't ship.
- Costs are wildly different from estimate (>3× off) → pricing
  table in `lib/opencode/pricing.ts` drifted or the pattern is picking
  a different model than expected.

---

## 3. Ambition-ratchet tier 2+ escalation

**What it does.** When a ticker-driven pattern drains its board and
would auto-idle-stop, the auto-ticker instead fires an escalation
sweep at the next tier (Polish → Structural → Capabilities → Research
→ Vision; `MAX_TIER = 5`). Stops only when every tier returns empty.

**Why not yet validated.** Every run so far either:
- hit Zen quota before draining (ticker stopped before escalation),
  or
- had a broad enough directive that tier-1 work hadn't drained yet.

**Setup.** Use a smaller, well-scoped target (e.g. a small utility
repo) with a narrow directive so tier 1 drains quickly.

**Invocation.**
```bash
curl -X POST http://localhost:<port>/api/swarm/run \
  -H 'Content-Type: application/json' \
  -d '{
    "pattern": "blackboard",
    "workspace": "/abs/path/to/small/repo",
    "directive": "Fix the listed bugs in KNOWN_LIMITATIONS.md.",
    "teamSize": 2,
    "persistentSweepMinutes": 15
  }'
```

**Pass signals.**
- Board drains (all items `done` or `stale`).
- `TickerSnapshot.currentTier` advances 1 → 2 visibly in the UI tier
  chip.
- Log line `[board/auto-ticker] ... tier escalation 1→2`.
- Meta.json persists the new `currentTier` (check with
  `cat .opencode_swarm/runs/<id>/meta.json | jq .currentTier`).

**Fail signals.**
- Board drains but ticker enters `stopped · auto-idle` instead of
  escalating → `attemptTierEscalation` didn't fire, check
  `consecutiveDrainedSweeps` counter.
- Escalation fires but planner emits tier-1 todos anyway → prompt's
  tier ladder isn't strict enough; tighten in `buildPlannerPrompt`.
- Tier regresses after restart → `updateRunMeta` write failed
  silently, check for a `teamRoles persist failed` log line.

---

## 4. Non-ticker patterns — real-repo load test

**What it does.** Council, map-reduce, debate-judge, critic-loop all
typecheck and each has its own orchestrator module. None has been
driven through a real repo to completion.

**Invocation (one per pattern).**
```bash
# Council (3 parallel drafts, human reconciles)
curl -X POST .../api/swarm/run -d '{
  "pattern": "council", "workspace": "...", "teamSize": 3,
  "directive": "Propose three architectures for ..."
}'

# Map-reduce (3 slices, 1 synthesis)
curl -X POST .../api/swarm/run -d '{
  "pattern": "map-reduce", "workspace": "...", "teamSize": 3,
  "directive": "Survey and synthesize ..."
}'

# Debate-judge (3 generators + 1 judge)
curl -X POST .../api/swarm/run -d '{
  "pattern": "debate-judge", "workspace": "...", "teamSize": 4,
  "directive": "Pick the best API shape for ..."
}'

# Critic-loop (1 worker + 1 critic)
curl -X POST .../api/swarm/run -d '{
  "pattern": "critic-loop", "workspace": "...", "teamSize": 2,
  "directive": "Draft and refine the documentation for ..."
}'
```

**Pass signals.** Each kickoff completes without unhandled promise
rejection; each pattern's expected UI strip (`SynthesisStrip`,
`ReconcileStrip`, `JudgeVerdictStrip`, `CriticVerdictStrip`) renders
with live data; the run ends with status `idle` via
`finalizeRun`-driven session cleanup.

**Fail signals.**
- Kickoff throws and the run stays `live` forever with no activity →
  an unhandled rejection in the orchestrator; add a try/finally with
  `finalizeRun` if missing.
- Verdict strips empty → the parsers (`APPROVED:` / `REVISE:` for
  critic, `WINNER` / `MERGE` / `REVISE` for debate) didn't match the
  generator's output. Parsers are forgiving but require the token on
  a line by itself.

---

## 5. Overnight-safety stack end-to-end

**What it does.** Sum of every reliability layer: zombie auto-abort,
per-pattern turn timeout, eager re-sweep, periodic planner sweep,
opencode-frozen watchdog, Zen rate-limit probe, HMR-resilient exports,
ChunkLoadError auto-reload, session cleanup on every stop path.
Individual pieces are validated; the full stack working together over
a long continuous run is not.

**Setup.** Pick a substantial target repo (the app itself works —
eat your own dog food). Set a broad directive so the run can't drain
quickly. Start when you have ~8 hours available to let it run and
watch the end.

**Invocation.**
```bash
curl -X POST .../api/swarm/run -d '{
  "pattern": "blackboard",
  "workspace": "/abs/path/to/large/repo",
  "directive": "Survey the README claims end-to-end and deliver the unshipped ones.",
  "teamSize": 4,
  "persistentSweepMinutes": 20,
  "enableCriticGate": true
}'
```

**Pass signals (after ~8 h).**
- Run progressed past tier 1 (see §3 above).
- At least one `[retry:N]` note on a stale item showing zombie-abort
  fired at least once.
- No run-ending errors in logs.
- Final state: `idle` or `stopped · zen-rate-limit` with a parsed
  retry-after window.
- Target repo has a meaningful set of commits (not 3, not 300 — dozen
  to a few dozen, unless the directive demands otherwise).

**Known quota cliff.** On the Zen free tier, expect to hit a 429 wall
within ~35 min of continuous operation. The watchdog should detect
this and surface `stopReason: 'zen-rate-limit'` with the parsed
`retry-after`, not a generic `opencode-frozen`. If it comes back as
`opencode-frozen`, grep the opencode log for `statusCode":429` — if
there are 429s, the Zen probe didn't find them and
`OPENCODE_LOG_DIR` is likely misconfigured.

---

## 6. Ollama tier — code-level invariants

**What it does.** Locks in the 2026-04-24 three-tier reversal at the
Next.js layer: `providerOf()` buckets ollama correctly, `priceFor()`
returns 0 for all 5 `ollama/*:cloud` model IDs without cross-
contaminating the zen pricing rows (e.g. `ollama/kimi-k2.6:cloud` must
not hit the zen `kimi-k2-6` row and get charged per-token — the
`LOOKUP` reorder is the guard, this test locks it), both catalogs
carry all 5 entries with the right provider/family/pricing shape.

**Invocation.**
```bash
npx tsx scripts/_ollama_smoke.mjs
```

**Pass signals.** All 55 assertions pass. Exits 0.

**Fail signals.** Most likely regressions:
- A new zen pricing row uses a pattern that matches `ollama/*:cloud`
  before the catchall hits → model gets per-token priced by mistake
- Someone removes a model from the catalog without updating the other
- `familyMeta['ollama']` accidentally dropped → modal picker crashes

**What this does NOT cover.** Actual dispatch through opencode to
ollama's cloud API. That needs §6.6 below — live-run validation with
opencode configured for the ollama provider.

## 7. Ollama tier — live dispatch (not yet exercised)

**What needs validating.** An actual run dispatching through an
`ollama/*:cloud` model. The Next.js layer is invariant-tested in §6.5;
what remains is verifying opencode correctly routes to the ollama
endpoint when given `ollama/glm-5.1:cloud` (etc.) as the model field.

**Setup (one-time).**
1. An ollama account with the max monthly plan active.
2. Configure `opencode.json` (or equivalent) with an `ollama` provider
   block that routes `ollama/*:cloud` model IDs to
   `https://ollama.com/api/chat` (or the current ollama cloud API
   endpoint). See the `ollama_swarm` sibling repo at
   `github.com/kevinkicho/ollama_swarm` for a working provider-block
   shape.

**Invocation.**
```bash
curl -X POST http://localhost:<port>/api/swarm/run \
  -H 'Content-Type: application/json' \
  -d '{
    "pattern": "blackboard",
    "workspace": "/abs/path/to/target/repo",
    "directive": "Smoke-test an ollama-dispatched run.",
    "teamSize": 2
  }'
```

Then pick `glm 5.1 (ollama)` or another `ollama` family model in the
new-run-modal (or include it in the team config).

**Pass signals.**
- First assistant turn lands within the normal window; tokens tick
  upward.
- UI provider badges show `ollama` (iris accent) on the roster rows.
- `GET /api/swarm/run/:id/tokens` returns non-zero `tokens` and
  `cost: 0` for ollama-tier sessions (subscription-bundled).
- Cost-dashboard / provider-stats popover shows an ollama row with
  calls > 0 and $0.

**Fail signals.**
- Opencode returns 404 / provider unknown → `opencode.json` isn't
  configured for ollama.
- Tokens stay at 0 past STARTUP_GRACE (15 min) → watchdog declares
  `opencode-frozen` or `zen-rate-limit`. Grep opencode's log for
  `ollama` to confirm the request even got routed there.
- Costs accumulate > $0 on ollama-tier sessions → LOOKUP reorder
  broke; re-run §6.5 smoke to pinpoint.

**This is the one live validation this session shipped without
exercising — feeding it to a real opencode + ollama is the first
natural opportunity.**

**Team-picker wiring status (2026-04-24).** As of this commit, the
new-run-modal team picker flows `teamModels: string[]` through to
every session's dispatch on the first turn (blackboard planner +
workers, and the directive broadcast for council / map-reduce).
Blackboard is FULLY WIRED — every worker dispatch from the
coordinator reads `meta.teamModels[sessionIdx]` and passes it as
`model` on `postSessionMessageServer`.

**Known limitation (follow-up):** non-ticker pattern orchestrators
(council.ts, map-reduce.ts, critic-loop.ts, debate-judge.ts,
orchestrator-worker.ts, role-differentiated.ts) do NOT yet read
`meta.teamModels` on their follow-up rounds. A
council run with an ollama team picks ollama for Round 1 (via the
route's directive broadcast) but Rounds 2 / 3 fall back to whatever
opencode selects per `postSessionMessageServer` without an explicit
`model`. Same for critic iterations, debate rounds, and the
orchestrator-worker intro. Tracked in STATUS.md; wiring is a
mechanical follow-up (each `postSessionMessageServer` call adds
`model: meta.teamModels?.[sessionIDs.indexOf(sid)]`).

## 8. Parser correctness (stripVerifyTag, stripRoleTag)

**What it does.** `latestTodosFrom` in `lib/server/blackboard/planner.ts`
strips leading `[verify]` / `[role:<name>]` prefixes from todo content
and routes them to `requiresVerification` / `preferredRole` on board
items.

**Invocation.**
```bash
node scripts/_parser_smoke.mjs
```

Runs a small in-process assertion suite over synthetic todowrite
messages. Exits 0 on pass, 1 on any assertion failure with a diff
printed.

**Pass signals.** All cases pass, including:
- Single-prefix: `[verify] …` / `[role:tester] …`
- Composed: `[verify] [role:tester] …`
- Case variants: `[VERIFY]`, `[Role: Tester]`
- Degenerate: empty role (`[role:]`) → ignored
- Pass-through: untagged content unchanged

**Fail signals.** A regex drift breaks composition order or case
insensitivity. Assertion messages name the failing case.

---

## How to add a new validation entry

When you ship a feature that can't be exercised without a real run,
add a section here with:
1. One-line description of what shipped.
2. Setup (env vars, external processes, target repos).
3. Invocation (curl / script command users can paste).
4. Pass signals — concrete observable outcomes.
5. Fail signals — what diverges and where to look.

Keep `STATUS.md`'s Validation debt list in sync: each item there
should point at a section here.
