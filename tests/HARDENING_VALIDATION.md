# HARDENING_VALIDATION.md

The validation contract for `docs/HARDENING_PLAN.md`. Each plan item maps to a
test file that proves the property either holds today or will hold after the
fix ships. Run `npm test` (unit) + `VITEST_INTEGRATION=1 npm test` (integration)
to execute the full validation suite.

## Test layout

| Directory | Purpose | Trigger |
|---|---|---|
| `lib/__tests__/hardening/` | Cross-cutting meta-tests (greps over source, ledger linters, allowlists) — exercise invariants the codebase as a whole must hold | `npm test` |
| `lib/**/__tests__/` | Module-scoped unit tests — co-located with the module they cover | `npm test` |
| `tests/integration/` | Live-stack tests — spawn real opencode + dev server | `VITEST_INTEGRATION=1 npm test` |

## Status legend

- **passing** — the test runs today and asserts a property the code already holds
- **target** — the test runs today and FAILS until the fix ships (TDD anchor for the work)
- **scaffold** — `describe.skip(...)` documenting the contract; un-skip when the module/fix lands
- **integration-scaffold** — `it.skip(...)` in `tests/integration/`; un-skip when fixture wired up

A test that flips from `target` → `passing` after a fix ships is the integrity
proof for that hardening item: it certifies the property holds AND will keep
holding under future changes.

## Mapping (plan item → test file → status)

### Part I — Resilience

| Item | Plan section | Test file | Status |
|---|---|---|---|
| R1 — kickoff sync-throw → 5xx | HARDENING_PLAN.md#R1 | `tests/integration/kickoff-fail-open.test.ts` | integration-scaffold |
| R2 — SDK part validator | HARDENING_PLAN.md#R2 | `lib/opencode/__tests__/validate-part.test.ts` | scaffold |
| R3 — orphan cleanup forensic log | HARDENING_PLAN.md#R3 | `lib/server/blackboard/__tests__/orphan-cleanup-log.test.ts` | scaffold |
| R4 — typed Opencode errors | HARDENING_PLAN.md#R4 | `lib/opencode/__tests__/errors.test.ts` | scaffold |
| R5 — API error response shape | HARDENING_PLAN.md#R5 | `lib/__tests__/hardening/api-error-shape.test.ts` | target (lint) |
| R6 — typed request body validators | HARDENING_PLAN.md#R6 | `lib/__tests__/hardening/route-body-validation.test.ts` | target (lint) |
| R7 — JSON.parse on disk validators | HARDENING_PLAN.md#R7 | `lib/server/__tests__/swarm-registry-validate.test.ts` | scaffold |

### Part II — Durability

| Item | Plan section | Test file | Status |
|---|---|---|---|
| D1 — atomic meta.json write | HARDENING_PLAN.md#D1 | `lib/server/__tests__/atomic-write.test.ts` | scaffold |
| D2 — globalThis-keyed locks | HARDENING_PLAN.md#D2 | `lib/__tests__/hardening/lock-hmr-survival.test.ts` | target (lint) |
| D3 — bounded LRU caches | HARDENING_PLAN.md#D3 | `lib/server/__tests__/lru.test.ts` | scaffold |
| D4 #1 — swarm-registry lifecycle | HARDENING_PLAN.md#D4 | `lib/server/__tests__/swarm-registry-lifecycle.test.ts` | passing |
| D4 #2 — dispatch coordinator | HARDENING_PLAN.md#D4 | `lib/server/blackboard/coordinator/__tests__/dispatch.test.ts` | scaffold |
| D4 #3 — transform fixtures | HARDENING_PLAN.md#D4 | `lib/opencode/__tests__/transform-fixtures.test.ts` | scaffold |
| D4 #4a — orchestrator-worker | HARDENING_PLAN.md#D4 | `tests/integration/orchestrator-worker.test.ts` | integration-scaffold |
| D4 #4c — critic-loop | HARDENING_PLAN.md#D4 | `tests/integration/critic-loop.test.ts` | integration-scaffold |
| D4 #4d — debate-judge | HARDENING_PLAN.md#D4 | `tests/integration/debate-judge.test.ts` | integration-scaffold |
| D4 #4e — council | HARDENING_PLAN.md#D4 | `tests/integration/council.test.ts` | integration-scaffold |
| D4 #4f — map-reduce | HARDENING_PLAN.md#D4 | `tests/integration/map-reduce.test.ts` | integration-scaffold |
| D4 #5 — planner sweep | HARDENING_PLAN.md#D4 | `lib/server/blackboard/__tests__/planner-sweep.test.ts` | scaffold |
| D5 — postmortem ledger discipline | HARDENING_PLAN.md#D5 | `lib/__tests__/hardening/postmortem-ledger.test.ts` | passing (lint) |
| D6 — server-only enforcement | HARDENING_PLAN.md#D6 | `lib/__tests__/hardening/server-only-imports.test.ts` | target (lint) |
| D7 — opencode JSON fixtures | HARDENING_PLAN.md#D7 | `lib/opencode/__fixtures__/README.md` (capture corpus) | scaffold |

### Part III — Efficiency

| Item | Plan section | Test file | Status |
|---|---|---|---|
| E1 — getSessionMessages dedup | HARDENING_PLAN.md#E1 | `lib/server/__tests__/get-session-messages-dedup.test.ts` | scaffold |
| E2 — useSwarmRuns dedup | HARDENING_PLAN.md#E2 | `lib/__tests__/hardening/raw-fetch-audit.test.ts` | target (lint) |
| E3 — useBackendStale Context | HARDENING_PLAN.md#E3 | (manual — Network panel verification) | manual |
| E4 — polling→SSE consolidation | HARDENING_PLAN.md#E4 | (manual — Network panel verification) | manual |
| E5 — sha7 Promise.all | HARDENING_PLAN.md#E5 | (covered by D4 #2 dispatch test) | covered |
| E6 — board/ticker route slim | HARDENING_PLAN.md#E6 | `lib/__tests__/hardening/route-import-graph.test.ts` | scaffold |
| E7 — board/route audit | HARDENING_PLAN.md#E7 | (covered by E6 audit) | covered |
| E8 — page useMemo consolidation | HARDENING_PLAN.md#E8 | (folded into C6; React profiler) | manual |

### Part IV — Capability (decomp tests come from existing functionality)

Capability items are mostly refactor — the tests come from the modules they
move TO, not the moves themselves. After C2/C3/C4/C10/C11/C12/C13 ship, every
extracted module gets its own `__tests__/` directory.

| Item | Plan section | Test artifact | Status |
|---|---|---|---|
| C1 — extractLatestAssistantText lift | HARDENING_PLAN.md#C1 | `lib/server/__tests__/extract-text.test.ts` | scaffold |
| C2 — split run/route | HARDENING_PLAN.md#C2 | `lib/server/run/__tests__/{validate,defaults,kickoff}.test.ts` | scaffold |
| C3 — split swarm-registry | HARDENING_PLAN.md#C3 | (D4 #1 covers fs side; new derive tests post-split) | covered |
| C4 — decompose tickCoordinator | HARDENING_PLAN.md#C4 | (D4 #2 grows to one file per helper) | covered |
| C5 — api-types + config | HARDENING_PLAN.md#C5 | `lib/__tests__/hardening/config-isolation.test.ts` | target (lint) |
| C9 — orphan endpoint deletion | HARDENING_PLAN.md#C9 | `lib/__tests__/hardening/route-caller-coverage.test.ts` | target (lint) |
| C16 — parseVerdict server-side | HARDENING_PLAN.md#C16 | (folded into rail tests) | covered |
| C17 — close 2 import cycles | HARDENING_PLAN.md#C17 | `lib/__tests__/hardening/import-cycles.test.ts` | target (lint) |

## How to interpret target/lint tests

A `target` test FAILS today on purpose. It's a TDD anchor — the test
codifies what "fixed" looks like. When the corresponding plan item ships,
the test flips to passing automatically. If you see a test go from passing
back to failing later, that's the regression signal.

The lint-style tests (those that grep over source) are the structural
equivalent of typescript: they enforce shape invariants over the codebase
as a whole. Run `npm test` to invoke them; the failure message includes the
exact plan item and remediation.

## Adding new plan items

When adding a new R/D/E/C item to HARDENING_PLAN.md:

1. Add the test file in the matching directory (resilience tests under
   `lib/__tests__/hardening/` for cross-cutting; module tests co-located).
2. Add a row to the table above with status.
3. The plan item's "Verification" line should reference the test file.

The `Verification` line in HARDENING_PLAN.md and the `Test file` here must
agree — they're the two halves of the contract.
