# Tests

Two layers, both via [vitest](https://vitest.dev).

## Unit tests (default)

Co-located alongside the modules they test, under `lib/**/__tests__/*.test.ts`.
Fast, hermetic, no network or opencode dependency.

```bash
npm run test          # one-shot
npm run test:watch    # re-runs on file changes
npm run test:ui       # browser UI
```

These run on every commit.  Today's coverage:

- `lib/server/blackboard/__tests__/planner-parsers.test.ts` — 36 cases
  for the wire-protocol prefix parsers ([verify], [role:], [files:],
  [criterion], [from:], [rolenote:]) including full prefix-chain
  composition.

To add a new unit test, drop it into `lib/<area>/__tests__/<thing>.test.ts`.

## Integration tests (opt-in)

Located at `tests/integration/<pattern>.test.ts`.  Each test spawns a
real swarm run against a real workspace via the live dev server and the
running opencode instance.  Asserts pattern-appropriate success.

```bash
npm run test:integration
```

These are gated behind `VITEST_INTEGRATION=1` so the default `npm run
test` skips them.  Each test takes 30-90 seconds and costs ~$0.30-0.80
per pattern run; the full suite of 8 patterns is ~$3-6 — cheap enough
to run on PR but not on every commit.

### Prereqs

- `npm run dev` running (writes `.dev-port`)
- opencode :4097 reachable
- `OPENCODE_SERVER_PASSWORD` env var set (the harness reads it)
- `SWARM_TEST_WORKSPACE` env var optional — defaults to
  `C:\Users\kevin\Workspace\kyahoofinance032926`

### Per-pattern tests (target coverage)

| File | Pattern | Success signal |
|---|---|---|
| `blackboard.test.ts` | blackboard | >=1 board done within 90s |
| `orchestrator-worker.test.ts` *(todo)* | orchestrator-worker | >=1 board done within 120s |
| `role-differentiated.test.ts` *(todo)* | role-differentiated | >=1 board done within 120s |
| `map-reduce.test.ts` *(todo)* | map-reduce | each mapper produces >=1 completed turn within 120s |
| `council.test.ts` *(todo)* | council | every member produces >=1 draft within 90s |
| `debate-judge.test.ts` *(todo)* | debate-judge | judge produces >=1 verdict within 120s |
| `critic-loop.test.ts` *(todo)* | critic-loop | >=1 iter cycle (worker -> critic -> verdict) within 120s |
| `deliberate-execute.test.ts` *(todo)* | deliberate-execute | phase-2 synthesis produces >=1 todo within 180s |

The `_harness.ts` module exposes `spawnRun`, `waitForCondition`,
`sessionsWithActivity`, and `abortRun` — each new pattern test should
take 30-50 lines following `blackboard.test.ts`.

### Why these matter

Today's 4-pattern silent-drop bug (commits `0c79175` + `23a21f7`) was
probably broken for weeks because no test caught it.  These integration
tests would have failed loudly the first time they ran post-bug — that's
the reliability change this suite gives us.
