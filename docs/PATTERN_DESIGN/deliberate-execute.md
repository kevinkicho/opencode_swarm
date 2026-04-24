# Pattern: deliberate-execute

**Status:** shipped, unvalidated end-to-end (phases individually validated)
**Session topology:** N sessions. Phase 1 (Deliberation): all equal. Phase 2 (Synthesis): session 0 leads. Phase 3 (Execution): all equal, board-driven.
**Observability maturity:** low — board-rail shows deliberation round hint; no phase-transition timeline

## 1 · Mechanics

Compositional pattern. Runs council-style deliberation, extracts
todos via a synthesis prompt, then flips to blackboard execution on
the same session pool.

- **Phase 1 · Deliberation:** `runCouncilRounds` fires — identical
  mechanics to the `council` pattern. R1 → R2 → R3 by default.
  Every session produces a draft each round; R2+ embed all peer
  drafts.
- **Phase 1 → 2 boundary:** `waitForSessionIdle` on every session
  after R_max.
- **Phase 2 · Synthesis:** session 0 receives a synthesis prompt
  that embeds all final-round drafts and asks for 6-15 concrete
  todos via `todowrite`. Parsed via the standard planner-output
  path (`latestTodosFrom` in `lib/server/blackboard/planner.ts`).
- **Phase 2 → 3 boundary:** synthesis todos seeded on the blackboard.
- **Phase 3 · Execution:** `startAutoTicker` fires. Every session
  (including 0 this time) flips to worker mode and drains the board
  via normal blackboard mechanics (claim, CAS, critic/verifier
  gates if enabled).

## 2 · Signals already emitted

- Deliberation round count from `deliberationRoundInfo` in
  `lib/deliberate-progress.ts`
- Phase transition point when synthesis posts todos (board goes from
  0 items to 6-15)
- Synthesis prompt content (a re-usable artifact)
- Execution phase is identical to blackboard — full BoardItem
  lifecycle visible

What's NOT surfaced today:
- The point at which deliberation ended and execution started (user
  has to infer from the board emptiness → fullness transition)
- How long each phase took relative to the others
- Which deliberation drafts contributed most to the synthesized todos
  (traceability from phase 1 to phase 2 output)

## 3 · Observability surface

### Existing
- `board-rail` empty state says "deliberating — council is exchanging
  drafts before execution" + round count when `pattern ===
  'deliberate-execute'` and the board is still empty.
- No dedicated phase-transition surface.

### Proposed — `phases` tab

**Scope:** `pattern === 'deliberate-execute'`. Left-panel tab group.

**Layout:** three collapsible sections stacked vertically representing
the phases.

**§ PHASE 1 · DELIBERATION** — table, one row per round. h-5.

| col | content | width |
|---|---|---|
| round | `R1`, `R2`, `R3` | 24px |
| members | "N/M idle" | 48px |
| avg-len | avg draft length (tabular-nums) | 48px |
| convergence | chip (reused from council.md §3) | 48px |
| status | `pending` / `in-progress` / `done` | 64px |
| time | duration (tabular-nums `Xm`) | 40px |

**§ PHASE 2 · SYNTHESIS** — single row, h-6.

| col | content | width |
|---|---|---|
| label | "synthesis → todowrite" | 160px |
| owner | always session 0 | 32px |
| status | `pending` / `in-progress` / `done` / `stale` | 64px |
| output | "N todos" tabular-nums | 48px |
| time | duration | 40px |

**§ PHASE 3 · EXECUTION** — compact counters only, not a table.

- `N/M todos` · `K in-progress` · `S stale` · `D done` chips
- "jump to board tab" affordance (text button)

**Phase header chips:** current phase highlighted; completed phases
fog-muted; pending phases fog-darker.

**Transition banners (ephemeral):** when a phase boundary crosses,
surface a single-row iris banner for 20s: "Deliberation complete —
synthesizing 8 todos from 5 drafts" and "Synthesis complete —
execution started on 8 items."

**Empty states per section:** `awaiting R1` / `awaiting synthesis` /
`awaiting todos`.

## 4 · Mechanics gaps

### I1 · Synthesis-verifier gate

If phase-2 extracts poorly-scoped todos (too big, missing deps),
there's no way to revise without restarting the whole run. Add
optional `enableSynthesisVerifier`. After phase 2 seeds the board,
a dedicated auditor session scans the todos: "are these concrete,
claimable, and independent?" APPROVED → phase 3 starts. REVISE →
feedback posted to session 0 with "re-run todowrite given this
feedback" prompt; phase 2 loops (max 2 iterations).

### I2 · Traceability from phase 1 to phase 2

Each todo emitted in phase 2 could carry a `sourceDrafts: number[]`
tag listing which deliberation drafts influenced it. Requires the
synthesis prompt to ask for this explicitly + a parser in the
planner path. Enables "why does this todo exist?" lookups.

### I3 · Phase-3 work from phase-1 dissent

Today dissent in deliberation is lost once the synthesizer picks
its favored direction. If R2/R3 had a strong minority view,
consider seeding that as an additional todo ("evaluate approach B
as an alternative to approach A") for a researcher-type session to
work in parallel during phase 3. Requires convergence + dissent
detection (shared with `council.md` I3).

### I4 · Skip deliberation for simple directives

Small missions ("add a single route handler") don't benefit from 3
rounds of N-way deliberation — it burns tokens with no upside. Add
a directive-complexity classifier that can WARN "directive scope
looks small; consider using the `blackboard` pattern instead."
Don't auto-skip — keep as human signal.

## 5 · Ledger

| ID | Kind | Status | Commit | Verified against | Notes |
|---|---|---|---|---|---|
| phases-tab | tab | SHIPPED | (next commit) | — | three stacked sections: deliberation per-round members/avg-len/convergence/time, synthesis single row → todowrite, execution todo counters; phase-active banner via background tone shift; convergence inline-duplicated from council-rail (shared helper deferred) |
| I1 | improvement | PROPOSED | — | — | new verifier session + loop ~4 h |
| I2 | improvement | PROPOSED | — | — | synthesis prompt + parser ~3 h |
| I3 | improvement | PROPOSED | — | — | shared with council.md I3 |
| I4 | improvement | PROPOSED | — | — | classifier + WARN ~2 h |

## 6 · Cross-references

- `SWARM_PATTERNS.md` §9 — deliberate-execute stance
- `lib/server/deliberate-execute.ts` — phase orchestrator
- `lib/deliberate-progress.ts` — deliberationRoundInfo inference
- `council.md` — deliberation phase reuses this pattern
- `blackboard.md` — execution phase reuses this pattern
