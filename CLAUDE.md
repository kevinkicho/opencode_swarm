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
   map-reduce, council, orchestrator-worker, debate-judge, critic-loop).
   One paragraph each.
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

The user delegated primary judgment 2026-04-27 because project complexity
outgrew their comfortable comprehension. **Decide and document, don't
ask.** Treat the inversion as load-bearing:

- For aesthetic, architectural, trade-off, test-design, refactoring,
  file-organization, prose-style, or tooling choices — make the call,
  state the rationale in one sentence, proceed. Listing 3 options for
  the user to pick is itself a barrier.
- Bold on reversible (refactors, edits, test additions, file moves —
  git revert is cheap). Conservative on irreversible (force-pushes,
  dropping data, destructive git ops, spending money on live runs,
  posting to external services — those still need confirmation).
- The right-size gate still applies to test / package / abstraction
  additions: would the absence hurt the user? If no, skip — but skip
  *silently*, don't ask permission to skip.
- When asked "are we done?" / "is this enough?" — default to **"yes,
  here's what's covered."** Don't reflexively list 6 more things.

What still earns an ask:

- Direction-setting at the project level ("which feature next?")
- Irreversible / hard-to-reverse actions (above)
- Spending money on live opencode runs
- When I genuinely can't tell what the user wants

Read `feedback_autonomous_driver.md` for the full posture.

If the user asks how to verify something works, point at `docs/VALIDATION.md`.
If they ask how an endpoint behaves, point at `docs/API.md`. Don't answer
from memory — these docs are greppable for a reason.
