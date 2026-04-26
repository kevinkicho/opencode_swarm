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

## Ledger discipline (HARDENING_PLAN.md#D5)

Every VERIFIED entry MUST cite an artifact that re-runs from. The lint
at `lib/__tests__/hardening/postmortem-ledger.test.ts` enforces this —
a VERIFIED line in a Ledger table without one of these markers will
fail the lint:

- A run ID matching `run_*` (preferred — most reproducible)
- A test path matching `*.test.ts` (preferred — runnable without spawn)
- A commit hash, 7+ hex chars (acceptable — reproducible at the
  commit's point-in-time)
- A `task #NNN` reference (acceptable when the fix's PR is the artifact)
- A `pending` marker (e.g., `pending — re-run on next critic-loop run`)

Examples of compliant Ledger rows:

```
| F1 | VERIFIED | d824bf4 | run_modn6mrg_hxvssz | 240s abort fired ... |
| F1 | SHIPPED  | (this commit) | pending — re-run on next critic-loop run | ... |
```

Why this matters: a postmortem without re-runnable verification is
trivia. The ledger is the contract; the lint is the enforcement.

## Template

```markdown
# YYYY-MM-DD · <short title>

**Run:** `run_*` (or N/A for design-only postmortems)
**Pattern:** <pattern name>
**Models:** <which models on which seat>
**Workspace:** <path>
**Directive:** <quote first ~200 chars>
**Outcome:** <one-paragraph summary>

---

## 1 · Observed failure

<what the run did — signals, timing, data — with log/probe citations>

## 2 · Diagnosis

### Verified facts

- <fact 1, with log citation>
- <fact 2, with log citation>

### Speculation (not directly verified)

- <hypothesis with the test that would settle it>

## 3 · Fixes

### F1 — <short title>

**File:** `<path>`
**Change shipped:** `<commit hash>` or `(this commit)` if part of the
postmortem's ship batch.

```ts
// concrete diff or pseudocode
```

## 4 · Validation

### F1 validation procedure

**Probe — production:** <reproducer + observable signal>
**Probe — synthetic:** <unit test path or curl recipe>

## 5 · Ledger

| Fix | Status | Shipped commit | Verified against |
|---|---|---|---|
| F1 | <status> | <commit-or-pending> | <run ID / test path / pending marker> |

## 6 · Knock-on effects

<other call sites or patterns that benefit from / are affected by this fix>
```
