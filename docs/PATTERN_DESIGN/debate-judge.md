# Pattern: debate-judge

**Status:** shipped, unvalidated
**Session topology:** session 0 = judge; sessions 1..N-1 = generators (independent proposers)
**Observability maturity:** low — judge-verdict-strip shows final verdict only; no per-round proposal comparison view

## 1 · Mechanics

Adversarial pattern. N−1 generators each independently propose a
solution; a judge arbitrates with WINNER / MERGE / REVISE. Generators
are independent (no shared transcript during generation); judge sees
all proposals together.

- **Kickoff:** `runDebateJudgeKickoff` (lib/server/debate-judge.ts).
  Session 0 gets the judge intro (agent='judge', model=judgeModel).
  Sessions 1..N-1 get the generator intro
  (`buildGeneratorIntroPrompt`, file:42-65) with their slot index
  visible ("you are generator 2 of 4"); models rotate across
  teamModels[] to get diverse perspectives.
- **Generation phase:** all generators produce proposals in parallel.
  No peer awareness.
- **Sync point:** background orchestrator calls `waitForSessionIdle`
  on every generator. Once all idle, harvest latest assistant text
  per generator (`extractLatestAssistantText`, file:28-40).
- **Judge post:** proposals are bundled into a single prompt with
  clear boundaries (`--- proposal 1 ---` style separators). Posted
  to session 0 with the judgment framing.
- **Verdict parse:** check first line for WINNER / MERGE / REVISE
  keyword. Parser stored in debate-judge.ts (referenced by
  `components/judge-verdict-strip.tsx`).
- **On WINNER:<index>:** proposal `<index>` is selected; run terminates.
- **On MERGE:<synthesis>:** judge's synthesis text is the final
  output; run terminates.
- **On REVISE:<feedback>:** judge's feedback is broadcast to all
  generators with "round 2: revise your proposal given this
  feedback." Loop. Cap: `DEFAULT_MAX_ROUNDS = 2` (file:26), meaning
  max 1 revision round.
- **Termination:** WINNER, MERGE, max-rounds reached, timeout, or
  fetch failure.

## 2 · Signals already emitted

- Per-round per-generator proposal text
- Per-round judge verdict text (with WINNER / MERGE / REVISE prefix)
- Round count + max-rounds
- Generator models (for diversity check)
- Parsed verdict type + target (for WINNER: which index)

What's NOT surfaced today:
- Proposal diff between rounds (did generator-2 actually revise, or
  just reword?)
- Feedback traceability (did round-2 proposals address the judge's
  round-1 feedback bullets?)
- Judge model vs generator model mix

## 3 · Observability surface

### Existing
- `components/judge-verdict-strip.tsx` — above-composer strip when
  `pattern === 'debate-judge'`. Shows verdict type + selected or
  merged proposal text.

### Proposed — `debate` tab

**Scope:** `pattern === 'debate-judge'`. Left-panel tab group.

**Layout:** matrix. Rows = rounds. Columns = generators + judge.
h-6 rows (verdict text needs room).

| col | content | width |
|---|---|---|
| round | `R1`, `R2` | 24px |
| g1 | generator 1: lines + accent stripe | 88px |
| g2 | generator 2 | 88px |
| gN | … | 88px |
| judge | verdict chip (WINNER mint / MERGE iris / REVISE amber) + target/short | flex |
| status | `pending` / `deliberating` / `done` | 48px |

**Each generator cell:**
- R1: draft length + bar for length relative to max
- R2: draft length + small diff indicator (`+lines/-lines` vs R1)

**Judge cell:** verdict keyword chip + short one-liner. For WINNER,
shows `→ g2` with accent match. For MERGE, shows first 40 chars of
synthesis. For REVISE, shows first bullet of feedback with
"…more" overflow.

**Row expansion:** click → drawer with full proposals side-by-side
and full verdict. For REVISE rows, pair the feedback bullets with
the R2 response bullets so user can see whether each was addressed.

**Header chip:** `R<currentRound>/<maxRounds>` · final verdict
pending-or-settled. Colored by verdict (mint / iris / amber / fog).

**Empty state:** `R1 in progress — <N> of <M> generators proposing`.

## 4 · Mechanics gaps

### I1 · Structured REVISE feedback

Free-text REVISE lets the judge loop indefinitely without
actionable differentiation. Add structured contract: judge must
emit WINNER/MERGE/REVISE + (for REVISE) a 2-4 bullet list of
specific changes per generator. Reject non-conforming replies
with a re-ask. Shared with `critic-loop.md` I1.

### I2 · Feedback-addressed detection

After R2 proposals arrive, parse each against the R1 REVISE
bullets and compute "how many of judge's bullets this proposal
addressed." If <30% addressed across ALL generators, auto-stop
with "generators didn't engage with feedback; escalating to
human." Requires I1.

### I3 · Generator-model diversity enforcement

If all generators use the same model, the debate is anemic — they
produce similar proposals by construction. Add kickoff validation:
if N−1 ≥ 3 generators and the distinct `modelID` count among them
is 1, log WARN "generator pool lacks model diversity; debate may
converge trivially."

### I4 · Judge confidence scoring

Judge emits WINNER:<idx> with no confidence metric. For
close-call decisions, the user should know. Add (via I1's
structured contract) a confidence score (1–5) on WINNER and MERGE
verdicts. Render in the judge cell as a small bar next to the
verdict chip.

## 5 · Ledger

| ID | Kind | Status | Commit | Verified against | Notes |
|---|---|---|---|---|---|
| debate-tab | tab | SHIPPED | (next commit) | — | LeftTabs gates on pattern=debate-judge; rounds × generators matrix + judge verdict (WINNER mint / MERGE iris / REVISE amber) |
| I1 | improvement | SHIPPED | (next commit) | — | structured per-generator REVISE bullets in buildJudgeIntroPrompt; parseGeneratorBullets extracts `Map<genIdx, string[]>` for I2 to consume |
| I2 | improvement | SHIPPED | (next commit) | — | bulletAddressedFraction(token-jaccard ≥ 0.10) per draft × prior-round bullets; mean across generators with bullets <30% triggers auto-stop |
| I3 | improvement | SHIPPED | (next commit) | — | kickoff WARN in runDebateJudgeKickoff: triggers when ≥3 generators all share a single modelID — surfaces lack of model diversity without blocking the run |
| I4 | improvement | PROPOSED | — | — | ties to I1 ~30 min |

## 6 · Cross-references

- `SWARM_PATTERNS.md` §7 — debate-judge stance
- `lib/server/debate-judge.ts` — kickoff + loop orchestrator
- `components/judge-verdict-strip.tsx` — existing strip
- `critic-loop.md` — sibling; both need structured verdicts (shared I1)
