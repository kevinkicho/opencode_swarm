# opencode_swarm

> Multi-agent coding swarm for opencode. Point it at a repo, pick an orchestration pattern, watch N agents coordinate through a 2-D timeline — one lane per agent, time flowing downward, every tool call and coordination event a first-class visual node.

Built for keyboard-first developers who want to read a 5-agent run as easily as a 1-agent run. Dense, monospace, no chat scrollback — think Linear polish meets Warp density meets Raycast keyboard feel.

## Status

**Functioning prototype.** The UI surface is complete and the backend is wired to real opencode sessions. Nine orchestration patterns ship end-to-end (blackboard, council, stigmergy, orchestrator-worker, role-differentiated, debate-judge, critic-loop, deliberate-execute, map-reduce) — see [`docs/PATTERNS.md`](./docs/PATTERNS.md) for one-paragraph descriptions and reliability profiles.

Personal-use tooling — no auth, no multi-tenancy, never SaaS. By design, not a deferred feature.

## Stack

Next.js 14 (App Router) · TypeScript strict · Tailwind · framer-motion · cmdk · @floating-ui/react · better-sqlite3 (blackboard state + memory) · opencode SDK over HTTP.

## Prerequisites

**A reachable opencode instance is required.** This app is a UI + orchestration layer on top of opencode — there is no local execution fallback. Every pattern (blackboard, map-reduce, council, critic-loop, debate-judge, role-differentiated, deliberate-execute) routes through it. If `OPENCODE_URL` can't be reached, run creation returns 502 and live views stall.

- `OPENCODE_URL` — base URL of your opencode instance. Default `http://localhost:4096`; this repo currently targets `http://172.24.32.1:4097` (WSL → Windows host bridge, see `scripts/dev.mjs`). The `:4097` port is deliberate — `:4096` is reserved for the sibling ollama-swarm app.
- `OPENCODE_BASIC_USER` / `OPENCODE_BASIC_PASS` — HTTP Basic auth, if your opencode enforces it. Server-side only; never prefix with `NEXT_PUBLIC_`. Leave empty when auth is off.
- Optional: `OPENCODE_SWARM_ROOT` (runs dir override), `OPENCODE_LOG_DIR` (opencode's own log path — powers the Zen-429 vs. frozen distinction in the liveness watchdog), `DEMO_LOG_AUTO_DELETE` / `DEMO_LOG_RETENTION_DAYS` (event-log pruning), `OPENCODE_RESTART_CMD` (optional shell command the frozen watchdog runs to restart opencode).
- See `.env.example` for the full schema with comments.

**To use the `ollama` provider tier:** configure your `opencode.json` (or equivalent opencode config) with a provider block that routes the `ollama/*:cloud` model IDs to ollama's cloud API. Requires an ollama account with a max plan subscription. The [`ollama_swarm`](https://github.com/kevinkicho/ollama_swarm) sibling project is a working example of ollama integration at the raw-swarm level if you want a reference for the provider block shape. Without this opencode.json configuration, `ollama/*` model selections in new-run-modal will fail to dispatch — opencode needs to know how to reach the ollama API.

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

1. **[`DESIGN.md`](./DESIGN.md)** — vision, mental model, UI surface map, state contracts, retention, planning model. The one document nothing else replaces.
2. **[`docs/opencode-quirks.md`](./docs/opencode-quirks.md)** — opencode SDK vocabulary + HTTP API behaviors (silent-drop traps, model-format shape, workspace path encoding, zombie turns).
3. **[`docs/PATTERNS.md`](./docs/PATTERNS.md)** — orchestration pattern cheatsheet (one paragraph each + reliability tiers).
4. **[`docs/API.md`](./docs/API.md)** — greppable HTTP endpoint catalog for our routes.
5. **[`docs/VALIDATION.md`](./docs/VALIDATION.md)** — runbook for features shipped but not yet exercised live.
6. **[`CLAUDE.md`](./CLAUDE.md)** — briefing for AI agents opening the repo.

In-app, the **glossary modal** (footer link) covers actor/transcript vocabulary at a glance.

## Design stance

- **Timeline-centric, not chat-centric.** Tool calls and agent spawns are visual nodes on a 2-D plane, not log entries. 5 agents must be as legible as 1.
- **Roles are pattern-scoped, not universal.** Self-organizing patterns (blackboard, council, stigmergy) have no pinned roles — agents self-select work within run bounds. Hierarchical patterns (orchestrator-worker, role-differentiated, debate-judge, critic-loop, deliberate-execute) carry explicit roles when the work needs them. Routing stays bounds-driven either way; `if role=X → provider=Y` remains off-limits.
- **Declarative and imperative separated.** The routing modal sets policy (saves apply to the next dispatch); the spawn modal and palette trigger actions. Never both in one panel.
- **Dense-factory aesthetic.** Monospace, tabular-nums, hairline borders, h-5/h-6 rows, `text-micro` uppercase labels. Not a ChatGPT/Perplexity/Claude.ai clone.
- **Three provider tiers: `zen` + `go` + `ollama`.** All three route through opencode (configure `opencode.json` for the ollama provider). No BYOK UI, no local-model picker as a selection affordance — each tier has a different billing/limit shape (zen pay-per-token, go subscription bundle, ollama max subscription).

## Contributing

Opening a PR? Read `DESIGN.md` first — the one rule (single contracts per surface) catches most drift before review.

## License

MIT
