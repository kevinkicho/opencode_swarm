# Postmortems

Forensic reports on run failures (and notable near-misses), stored as a
durable record so we can verify that proposed fixes actually take effect
in subsequent runs.

## Why this directory exists

A postmortem without follow-through is trivia. The goal here is the
opposite: every postmortem declares a set of fixes, each fix has a
**validation procedure**, and re-running that procedure against a later
run is how we prove the project is actually upgrading rather than just
accumulating apologies.

Treat each file as a contract:

1. **Observed failure** — what the run did (signals, timing, data).
2. **Diagnosis** — what we verified (facts with log citations), and
   explicitly what we did NOT verify (hypotheses).
3. **Fixes** — each labelled `F<n>`, scoped to one change.
4. **Validation** — for each fix: the exact probe (command / SQL /
   log-line pattern) that distinguishes "fix in place and working"
   from "regressed or never landed."
5. **Ledger** — status of each fix over time (pending, in-flight,
   shipped + commit hash, verified against which subsequent run).

## Naming

`YYYY-MM-DD-<short-slug>.md` — e.g. `2026-04-24-orchestrator-worker-silent.md`.

Date = date of the failed run, not date the postmortem was written.

## Using a postmortem as a regression probe

When a new run completes, walk the open fixes on recent postmortems and
run each fix's validation command against that run's artifacts. If a
validation that previously passed now fails, you've caught a regression
and should open a new postmortem entry.

## Fix-status lifecycle

```
PROPOSED → QUEUED → IN-FLIGHT → SHIPPED → VERIFIED
                                   ↓
                              REGRESSED (open new entry)
```

- **PROPOSED** — mentioned in postmortem, no concrete owner yet.
- **QUEUED** — added to STATUS.md §Queued.
- **IN-FLIGHT** — implementation started (branch / WIP commit).
- **SHIPPED** — merged to main with commit hash recorded.
- **VERIFIED** — validation probe passed against a real run (record
  run ID + date + probe output excerpt).
- **REGRESSED** — validation probe previously passed, now fails.
  Open a new postmortem referencing this one.
