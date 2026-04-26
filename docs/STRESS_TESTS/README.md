# Stress test ledger

This directory holds reference snapshots of high-concurrency test
runs. Each entry is a single run of multiple patterns (often all of
them) at a specific teamSize / cap configuration, captured so we
can:

- Compare the SAME setup across code-change windows ("did fix #N
  actually move the needle on map-reduce throughput?")
- Identify failure modes that only surface at scale
- Provide a stable reference for "what does normal look like at
  teamSize=N"

## Naming

`docs/STRESS_TESTS/<YYYY-MM-DD>-<short-identifier>.md`

The identifier should describe the SHAPE of the test (e.g.
`max-team-size-8`, `mixed-load-debate-heavy`, `sustained-24h`),
not its purpose. Multiple entries per day are fine — append a
suffix like `-am` / `-pm` if needed.

## Format

Each entry should at minimum have:

1. **Identifier + reference task** — for traceability.
2. **Setup** — workspace, directive, teamSize per pattern, cap,
   any non-default flags.
3. **Run IDs** — so future analysis can pull session messages directly.
4. **Final results table** — status / items / done / findings /
   tokens per pattern, plus aggregates.
5. **What worked / what broke / per-pattern lessons.**
6. **Filed follow-up tasks** — link to TaskCreate IDs.
7. **Comparison baseline notes** — what to keep constant when
   re-running for diff.

## Existing entries

- `2026-04-26-max-team-size-8.md` — All 8 patterns × max teamSize
  (8 except critic-loop=2) × 30min. ~22.5M tokens, 8 done, 0
  findings, 4 stalls, 2 errors. Surfaced 10 follow-up tasks
  (#95-#104) covering pattern scaling failure modes.
