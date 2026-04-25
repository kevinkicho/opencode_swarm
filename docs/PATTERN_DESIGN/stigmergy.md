# Pattern: stigmergy (overlay, not standalone)

**Status:** shipped, passively observed (no dedicated run mode)
**Session topology:** N/A — it's a signal overlay on any blackboard-derived pattern
**Observability maturity:** medium — heat-rail exists; inline board decoration doesn't

## 1 · Mechanics

Stigmergy is NOT a selectable pattern in the UI. It's a bias layer
on blackboard's coordinator picker, always active on blackboard /
orchestrator-worker / role-differentiated / deliberate-execute
(anything using the blackboard store). The name comes from
ant-colony trail pheromones: agents observe where others have
walked without explicit coordination.

- **Heat accumulation:** every patch part from every assistant turn
  contributes to per-file edit counts (`toFileHeat` in
  `lib/opencode/transform.ts`). A single `FileHeat` record holds:
  `path`, `editCount`, `lastTouchedMs`, `sessionIDs: string[]`.
- **Picker influence:** coordinator's todo picker scores each open
  todo by summing the edit counts of files mentioned in its
  content. Full-path matches count double; basename-only matches
  (≥4 chars) count single. Score function: `scoreTodoByHeat` in
  `lib/server/blackboard/coordinator.ts`.
- **Exploratory bias:** picker sorts open todos **ascending** by
  heat score — prefers items whose files are LEAST touched (not
  most). Rationale: after a worker edits src/auth/, subsequent
  workers are biased to explore elsewhere rather than pile on.
- **Tiebreak:** identical scores tie-break on `createdAtMs`
  (oldest first).
- **Degenerate case:** if no heat data exists (fresh run, or no
  file attribution in the todo content), picker falls back to
  `createdAtMs` order alone.
- **Pure observation:** the heat rail never lets the user reassign
  or pin a file. It's a viewer, not a controller.
  (DESIGN.md §4.2: "observation, never assignment").
- **Logging:** coordinator logs `[coordinator] heat-weighted pick:
  "..."` only when the heat-picked item differs from
  oldest-first — i.e., when the bias actually shifted the choice.

## 2 · Signals already emitted

- `FileHeat.editCount` per file
- `FileHeat.sessionIDs` — which sessions touched the file
- `FileHeat.lastTouchedMs` — recency of last touch
- The heat-weighted pick log entry (when it fires)
- Per-todo score implicit in pick ordering (not yet surfaced)

What's NOT surfaced today:
- Why the picker chose the todo it did (was it heat bias or age?)
- Score distribution across the open queue (are all todos
  comparably-hot?)
- Per-todo heat score visible to the user

## 3 · Observability surface

### Existing
- `components/heat-rail.tsx` — fourth tab when `heat.length > 0`,
  shows files hot-first with intensity bars, +/- line counts, agent
  touchers, last-touched time. Opens file-heat inspector drawer on
  click.

### Proposed — NOT a new tab. Decorate `board-rail` rows instead.

Rationale: stigmergy is a signal *about* board items, not a
separate conceptual surface. A fifth tab would split attention; an
inline decoration preserves the board as the single source of truth
about what's being worked on.

**Decoration spec:** for each `open` todo row in `board-rail`,
render after the content (before the owner pill) a compact heat
indicator:

| element | content | width |
|---|---|---|
| mini-bar | 3px-tall horizontal bar; width scaled to heat-score / max-open-score | 24px |
| score-num | `42` tabular-nums when present, `0` fog-muted when zero | 20px |

Color stepping on the mini-bar matches heat-rail:
- score 0 · fog-700 (cold — picker will prefer this)
- score 1..20% of max · amber/30
- score 20..50% of max · amber/50
- score 50..100% of max · molten/40 (hot — picker will avoid)

**Tooltip on mini-bar hover:**
```
heat score: 42
files: src/auth/routes.ts (24 edits), src/auth/login.ts (18 edits)
picker rank: 3 of 12 open todos (preferred — low heat)
```

**Empty decoration:** `open` rows with zero heat get `·` fog-muted
(no bar, no number), to keep the row silhouette consistent.

### Optional — "heat-picked" timeline chip

In the timeline view (not the board-rail), when a
`heat-weighted pick` log entry fires, render a small `🜂`
amber chip at that moment so the user sees when exploratory bias
actually influenced a decision (vs. when oldest-first would have
picked the same thing).

## 4 · Mechanics gaps

### I1 · Heat half-life decay

Today `editCount` accumulates forever. In long runs, early-hot
files stay ranked high even if untouched for hours — the swarm
gets anchored. Add decay: on each ticker tick, multiply all
`editCount` by ~0.95 (half-life ≈ 13 ticks ≈ 130s, configurable).
Files not touched recently cool down; picker naturally drifts to
fresh regions.

### I2 · Per-session heat (not just global)

Today `FileHeat.sessionIDs` is a flat list. Aggregating by session
would let us detect "session 3 edits src/auth/ constantly while
the rest avoid it" — a specialization signal. Store
`editsBySession: Record<sessionID, number>` alongside the global
count.

### I3 · Cold-file seeding

If the open queue is drained but there are files in the workspace
with zero edits (and they're not gitignore'd), seed exploration
todos ("investigate <file>; report findings") via the planner.
Natural way to keep the swarm exploring when the explicit backlog
empties.

### I4 · Heat-based worker affinity

Workers who've touched a file are MORE likely to do good follow-up
work on it (context in their session already). Today picker biases
toward least-touched globally; consider a per-worker "warmth"
signal: if worker N has touched a file, they get a small bonus to
claim follow-ups on it. Balances exploration (global coldness)
with exploitation (per-worker warmth).

## 5 · Ledger

| ID | Kind | Status | Commit | Verified against | Notes |
|---|---|---|---|---|---|
| board-row-heat-decoration | tab-eq | SHIPPED | (next commit) | — | board-rail.tsx adds inline mini-bar + score on each open todo row; replicates coordinator.scoreTodoByHeat client-side; tone-stepped fog/amber/molten by score % of max |
| heat-picked-timeline-chip | tab-eq | PROPOSED | — | — | ~2 h; optional |
| I1 | improvement | SHIPPED | (next commit) | — | decayFactor = 0.5^(Δt / HEAT_HALF_LIFE_MS) applied in coordinator.scoreTodoByHeat AND mirrored client-side in board-rail.heatScoreForItem; default half-life 30 min, env override OPENCODE_HEAT_HALF_LIFE_S (server only) |
| I2 | improvement | SHIPPED | (next commit) | — | FileHeat now carries editsBySession: Record<sessionID, number> alongside the global count; toFileHeat aggregates per-session in a Map<string, number> bucket and emits via Object.fromEntries |
| I3 | improvement | SHIPPED | (next commit) | — | `lib/server/blackboard/cold-file-seed.ts` walks the workspace for code-extension files (skips dotfiles + COLD_EXCLUDE_DIRS, capped at 8000 files), subtracts any path in any session's accumulated FileHeat, and seeds up to 5 "Investigate <file>; report findings" todos when the result has any cold candidates. Hooked into auto-ticker's `attemptTierEscalation` "produced no work" branch — fires AFTER the LLM-driven tier sweep returns 0 new items. Idempotent against existing board content. Deterministic, no LLM cost. |
| I4 | improvement | SHIPPED | (next commit) | — | scoreTodoByHeat takes optional `pickedSessionID`; subtracts `0.5 * editsBySession[sid] * decay * weight` from score for files this session has touched. Coefficient keeps global exploratory bias dominant; sole-touchers tip toward continuing. Tickercoordinator passes `pickedSession` through. |

## 6 · Cross-references

- `SWARM_PATTERNS.md` §2 — stigmergy stance
- `DESIGN.md` §4.2 — "observation, never assignment"
- `lib/opencode/transform.ts` — heat aggregation (toFileHeat)
- `lib/server/blackboard/coordinator.ts` — scoreTodoByHeat
- `components/heat-rail.tsx` — existing fourth tab
- `blackboard.md` — stigmergy layers on top of this pattern's store
- `memory/feedback_machine_authored_density.md` — density aesthetic
  rules that the inline decoration must match
