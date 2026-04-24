# Pattern: council

**Status:** shipped, partially validated (auto-rounds shape validated 2026-04-22)
**Session topology:** N sessions, identical seeding — every member does every round
**Observability maturity:** medium — reconcile-strip shows current drafts; no cross-round progression view

## 1 · Mechanics

All sessions work the same prompt. Each round produces a set of
peer-aware drafts; later rounds embed all earlier drafts as context
so members can converge or push back.

- **Kickoff:** all sessions seeded identically with the base directive.
  No scope, no role, no draft ordering.
- **Round 1:** every session produces an independent draft. No peer
  context — just the directive.
- **Auto-round orchestrator:** background loop calls
  `waitForSessionIdle` on every session. When all idle, harvests each
  session's latest assistant text (`extractLatestAssistantText`).
- **Round N+1 prompt:** constructed by embedding every peer draft
  from round N, then asking "given your peers' drafts, revise your
  response or reaffirm your position." Fan-posts to every session in
  parallel.
- **Default:** `maxRounds = 3`. Loops R2 and R3 server-side since
  2026-04-22 (previously idle after R1 unless user clicked).
- **Termination:** `maxRounds` reached, or <2 drafts present
  (degenerate), or timeout, or fetch failure.

## 2 · Signals already emitted

- Per-round per-member draft text
- Per-round per-member draft length (lines / chars / tokens)
- Round count inferred from transcript (count distinct prompt posts
  with "Round N" prefix)
- Per-session timing (how long each member took to finish each round)
- `deliberationRoundInfo` in `app/page.tsx` — used for UI empty states

What's NOT surfaced today:
- Pairwise draft similarity per round (convergence metric)
- Per-member direction shift across rounds (did member-2 flip
  positions in R2?)
- Token cost per round

## 3 · Observability surface

### Existing
- `components/reconcile-strip.tsx` — above-composer strip when
  `pattern === 'council'`. Shows N/N drafts as pills, click-to-focus,
  copy/forward/round-2 actions.

### Proposed — `council` tab

**Scope:** `pattern === 'council'`. Left-panel tab group.

**Layout:** grid, rows = rounds, cols = members + convergence.
h-6 rows (members' draft summaries need 2 lines).

| col | content | width |
|---|---|---|
| round | `R1`, `R2`, `R3` | 24px |
| m1 | member 1 summary: lines + accent | 88px |
| m2 | member 2 summary | 88px |
| m3 | … | 88px |
| mN | … | 88px |
| conv | convergence chip: `high` / `med` / `low` | 48px |
| status | `pending` / `in-progress` / `done` | 64px |

**Each member cell:** shows draft-length + a bar indicating
similarity to previous round's draft (if any). Click opens that
member's draft text in a side drawer.

**Convergence metric:** pairwise token-jaccard or cosine across all
drafts in the round. Render as a scalar 0–1. `>0.8 = high (mint)`,
`0.5–0.8 = med (amber)`, `<0.5 = low (rust)`.

**Header chip:** `R<currentRound>/<maxRounds>` ·
`convergence trend: <arrow>` (up, flat, down based on last-two
rounds comparison).

**Empty state:** `R1 in progress — <N> of <M> members drafting`.

## 4 · Mechanics gaps

### I1 · Convergence-detection auto-stop

If R2 convergence ≥ threshold (e.g. 0.85), auto-stop without firing
R3 and hand off to synthesis/execution. Saves tokens on high-consensus
missions. Pair with a runtime flag `autoStopOnConverge: boolean`
default false.

### I2 · Per-member direction persistence

Track position shifts per member across rounds. If member-2 flips
from "approach A" in R1 to "approach B" in R2, surface that — it's
a meaningful signal the council is actually deliberating rather
than confirming bias.

### I3 · Minority-view preservation

Today dissent disappears after the last round. If 3 of 5 members
agree on approach A and 2 dissent toward B, the final output may
silently drop the minority. Add explicit "report dissent in final
summary" to the R_max prompt so the minority gets surfaced.

### I4 · Round-timeout and per-member fallback

If one member hangs indefinitely, the round waits for all sessions
to idle. Add per-round timeout (default 10 min) and a per-member
fallback: timed-out members are recorded as `no-draft` and the
round proceeds with the remaining drafts. Avoids single-member
failures stalling the council.

## 5 · Ledger

| ID | Kind | Status | Commit | Verified against | Notes |
|---|---|---|---|---|---|
| council-tab | tab | SHIPPED | (next commit) | — | per-round per-member draft length + diff-vs-prior + mean-pairwise-token-jaccard convergence chip + last-two-rounds trend arrow; client-side compute (no backend) |
| I1 | improvement | PROPOSED | — | — | backend ~3 h; needs embedding call or token-jaccard |
| I2 | improvement | PROPOSED | — | — | stance classifier ~4 h |
| I3 | improvement | SHIPPED | (next commit) | — | buildRoundPrompt now takes isFinalRound flag; on R_max appends "Dissent: section explicitly required" instruction so 3-vs-2 splits don't quietly collapse into majority text |
| I4 | improvement | SHIPPED | (next commit) | — | per-member waitForSessionIdle now runs in parallel via Promise.all so each member gets the full ROUND_WAIT_MS budget; default lowered to 10 min per spec; hung members recorded as no-draft (text=null) and round proceeds with remaining drafts |

## 6 · Cross-references

- `SWARM_PATTERNS.md` §4 — council stance
- `lib/server/council.ts` — auto-round orchestrator
- `components/reconcile-strip.tsx` — existing strip
- `memory/project_council_shape.md` — auto-rounds shipped 2026-04-22
- `deliberate-execute.md` — this pattern's deliberation phase reuses
  council machinery
