# CLAUDE.md

Briefing for Claude Code (and any agent that respects this convention) opening this repo.

## Read these first
1. **`DESIGN.md`** — vision, mental model, opencode SDK vocabulary, data contracts, backend wiring plan, decisions already made. Do not write code without reading it.
2. **`WHAT_THIS_PROJECT_IS_NOT.md`** — design choices we explicitly rejected. Read before "fixing" something that looks missing — it may be missing on purpose.
3. **`SWARM_PATTERNS.md`** — orchestration pattern catalog. Both self-organizing patterns (blackboard, map-reduce, council, stigmergy) and hierarchical patterns (orchestrator-worker, role differentiation, debate+judge, critic loops) are legitimate — picked per run based on the work's shape, not a project-level ideology. The earlier "rejected list" was retired 2026-04-23. Read before building multi-session coordination or preset picker UI.
4. **`docs/ARCHITECTURE.md`** — runtime data-flow, component role map, extension recipes, debugging playbook. Start here when debugging or extending — the operational companion to DESIGN.md's static contracts.
5. **`docs/API.md`** — greppable HTTP endpoint catalog (method · path · body · response · errors). Point callers here instead of answering endpoint questions from memory.
6. **`docs/VALIDATION.md`** — runbook for features shipped but not yet exercised against real runs. Point users here when they ask "how do I verify X actually works?"
7. **`docs/opencode-vocabulary.md`** — canonical opencode SDK part / tool / event names. Use these instead of inventing new terms.

## Check when orienting — not durable, not design

- **`STATUS.md`** — time-scoped snapshot: what shipped recently, what has known rough edges, what's queued. Check when asking "where are we right now?" — NOT when asking "how does X work?" (use the 5 docs above for that). Maintenance: append-only during work; rewrite every couple months.
- **`docs/POSTMORTEMS/`** — forensic reports on run failures. Each postmortem declares fixes + validation procedures; the ledger tracks which fixes shipped and which were verified against which subsequent run. Use as regression probes when babysitting a new run. See `docs/POSTMORTEMS/README.md` for the contract.
- **`docs/PATTERN_DESIGN/`** — per-pattern design contracts: canonical mechanics, signals emitted, proposed observability surface (tab spec), mechanics gaps, ledger. One file per pattern (9 total + README). Use when designing a pattern-specific view, proposing a backend improvement, or verifying a UI change hit the spec. See `docs/PATTERN_DESIGN/README.md` for the contract.

## Always
- Run `npx tsc --noEmit` after edits. The repo is TypeScript strict; type-clean is the bar.
- Use **opencode SDK names** (`task`, `subtask`, `reasoning`, `patch`, `bash`, `grep`, …) — never invented synonyms.
- Match the **dense-factory aesthetic**: h-5/h-6 rows, monospace, `text-micro` (10px) uppercase tracking-widest2 for labels, hairline borders, tabular-nums for numbers, ink-* / fog-* / molten / mint / iris / amber palette only.

## Never
- Mix **declarative and imperative** in the same panel. A modal is either a rules editor (`save` / `reset`) or an action trigger (`spawn` / `send` / `run`). Never both. See `DESIGN.md` §12.
- Add **BYOK / local-model** UI as a selection affordance. Provider universe is `zen` + `go` + `ollama` — all three route through opencode (user configures opencode.json for ollama). History: "zen + go only" was the stance through 2026-04-23; reversed 2026-04-24 after the ollama-max subscription shape proved more economical than opencode-go ceilings + opencode-zen PPT. See DESIGN.md §9.
- Replace canonical opencode names with custom vocabulary "for clarity."
- Default to generic AI design vocabulary (Inter, Roboto, purple gradients on white). The aesthetic is a deliberate point of view.

## Surface contracts (one-line summary)
| Surface | Contract |
|---|---|
| Timeline | Cross-lane events get wires; in-lane events dock as chips. |
| Roster | Identity + status only; details live in inspector drawer. |
| Routing modal | Declarative policy. Saves apply to *next* dispatch. |
| Spawn modal | Imperative. Click = real agent created. |
| Branch history | Read-only. |
| Glossary | Actor/transcript vocabulary only. No API / config / plumbing. |
| Palette | Imperative. Keyboard-first jump and run. |

## When in doubt
Ask the user before adding a feature flag, a backwards-compat shim, or a "for future use" abstraction. This is a prototype — clarity beats optionality.
