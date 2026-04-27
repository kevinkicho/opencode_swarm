# Postmortems

Forensic notes on run failures and notable near-misses. Each one has the
same shape:

1. **What broke** — signals, timing, log citations.
2. **Why** — verified facts vs. speculation, distinguished.
3. **What we did** — the fix(es), one short paragraph or diff each.
4. **How we'd know it regressed** — the probe (test path / log line / run id).

Naming: `YYYY-MM-DD-<short-slug>.md` (date = the failed run's date).

When babysitting a new run, walk recent postmortems' "how we'd know it
regressed" probes against that run's artifacts. If something that worked
last time fails now, write a new postmortem referencing the original.

## Template

```markdown
# YYYY-MM-DD · <short title>

**Run:** `run_*` (or N/A for design-only)
**Pattern + models:** <pattern · seat-by-seat models>
**Outcome:** <one paragraph summary>

## What broke

<signals + log citations>

## Why

Verified:
- <fact, with citation>

Speculation (not verified):
- <hypothesis>

## What we did

- **F1.** <short paragraph or diff. Commit hash inline.>

## How we'd know it regressed

- F1: `<test path>` or `<log line pattern>` or `pending — exercises on
  next <pattern> run that hits <condition>`.
```

## Existing entries

Existing postmortems (2026-04-24, 2026-04-25, 2026-04-26) follow an older
heavier template (`F<n>` labels, "Verified against / Notes" tables, ledger
discipline notes). Don't rewrite history — those entries stay as-is. New
postmortems use the lighter template above.
