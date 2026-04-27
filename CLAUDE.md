# CLAUDE.md

Briefing for any agent opening this repo.

## What this is

Multi-agent coding swarm UI for opencode. One run = N sessions coordinating
through a 2-D timeline (lane per agent, time downward). Personal-use, never
SaaS, never multi-tenant. Prototype-grade — clarity beats optionality.

## Read these (in order)

1. **`DESIGN.md`** — vision, mental model, UI surface map, state contracts,
   retention policy, planning model. Single source of truth for *why* the UI
   is shaped the way it is.
2. **`docs/opencode-quirks.md`** — opencode SDK vocabulary + HTTP API
   behaviors that aren't in opencode's docs (silent-drop traps, model-format
   shape, workspace path encoding, zombie turns). Read before wiring a new
   opencode call site.
3. **`docs/PATTERNS.md`** — orchestration pattern cheatsheet (blackboard,
   map-reduce, council, orchestrator-worker, role-differentiated, debate-judge,
   critic-loop). One paragraph each.
4. **`docs/API.md`** — greppable HTTP endpoint catalog for *our* routes.
5. **`docs/VALIDATION.md`** — runbook for features shipped but not yet
   exercised live.

## When orienting (not durable)

- **`STATUS.md`** — what shipped, what's queued *right now*. Time-scoped.
- **`docs/POSTMORTEMS/`** — incident log. Re-run probes when babysitting a
  new run; opens regression tells fast.

## Always

- Run `npx tsc --noEmit` after edits. The repo is strict; type-clean is the bar.
- Use opencode SDK names (`task`, `subtask`, `reasoning`, `patch`, `bash`,
  `grep`, …) — never invented synonyms.
- Match the dense aesthetic: h-5/h-6 rows, monospace, `text-micro` (10px)
  uppercase tracking-widest2 for labels, hairline borders, tabular-nums for
  numbers, ink-* / fog-* / molten / mint / iris / amber palette only.

## Never

- Mix declarative and imperative in the same panel. A modal is either a
  rules editor (`save`/`reset`) or an action trigger (`spawn`/`send`/`run`).
- Add BYOK / local-model UI as a selection affordance. Provider universe is
  `zen` + `go` + `ollama`, all routed through opencode.
- Replace canonical opencode names with custom vocabulary "for clarity."
- Default to generic AI design vocabulary (Inter, Roboto, purple gradients).
  The aesthetic is a deliberate point of view.

## When in doubt

Ask before adding a feature flag, a backwards-compat shim, or a "for future
use" abstraction. This is a prototype.

If the user asks how to verify something works, point at `docs/VALIDATION.md`.
If they ask how an endpoint behaves, point at `docs/API.md`. Don't answer
from memory — these docs are greppable for a reason.
