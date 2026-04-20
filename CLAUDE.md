# CLAUDE.md

Briefing for Claude Code (and any agent that respects this convention) opening this repo.

## Read these first
1. **`DESIGN.md`** — vision, mental model, opencode SDK vocabulary, data contracts, backend wiring plan, decisions already made. Do not write code without reading it.
2. **`WHAT_THIS_PROJECT_IS_NOT.md`** — design choices we explicitly rejected. Read before "fixing" something that looks missing — it may be missing on purpose.
3. **`docs/opencode-vocabulary.md`** — canonical opencode SDK part / tool / event names. Use these instead of inventing new terms.

## Always
- Run `npx tsc --noEmit` after edits. The repo is TypeScript strict; type-clean is the bar.
- Use **opencode SDK names** (`task`, `subtask`, `reasoning`, `patch`, `bash`, `grep`, …) — never invented synonyms.
- Match the **dense-factory aesthetic**: h-5/h-6 rows, monospace, `text-micro` (10px) uppercase tracking-widest2 for labels, hairline borders, tabular-nums for numbers, ink-* / fog-* / molten / mint / iris / amber palette only.

## Never
- Mix **declarative and imperative** in the same panel. A modal is either a rules editor (`save` / `reset`) or an action trigger (`spawn` / `send` / `run`). Never both. See `DESIGN.md` §10.
- Add **BYOK / local-model** UI. Provider universe is `zen` + `go` only.
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
