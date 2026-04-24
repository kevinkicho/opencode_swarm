# Pattern Design

Per-pattern design contracts for the swarm orchestration shapes shipped by
this app. One file per pattern. Each file declares the pattern's canonical
mechanics, the signals it emits, the observability surface (UI tab) it
deserves, and the backend improvements that would close its mechanical
gaps — plus a ledger tracking what's been shipped and verified.

## Why this directory exists

The app ships nine swarm patterns, but only `blackboard` has been
exercised in a real run. Without a written design contract per pattern,
"what's the UI supposed to look like for critic-loop?" is a recurring
question with no canonical answer, and "did the map-reduce synthesis
actually happen?" has no regression probe.

This directory mirrors the `docs/POSTMORTEMS/` convention: each pattern
file is a contract that later work can be validated against. If a new
run uses `orchestrator-worker` and there's no observable plan-delta
surface, the design contract says so and a follow-up is warranted.

## File contract

Every pattern file must have sections 1–6 in this order:

1. **Mechanics** — what the pattern does step by step. File:line refs
   required for every non-obvious claim. No speculation.
2. **Signals already emitted** — fields already in the data model that
   could be rendered. This is the observability raw material.
3. **Observability surface** — the proposed tab: name, scope (when it's
   visible), layout, columns, aesthetic notes, edge cases. Dense-factory
   compliance required (h-5/h-6 rows, monospace, tabular-nums, text-micro
   labels, ink/fog/molten/mint/iris/amber palette only).
4. **Mechanics gaps** — numbered `I<n>` (Improvements) with a one-para
   summary per gap, ordered by leverage. These are backend / logic
   changes, not UI work.
5. **Ledger** — table tracking status of each proposed item. Columns:
   ID · Kind (tab / I<n>) · Status · Commit · Verified against · Notes.
   Mirrors the postmortem-ledger convention.
6. **Cross-references** — related files in the codebase, memory, or
   other design docs.

## Status lifecycle

```
PROPOSED → QUEUED → IN-FLIGHT → SHIPPED → VERIFIED
                                   ↓
                              REGRESSED (note in ledger; open postmortem)
```

## Using these docs as regression probes

When a new run completes, walk the §5 ledger of every pattern file for
items marked VERIFIED. Re-run each one's verification against the new
run's artifacts. Any previously-VERIFIED item whose check now fails is
a regression — record it in the ledger and open a postmortem entry.

## Files

| Pattern | File | Status |
|---|---|---|
| blackboard | `blackboard.md` | mature — partially validated |
| orchestrator-worker | `orchestrator-worker.md` | shipped, unvalidated |
| role-differentiated | `role-differentiated.md` | shipped, unvalidated |
| map-reduce | `map-reduce.md` | shipped, unvalidated |
| council | `council.md` | shipped, partially validated |
| critic-loop | `critic-loop.md` | shipped, unvalidated |
| debate-judge | `debate-judge.md` | shipped, unvalidated |
| deliberate-execute | `deliberate-execute.md` | shipped, unvalidated |
| stigmergy | `stigmergy.md` | layered overlay, not a standalone pattern |

## Cross-references

- `SWARM_PATTERNS.md` — pattern catalog (vision + stance)
- `docs/POSTMORTEMS/` — run-failure forensics and fix ledger
- `docs/ARCHITECTURE.md` — runtime data flow
- `docs/VALIDATION.md` — runbook for features shipped but not
  exercised against real runs
