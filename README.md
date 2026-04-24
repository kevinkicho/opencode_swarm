# opencode_swarm

> Multi-agent coding swarm for opencode. Point it at a repo, pick an orchestration pattern, watch N agents coordinate through a 2-D timeline — one lane per agent, time flowing downward, every tool call and coordination event a first-class visual node.

Built for keyboard-first developers who want to read a 5-agent run as easily as a 1-agent run. Dense, monospace, no chat scrollback — think Linear polish meets Warp density meets Raycast keyboard feel.

## Status

**Functioning prototype.** The UI surface is complete and the backend is wired to real opencode sessions.

Three orchestration patterns ship end-to-end:

| Pattern | What it does |
|---|---|
| **blackboard** | Planner emits atomic todos onto a shared board; N sessions claim via CAS, execute, post file hashes back. |
| **map-reduce** | N sessions work a directive in parallel, then one wins a blackboard claim to synthesize a unified output. |
| **council** | Multiple sessions work the same directive; reconcile actions surface divergent outputs for human merge. |

Non-goals: see [`WHAT_THIS_PROJECT_IS_NOT.md`](./WHAT_THIS_PROJECT_IS_NOT.md). This is personal-use tooling — no auth, no multi-tenancy, never SaaS.

## Stack

Next.js 14 (App Router) · TypeScript strict · Tailwind · framer-motion · cmdk · @floating-ui/react · better-sqlite3 (blackboard state + memory) · opencode SDK over HTTP.

## Prerequisites

**A reachable opencode instance is required.** This app is a UI + orchestration layer on top of opencode — there is no local execution fallback. Every pattern (blackboard, map-reduce, council, critic-loop, debate-judge, role-differentiated, deliberate-execute) routes through it. If `OPENCODE_URL` can't be reached, run creation returns 502 and live views stall.

- `OPENCODE_URL` — base URL of your opencode instance. Default `http://localhost:4096`; this repo currently targets `http://172.24.32.1:4097` (WSL → Windows host bridge, see `scripts/dev.mjs`). The `:4097` port is deliberate — `:4096` is reserved for the sibling ollama-swarm app.
- `OPENCODE_BASIC_USER` / `OPENCODE_BASIC_PASS` — HTTP Basic auth, if your opencode enforces it. Server-side only; never prefix with `NEXT_PUBLIC_`. Leave empty when auth is off.
- Optional: `OPENCODE_SWARM_ROOT` (runs dir override), `OPENCODE_LOG_DIR` (opencode's own log path — powers the Zen-429 vs. frozen distinction in the liveness watchdog), `DEMO_LOG_AUTO_DELETE` / `DEMO_LOG_RETENTION_DAYS` (event-log pruning).
- See `.env.example` for the full schema with comments.

Node + npm — any version that runs Next.js 14. SQLite is bundled via `better-sqlite3`; no separate DB to install.

## Quick start

```bash
npm install
npm run dev
```

The dev server rolls a sticky random port on first run and writes it to `.dev-port` so your bookmarked tab keeps working across restarts. Open whatever URL the console prints.

Point the app at an already-cloned repo via the new-run modal (⌘N), pick a pattern, hit spawn. Agents claim work, edit files, land patches, timeline populates live.

## Keyboard

- **⌘K / Ctrl+K** — command palette (jump to any timeline node, run an action)
- **⌘N / Ctrl+N** — open new-run modal
- **Esc** — close any open modal or drawer

## Documentation

Read in order when extending:

1. **[`DESIGN.md`](./DESIGN.md)** — vision, data contracts, surface-by-surface design decisions. The one document nothing else replaces.
2. **[`WHAT_THIS_PROJECT_IS_NOT.md`](./WHAT_THIS_PROJECT_IS_NOT.md)** — rejected design choices, with rationale. Read before "fixing" something that looks missing.
3. **[`SWARM_PATTERNS.md`](./SWARM_PATTERNS.md)** — orchestration pattern catalog + status (shipped, in progress, rejected).
4. **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)** — runtime data flow, component map, debugging playbook.
5. **[`docs/opencode-vocabulary.md`](./docs/opencode-vocabulary.md)** — canonical opencode SDK names (use these, don't invent synonyms).
6. **[`CLAUDE.md`](./CLAUDE.md)** — briefing for AI agents opening the repo.

In-app, the **glossary modal** (footer link) covers actor/transcript vocabulary at a glance.

## Design stance

- **Timeline-centric, not chat-centric.** Tool calls and agent spawns are visual nodes on a 2-D plane, not log entries. 5 agents must be as legible as 1.
- **Roles are pattern-scoped, not universal.** Self-organizing patterns (blackboard, council, stigmergy) have no pinned roles — agents self-select work within run bounds. Hierarchical patterns (orchestrator-worker, role differentiation, debate+judge, critic-loop, deliberate-execute) CAN pin roles when the pattern needs them, and those roles are visible in the UI. Routing stays bounds-driven either way; `if role=X → provider=Y` remains off-limits. See `DESIGN.md` §1 "On roles" for the 2026-04-23 stance reversal behind this.
- **Declarative and imperative separated.** The routing modal sets policy (saves apply to the next dispatch); the spawn modal and palette trigger actions. Never both in one panel.
- **Dense-factory aesthetic.** Monospace, tabular-nums, hairline borders, h-5/h-6 rows, `text-micro` uppercase labels. Not a ChatGPT/Perplexity/Claude.ai clone.
- **Provider universe is `zen` + `go` only.** No BYOK UI, no local-model picker.

## Contributing

Opening a PR? Read `DESIGN.md` §12 (surface contracts) and `WHAT_THIS_PROJECT_IS_NOT.md` first — those catch most drift before review.

## License

TBD
