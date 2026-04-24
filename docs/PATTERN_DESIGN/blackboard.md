# Pattern: blackboard

**Status:** mature — the only pattern partially validated in real runs
**Session topology:** 1 planner (session 0) + N workers (sessions 1..N)
**Observability maturity:** high (board-rail, heat-rail, ticker); gap on criterion verdicts and CAS drift

## 1 · Mechanics

A shared SQLite board (`.opencode_swarm/blackboard.sqlite`) is the
coordination surface. Every session reads and writes the same board.

- **Items:** five `kind`s on each row — `todo`, `claim`, `question`,
  `finding`, `criterion` (`lib/blackboard/types.ts:40-50`). Six
  statuses — `open`, `claimed`, `in-progress`, `done`, `stale`,
  `blocked`.
- **Planner (session 0):** role-label only. Holds the tool that emits
  `todowrite` payloads → parsed into board rows by the planner sweep
  (`lib/server/blackboard/planner.ts`). Re-sweeps fire on auto-idle
  (tier escalation) or on the periodic-sweep cadence when configured.
- **Workers (sessions 1..N):** the coordinator's tick picks an open
  todo per idle session and posts it as a prompt with the
  `[owner:<sessionID>]` tag so opencode attributes the work
  (`lib/server/blackboard/coordinator.ts`).
- **Claim flow:** atomic CAS transition open→claimed→in-progress. Only
  one session wins per tick per item.
- **CAS drift:** each todo declares `expectedFiles[]` with SHAs
  captured at claim time. On commit, the coordinator re-hashes those
  files; if any non-self path moved, the item is marked `stale` with
  note `[cas-drift:<path>]` (`lib/blackboard/types.ts:65-101`).
- **Retry budget:** `MAX_STALE_RETRIES = 2`
  (`lib/server/blackboard/coordinator.ts:179`). After that, item stays
  stale. Today this produces the exact failure mode observed on
  `run_mob31bx6_jzdfs2`: 6 items at `[retry:2]` that never recover.
- **Auto-ticker:** 10s tick cadence, per-session fan-out
  (`lib/server/blackboard/auto-ticker.ts`). Zombie detection at 10 min
  staleness. Liveness probe detects frozen-opencode + zen-rate-limit.
  Stop reasons: `manual`, `auto-idle`, `hard-cap`, `zen-rate-limit`,
  `opencode-frozen`, `run-end`.
- **Critic gate (opt-in):** `enableCriticGate` + `criticSessionID`. On
  each done-transition, the critic reviews the work for
  SUBSTANTIVE / BUSYWORK. BUSYWORK verdicts preserve the item as
  `stale` (`lib/server/blackboard/critic.ts`).
- **Auditor (opt-in):** `enableAuditorGate` + `auditorSessionID`.
  Periodic batch review of `criterion` items → verdicts `met` / `unmet`
  / `wont-do` / `unclear` (`lib/server/blackboard/auditor.ts`).
- **Verifier (opt-in):** `enableVerifierGate` + `verifierSessionID`.
  For items with `requiresVerification=true`, a Playwright-capable
  session checks user-observable outcomes against
  `workspaceDevUrl` (`lib/server/blackboard/verifier.ts`).
- **Ambition ratchet:** on tier escalation, planner gets a
  higher-stakes sweep prompt. MAX_TIER re-sweeps at the top instead of
  stopping.

## 2 · Signals already emitted

- `BoardItem.status` — the item lifecycle state
- `BoardItem.kind` — includes `criterion` for auditor-tracked
  contracts
- `BoardItem.note` — carries retry tags (`[retry:N]`), cas drift
  (`[cas-drift:<path>]`), critic verdicts, verifier verdicts
- `BoardItem.ownerAgentId` — current claimant
- `BoardItem.expectedFiles[]` + `fileHashes[]` — CAS anchoring state
- `BoardItem.requiresVerification` — Playwright gate needed
- `BoardItem.createdAtMs` / `updatedAtMs` — timing
- `TickerSnapshot.currentTier` — ambition-ratchet tier
- `TickerSnapshot.stopReason` + `retryAfterEndsAtMs` — why the ticker
  stopped; for zen-rate-limit, when quota resets
- FileHeat (stigmergy overlay — see `stigmergy.md`)
- Diff stats per item (from opencode's patch parts, aggregated at
  `expectedFiles` granularity)

## 3 · Observability surface

### Existing
- `components/board-rail.tsx` — grouped by status, collapsible done
  section, retry-stale action button, ticker state footer.
- `components/plan-rail.tsx` — flat plan-focused view.
- `components/heat-rail.tsx` — stigmergy signal overlay.
- `components/ticker-chip.tsx` — compact running/idle/stopped
  indicator in the topbar.

### Proposed — `contracts` tab

**Scope:** visible when `pattern === 'blackboard'` (and whenever a
hierarchical pattern with auditor role is present). Placed as a tab
in the left-panel tab group alongside `board` / `plan` / `heat`.

**Layout:** dense table, h-5 rows, monospace, tabular-nums. Columns:

| col | content | width |
|---|---|---|
| glyph | `◆` for criterion, `●` for todo with requiresVerification | 16px |
| label | item text (criterion content or todo title) | flex |
| files | expectedFiles count or — | 32px |
| drift | `—` / `cas-drift:<file>` chip (amber) | 90px |
| critic | `—` / SUB / BUSY chip (mint / rust) | 48px |
| verif | `—` / PASS / FAIL / … chip (mint / rust / fog) | 48px |
| audit | `—` / MET / UNMET / WONT / ? chip (mint / rust / fog / amber) | 48px |
| retry | `0/2` tabular-nums; amber when ≥1, rust when 2 | 32px |
| owner | accent dot + glyph or — | 24px |

**Header chips (sticky):**
`N/M met` · `K unmet` · `S stale` · `B busywork` · `D drift`.

**Sorting:** `in-progress` first, then `open` (retry desc, then
oldest first), then `stale`, then `done`, then criterion `unmet`
before `met`. User can click a header chip to filter.

**Empty state:** `no contracts yet — planner hasn't seeded criteria`
if the run has 0 criterion items; `no gated items` if no critic /
verifier / auditor gates enabled.

**Interaction:** row click opens the full item in the inspector
drawer (reuse the existing pattern).

**Aesthetic:** micro-labels on chips (10px uppercase tracking-widest2),
no icon overload — text-first. Rust used sparingly; amber is the
default "warning" tone so red only appears on true failures.

## 4 · Mechanics gaps

### I1 · Auto-replan on CAS drift

Today a stale item waits for the next planner sweep to be regenerated.
Under file contention, sweep latency can be several minutes. The
coordinator already detects drift on commit — it can post a focused
"re-plan in light of X moved" prompt to the planner session
immediately, seed a replacement todo, and move on. Cuts latency on
file-contention scenarios where two workers touch overlapping files.
Owner: coordinator.ts replan path.

### I2 · Retry-exhausted ratchet re-kick

`run_mob31bx6_jzdfs2` exhibited this: 6 items at `[retry:2]`, ticker
went idle, ratchet never escalated. The work-available check sees
them as `open`, not stale. Patch the escalation predicate to treat
`[retry:2]` open items as non-work-available so the ratchet fires,
and have the tier-up planner prompt reference the stuck item
explicitly ("rephrase this stuck contract at a higher tier").

### I3 · Persist ticker `stopReason`

The `getTickerSnapshot` cache is in-memory only. On dev-restart the
reason is lost and the UI reports `state: "none"`. Persist the final
snapshot in SQLite on `stopAutoTicker` firing so GET can reconstruct
"stopped, reason=X, at=Y." Paired with F4 on the postmortem ledger.

### I4 · Criterion authoring preflight

Planner can emit a criterion whose `content` is vacuous ("Make the
app better"). Auditor then reports UNCLEAR forever. Add a
preflight validator on planner output: criterion text must be
≥20 chars and contain at least one concrete noun + verifiable
condition clause. Reject silently and log WARN; let the planner try
again on next sweep.

## 5 · Ledger

| ID | Kind | Status | Commit | Verified against | Notes |
|---|---|---|---|---|---|
| contracts-tab | tab | SHIPPED | (next commit) | — | wired into LeftTabs; visible only when `boardSwarmRunID` is set; renders ContractsRail with sticky header chips + sorted item rows. ~3 h actual. To verify: load any blackboard run, switch to "contracts" tab, confirm met/unmet/stale/busy/drift chips reflect actual data. |
| I1 | improvement | PROPOSED | — | — | backend ~2–4 h |
| I2 | improvement | SHIPPED | (next commit) | — | runPeriodicSweep activeCount predicate now excludes open items with [retry:N≥2] notes via isRetryExhausted helper — workers-refused-twice items don't block ratchet escalation |
| I3 | improvement | SHIPPED | (next commit) | — | new ticker_snapshots SQLite table (PRIMARY KEY swarm_run_id) + persistTickerSnapshot in stopAutoTicker + readTickerSnapshot fallback in getTickerSnapshot; UI keeps the original stop reason after dev restart / HMR |
| I4 | improvement | SHIPPED | (next commit) | — | isViableCriterion preflight in runPlannerSweep: rejects content < 20 chars OR matching `^(make/improve/polish/...) X better/good/...$` shape; logs WARN per drop, planner can re-emit on next sweep |

## 6 · Cross-references

- `SWARM_PATTERNS.md` §1 — blackboard stance
- `lib/server/blackboard/` — planner, coordinator, auto-ticker, critic,
  auditor, verifier
- `lib/blackboard/types.ts` — BoardItem schema
- `docs/POSTMORTEMS/2026-04-24-orchestrator-worker-silent.md` —
  observability gaps shared with this pattern's I3
- `memory/project_blackboard_parallelism.md` — per-session tick
  fan-out shipped 2026-04-22
- `memory/project_council_shape.md` — auto-rounds shape
