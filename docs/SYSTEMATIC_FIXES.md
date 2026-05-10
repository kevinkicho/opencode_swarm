# Systematic Fixes — opencode_swarm

Design for three coordinated fixes targeting the root cause "unmanaged session
context." Written 2026-05-08 following strategic analysis in `docs/STRATEGY.md`.

---

## Root Cause

Every opencode session is a single accumulating chat transcript. opencode has
no concept of "this turn only" or "per-todo context." It appends. Forever.

- **Planner:** By sweep 5, re-reading 4 prior full conversations (~60-70% of
  token spend is accumulated history)
- **Worker:** By todo 3, 40K+ tokens of prior tool calls in context window
- **Board/patterns:** Fix the *what to work on* and *which topology* problems
  but not the *what the agent sees* problem

Three fixes form one architecture: the board becomes the source of truth for
**what** to work on, **where** to work on it, and **what context** the agent
sees.

---

## Fix 1: Per-Work-Unit Session Isolation (~2 days)

### Principle

An agent's context window should contain only the context for the current
work unit, never the history of prior work units.

### Current behavior

Workers reuse the same opencode session across all claimed todos. Todo 1's
file reads, tool calls, and reasoning accumulate. Todo 2 starts with all
of it. Todo N starts with N-1 todos' worth of irrelevant context.

The planner reuses `sessionIDs[0]` across all sweeps. Sweep 5's context
includes the full conversation history of sweeps 1-4.

### Fix

When a worker claims a todo via CAS (in `pickClaim`):

1. **Abort** the old opencode session via `abortSessionServer` (idempotent
   — no-op if idle; kills runaway token burn if a prior turn is stuck)
2. **Create** a fresh opencode session via `createSessionServer` in the same
   workspace
3. **Replace** the session ID in `meta.sessionIDs` at the agent's index
4. **Update** `updateRunMeta` with the new `sessionIDs` array
5. **Swap** the ticker's `PerSessionSlot` from old session ID to new session ID
6. **Post** the work prompt (`buildWorkPrompt(todo)`) as the first user
   message in the fresh session

The old session is abandoned — preserved in the L0 event log for audit but
never enters a future agent's context window. The fresh session gets exactly:
- The system prompt + tool definitions (opencode's default)
- The work prompt containing the todo content, `[files:...]` scope, any
  retry notes, and the current commit hash
- The assistant's response (tool calls + deliverables)

### Same mechanism for planner

When the planner re-sweeps (periodic or tier-escalation), it gets a fresh
session. No accumulated history from prior sweeps. The prompt carries the
current board state (already compressed via `buildPlannerBoardContext` with
8K-char budget).

### Token impact

For a 5-todo worker run:
- **Before:** ~200K tokens (all prior context accumulated)
- **After:** ~40K per todo (only current work unit)
- Per-todo cost is constant, not linear

For a 5-sweep planner run:
- **Before:** ~60-70% of each re-sweep's tokens are prior conversation
- **After:** Each sweep is a fresh ~15K prompt + board context

### Implementation surface

**New:** `lib/server/blackboard/coordinator/dispatch/claim-context.ts`
- `resetSessionForClaim(swarmRunID, oldSessionID, workspace): Promise<string>`
  — aborts old, creates new, updates meta + ticker, returns new session ID

**Modified:** `pick-claim.ts` (~15 lines)
- After CAS claim succeeds (`claimed → in-progress`), call `resetSessionForClaim`
- Store new session ID in `ClaimContext.sessionID`

**Modified:** `dispatch-prompt.ts` (~2 lines)
- Uses `ClaimContext.sessionID` (now the fresh session) — no code change needed
  since it already reads from context

**Modified:** `await-turn.ts` (~2 lines)
- Uses `ClaimContext.sessionID` (same)

**Modified:** `auto-ticker/tick.ts` (~10 lines)
- Export `replaceTickerSession(swarmRunID, oldSID, newSID)` for pick-claim
- Updates `state.sessionIDs[i]` and swaps `PerSessionSlot` entry

The existing mutex (`tickCoordinator` → per-session lock) serializes the
replace operation — no race between two parallel ticks on the same agent.

### Risk

- **Session creation latency** (~200-500ms per HTTP call to opencode) — adds
  to per-todo dispatch time. Mitigation: the abort+create runs before the
  work prompt post, which is already a blocking wait (15-min timeout). 500ms
  is negligible relative to the average turn time (30-120s).
- **Session ID churn** — `meta.json` is updated per claim. Not a concern at
  prototype scale (<100 claims per run). If needed, batch updates.
- **L0 event log fragmentation** — each claim creates a session that
  appears in the event log. This is a feature, not a bug: the session
  timeline becomes "one session per todo" which is more auditable.

---

## Fix 2: File-Level Claim Gating (~0.5 days)

### Principle

Two agents should never work on the same files simultaneously. The board's
`expectedFiles` field should be a coordination primitive, not just a planner
hint.

### Current behavior

The planner proposes `[files:src/auth.ts,src/login.ts]` as hints for dedup.
The coordinator ignores them at claim time. Agent A claims "refactor auth"
and agent B claims "add login tests" — both touch `src/auth.ts` — and they
race to commit. The CAS claim prevents them from claiming the *same todo*,
but nothing prevents them from claiming *different todos* that touch the
*same file*.

### Fix

A per-run `FileLockSet` — an in-memory `Map<swarmRunID, Map<string, Set<string>>>`
mapping `swarmRunID → file → set of in-progress todo IDs`.

In `pickClaim`, before the CAS claim:

1. Read the candidate todo's `expectedFiles`
2. If any expected file is already in the lock set (locked by another
   in-progress todo), the candidate is **skipped** (the agent picks the
   next open item instead)
3. If all files are free, the claim proceeds
4. After a successful CAS claim, add the todo's files to the lock set
5. When the todo is discharged (transitioned to `done` or `stale`), remove
   its files from the lock set

This is a **soft lock** — advisory, not transactional. Two agents can still
conflict if a todo has no `expectedFiles` (file scope unknown at claim time)
or if the planner omits a file from the scope. The soft lock handles the
common case (planner specifies files, workers claim atomically) without the
complexity of a real file-level transaction system.

**Skip escalation:** If all open todos have overlapping file scopes with
in-progress items (every candidate is locked), the pick falls through to
`skip: no claimable work`. The ticker treats this as an idle tick — correct
behavior: no agent can claim until in-progress work releases its files.

### Implementation surface

**New:** `lib/server/blackboard/coordinator/file-locks.ts`
- `FileLockSet` class with `acquire(swarmRunID, todoID, files)`, `release(swarmRunID, todoID)`, `isLocked(swarmRunID, files): boolean`
- `globalThis`-keyed singleton (survives HMR, shared across ticker restarts)

**Modified:** `pick-claim.ts` (~10 lines)
- Before CAS claim, check `isLocked(swarmRunID, candidate.expectedFiles)`
- If locked, skip candidate, continue to next in queue
- After CAS claim succeeds, call `acquire(swarmRunID, todo.id, todo.expectedFiles)`

**Modified:** `commit-done.ts` (~5 lines)
- After `in-progress → done` transition, call `release(swarmRunID, todo.id)`

**Modified:** `retry.ts` (~3 lines)
- When a todo goes stale, call `release(swarmRunID, item.id)` (same as done)

### Edge cases

- **Ticker restart:** The `FileLockSet` is derived from in-progress board
  items. On ticker boot, reconstruct the lock set from `listBoardItems`:
  every `in-progress` item's `expectedFiles` are locked.
- **Stale items with no explicit done transition:** The auto-ticker's
  `finalizeRetryExhaustedItems` already transitions retry-exhausted items
  to `stale`. The `retryOrStale` path is the release point.
- **Planner sweep adds items with overlapping files:** The planner dedup
  guard already prevents proposals that overlap with existing items. The
  file lock adds a second layer — even undetected proposals that pass
  dedup will be skipped at claim time.

---

## Fix 3: Pattern Contract Enforcement (~1.5 days)

### Principle

Every pattern has topological invariants. These should be asserted at
runtime, with recorded findings and graceful degradation paths. Currently
they're documentation in `docs/PATTERNS.md`.

### Current behavior

- Critic-loop is documented as "always 2 sessions." If the critic dies
  mid-run, the worker keeps going with no review.
- Orchestrator-worker: if the orchestrator dies, workers idle forever
  (they can't self-organize — the pattern doesn't support it).
- Debate-judge: if the judge dies, generators keep producing proposals
  that nobody evaluates.

### Fix

A `PatternGuard` interface per pattern:

```ts
interface PatternGuard {
  // Asserted once at kickoff (before auto-ticker starts)
  startupInvariant(meta: SwarmRunMeta): { ok: true } | { ok: false; reason: string };
  
  // Asserted every tick before fan-out
  runtimeInvariant(swarmRunID: string): { ok: true } | { ok: false; reason: string };
  
  // Called when a runtime invariant fails. Must always return (fail-open).
  // Returns a finding to record on the board.
  degrade(swarmRunID: string, brokenInvariant: string): Promise<{ finding: string }>;
}
```

Per-pattern guards:

| Pattern | Startup invariant | Runtime invariant | Degradation |
|---------|-------------------|-------------------|-------------|
| **critic-loop** | `sessionIDs.length === 2` | Critic session is alive (not errored/stale) | Auto-approve remaining iterations: worker output ships without review. Finding: `[pattern-guard] Critic session died — auto-approved remaining iterations` |
| **orchestrator-worker** | `sessionIDs.length >= 2` | Orchestrator (session 0) is alive | Promote first idle worker to orchestrator: replay directive, re-sweep. Finding: `[pattern-guard] Orchestrator died — promoted worker X to orchestrator` |
| **debate-judge** | `sessionIDs.length >= 2` | Judge (session 0) is alive; ≥1 generator alive | If judge dies: promote most-active generator to judge. If only 1 generator remains: auto-select its proposal. Finding recorded. |
| **blackboard** | Any sessions | Planner sweep errors → start ticker with salvageable items (already implemented — F1) | No additional guard needed — parallel-redundant pattern survives single-session failures natively |
| **council** | `sessionIDs.length >= 1` | ≥1 drafter alive | Auto-converge on remaining drafts (already implemented). Guard just records the finding. |
| **map-reduce** | Sessions exist | Synthesizer not silent | Retry with different session; after 2 failures, emit partial synthesis from completed mapper outputs. Finding recorded. |

### Integration into tick loop

In `tick.ts:fanout()`, before the per-session dispatch loop:

```ts
const guard = getPatternGuard(state.pattern);
if (guard) {
  const inv = guard.runtimeInvariant(state.swarmRunID);
  if (!inv.ok) {
    const { finding } = await guard.degrade(state.swarmRunID, inv.reason);
    insertBoardItem(state.swarmRunID, {
      id: mintItemId(),
      kind: 'finding',
      content: finding,
      status: 'open',
      createdAtMs: Date.now(),
    });
    // Degradation may have changed sessionIDs — re-check slots
    await ensureSlots(s);
  }
}
```

### Implementation surface

**New:** `lib/server/blackboard/pattern-guard.ts`
- `PatternGuard` interface + `getPatternGuard(pattern): PatternGuard | null`
- One guard implementation per pattern (in same file or per-pattern modules)

**Modified:** `auto-ticker/tick.ts` (~15 lines)
- Call `runtimeInvariant` before fan-out
- Call `degrade` on failure
- After degradation, re-check slots (degradation may promote/retire sessions)

**Modified:** Pattern kickoff files (~5 lines each)
- Call `startupInvariant` before `startAutoTicker`

### Design decisions

- **Fail-open:** Degradation always produces an outcome (finding + continue).
  A broken invariant never kills the run — it degrades to "partial results
  with documented reason." This matches the existing F1 fallback philosophy.
- **Recorded as findings:** Degradation events produce `kind='finding'` board
  items prefixed `[pattern-guard]` that surface in the contracts rail.
- **No rollback:** Degradation is forward-only. A promoted worker doesn't
  go back to being a worker. The finding is the audit trail.
