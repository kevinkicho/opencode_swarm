# opencode message fixtures (D7)

Real captured opencode message JSON used by the transform-fixtures test
suite (`lib/opencode/__tests__/transform-fixtures.test.ts`). Snapshot
output of every transformer against every fixture is the schema-drift
firewall (HARDENING_PLAN.md#D7).

## Capture workflow

1. Spin up a real run that exhibits the shape you want to capture.
2. From the dev shell:
   ```bash
   curl -s "http://127.0.0.1:4097/session/<sessionID>/message" > /tmp/raw.json
   ```
3. Sanitize: redact paths under `/mnt/c/Users/...` to `/USER`, redact any
   ad-hoc API tokens visible in tool output. The fixture should be a
   reproducible sample, not a forensic capture.
4. Save to `<pattern>-<scenario>.json` in this directory.
5. Run `npm test -- transform-fixtures` to update snapshots.

## Required fixtures (un-skip the test once these exist)

| File | Scenario |
|---|---|
| `planner-tier-1.json` | Successful planner sweep, ≥3 todos parsed |
| `worker-with-tools.json` | Worker turn with `patch` + `tool` parts (read/edit/bash) |
| `worker-text-only-skip.json` | Worker emitting `skip:` prefix (legit no-op) |
| `worker-pseudo-tool-text.json` | Q42 reproducer — text-only that LOOKS like a tool call |
| `critic-approved.json` | Critic verdict reply with APPROVED outcome |
| `critic-revise.json` | Critic verdict reply with REVISE outcome |
| `council-round.json` | Council deliberation, generators + judge |

## Why snapshots beat hand-written assertions

The transformers are wide (8 outputs × N fixtures = 56+ assertion targets).
Hand-writing each expected shape is brittle and the diff on a regression is
unhelpful. Snapshots:
- Capture the full transformed shape automatically.
- Diff cleanly when a field changes — reviewable in PR.
- Force a deliberate decision when shape DOES change (the snapshot update
  is the conscious "yes, we meant to change this" signal).

## When to capture a new fixture

Whenever an incident postmortem identifies a model or pattern emitting
a shape we didn't expect (Q34, Q42 class), capture a fixture replicating
that shape. The fixture becomes a regression probe: future transformers
must handle it correctly or fail loudly.
