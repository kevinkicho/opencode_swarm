# Pattern: critic-loop

**Status:** shipped, unvalidated
**Session topology:** exactly 2 sessions — session 0 = worker, session 1 = critic
**Observability maturity:** low — critic-verdict-strip shows final verdict only; iteration flow invisible

## 1 · Mechanics

Two-session review loop. Worker produces drafts; critic reviews and
either approves or asks for revisions. Loops until approved, max
iterations, or timeout.

- **Kickoff:** `runCriticLoopKickoff` (lib/server/critic-loop.ts:27-28).
  Session 0 gets the worker intro (agent='worker', model=teamModels[0]).
  Session 1 gets the critic intro (agent='critic',
  model=criticModel). Critic's intro emphasizes strictness, concrete
  feedback, and the APPROVED/REVISE verdict contract
  (`buildCriticIntroPrompt`, file:70-91).
- **Iteration 1 (draft):** worker produces initial draft in response
  to the directive.
- **Review:** background orchestrator calls `waitForSessionIdle` on
  session 0. Harvests latest assistant text
  (`extractLatestAssistantText`, file:41-53). Posts the draft to
  session 1 with the critic review prompt.
- **Critic verdict:** parser checks first line for APPROVED or
  REVISE. Parsed from critic's reply.
- **On APPROVED:** loop terminates; current draft is the run's output.
- **On REVISE:** critic's feedback is posted to session 0 as a
  revision prompt. Worker revises. Loop iteration N+1.
- **Termination:** `DEFAULT_MAX_ITERATIONS = 3` (file:39), meaning
  initial + 2 revisions. Timeout or fetch failure also terminates.

## 2 · Signals already emitted

- Per-iteration worker draft text
- Per-iteration critic verdict text (APPROVED / REVISE + feedback)
- Iteration count + max-iterations bound
- Verdict parse result (keyword found in first line)
- Timing between draft emission and critic verdict
- Draft length per iteration

What's NOT surfaced today:
- Diff between consecutive drafts (what changed iteration-over-iteration)
- Critic feedback structure (bulleted vs prose)
- Whether feedback is actionable or stylistic (no classifier today)

## 3 · Observability surface

### Existing
- `components/critic-verdict-strip.tsx` — above-composer strip when
  `pattern === 'critic-loop'`. Shows APPROVED + iteration count, or
  REVISING… state.

### Proposed — `iterations` tab

**Scope:** `pattern === 'critic-loop'`. Left-panel tab group.

**Layout:** vertical timeline, oldest first (unlike other tabs —
left-to-right reading of review flow reads better chronologically).
h-5 rows.

| col | content | width |
|---|---|---|
| iter | `#1`, `#1r`, `#2`, `#2r`, `#3`, `#3r` (r = review) | 28px |
| actor | worker / critic chip (molten / iris) | 48px |
| status | `drafting` / `reviewing` / `approved` / `revising` | 64px |
| length | draft or feedback length (tabular-nums) | 40px |
| key | for iter ≥2 drafts: diff-summary one-liner ("+12/-5 lines"); for reviews: verdict keyword (APPROVED mint / REVISE amber) | flex |
| time | wall-clock at row creation | 40px |

**Row expansion:** click → inspector drawer. For drafts, show full
text + diff-against-previous-iteration (green/red hunks). For
reviews, show full critic feedback + which parts of the draft
triggered it (if we add line references — see I2).

**Header chip:** `iteration <N>/<max>` · verdict pending-or-final.

**Final-row highlight:** when APPROVED, background-mint-tint the
row and pin a "approved at iter N" chip on the header.

**Empty state:** `awaiting first draft — worker drafting` while
session 0 has an unfinished assistant turn.

## 4 · Mechanics gaps

### I1 · Structured verdict contract

Today critic's APPROVED / REVISE is a free-text keyword check. Add
a structured reply contract: critic must emit JSON or frontmatter
with verdict + confidence (1–5) + change-scope
(STRUCTURAL / WORDING / NONE) + bullet-list of issues. Reject
non-conforming replies by sending a re-ask to the critic. Lets I2
classify feedback automatically.

### I2 · Auto-terminate on nitpick loop

If iterations 2 and 3 are both REVISE + WORDING + confidence ≤ 3,
auto-terminate with "budget exhausted — approving draft N as
final" rather than looping on rewording. Requires I1.

### I3 · Diff compute for drafts

Each iteration's draft is text; compute the unified diff against
the previous iteration and store it alongside the draft. Backs the
`key` column of the iterations tab directly. Avoids re-deriving on
every render.

### I4 · Critic-model divergence

The critic typically uses a different model than the worker (by
design — different perspective). If both use the same model, the
critic may approve too eagerly. Add a kickoff validation: if
`criticModel === teamModels[0]`, log WARN "worker and critic share
a model; feedback quality may regress toward self-approval."

## 5 · Ledger

| ID | Kind | Status | Commit | Verified against | Notes |
|---|---|---|---|---|---|
| iterations-tab | tab | SHIPPED | (next commit) | — | LeftTabs gates on pattern=critic-loop; per-iteration timeline (#N draft + #Nr review) w/ APPROVED-row tint; reads slots from useLiveSwarmRunMessages |
| I1 | improvement | SHIPPED | (next commit) | — | structured YAML verdict block in buildCriticIntroPrompt; classifyCriticReply parses verdict/confidence/scope/issues with legacy-keyword fallback for non-conforming replies |
| I2 | improvement | SHIPPED | (next commit) | — | runCriticLoopKickoff tracks verdictHistory and auto-terminates after 2 consecutive REVISE+WORDING+confidence≤3 iterations; worker receives "shipping current draft as final" notice |
| I3 | improvement | SHIPPED | (next commit) | — | `lib/draft-diff.ts` exposes `computeDraftDiff` (line-level LCS, O(n×m), capped at 4000 lines per side) + `summariseDiff` for the `+N / -M` key column. Iterations-rail now uses LCS-accurate counts (proper diff handles duplicates and order); each iteration row carries `diff: DraftDiff` so a future inspector drawer can pull hunks. |
| I4 | improvement | SHIPPED | (next commit) | — | kickoff WARN in runCriticLoopKickoff when teamModels[0] === teamModels[1] — surfaces same-model risk to dev console without blocking the run |

## 6 · Cross-references

- `SWARM_PATTERNS.md` §8 — critic-loop stance
- `lib/server/critic-loop.ts` — kickoff + loop orchestrator
- `components/critic-verdict-strip.tsx` — existing strip
- `debate-judge.md` — sibling pattern with similar verdict-contract
  weaknesses (shared I1)
