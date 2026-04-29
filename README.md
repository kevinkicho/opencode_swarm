# opencode_swarm

> Multi-agent coding swarm for opencode. Point it at a repo, pick an orchestration pattern, watch N agents coordinate through a 2-D timeline — one lane per agent, time flowing downward, every tool call and coordination event a first-class visual node.

Built for keyboard-first developers who want to read a 5-agent run as easily as a 1-agent run. Dense, monospace, no chat scrollback — think Linear polish meets Warp density meets Raycast keyboard feel.

## Status

**Functioning prototype.** The UI surface is complete and the backend is wired to real opencode sessions. Six orchestration patterns ship end-to-end (`blackboard`, `council`, `orchestrator-worker`, `debate-judge`, `critic-loop`, `map-reduce`) plus `none` (single-session opencode native) — see [`docs/PATTERNS.md`](./docs/PATTERNS.md) for one-paragraph descriptions and reliability profiles. Default landing view is `chat` (per-turn bubbles with inline tool pills); `timeline` and `cards` are one click away.

Personal-use tooling — no auth, no multi-tenancy, never SaaS. By design, not a deferred feature.

## Stack

Next.js 14 (App Router) · TypeScript strict · Tailwind · framer-motion · cmdk · @floating-ui/react · better-sqlite3 (blackboard state + memory) · opencode SDK over HTTP.

## Prerequisites

**A reachable opencode instance is required.** This app is a UI + orchestration layer on top of opencode — there is no local execution fallback. Every pattern routes through it. If `OPENCODE_URL` can't be reached, run creation returns 502 and live views stall.

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

The dev server is pinned to **port 8044** (override via `DEV_PORT=xxxx`). `scripts/dev.mjs` kills any process holding the port before claiming it, so a stale leftover never blocks startup. The `.dev-port` file is still written for callers that read it, and tabs auto-reload on dev-server restart via `/api/dev/build-id` so stale browser state never lingers. Open `http://localhost:8044/` (or, on WSL2 with a Windows browser, the WSL eth0 IP — `ifconfig eth0` for the address).

Point the app at an already-cloned repo via the new-run modal (⌘N), pick a pattern, hit spawn. Agents claim work, edit files, land patches, your chosen view (chat by default) populates live.

## Keyboard

- **⌘K / Ctrl+K** — command palette (jump to any timeline node, run an action)
- **⌘N / Ctrl+N** — open new-run modal
- **Esc** — close any open modal or drawer

## Documentation

### Canonical (read in order when extending)

1. **[`DESIGN.md`](./DESIGN.md)** — vision, mental model, UI surface map, state contracts, retention, planning model. The one document nothing else replaces.
2. **[`docs/opencode-quirks.md`](./docs/opencode-quirks.md)** — opencode SDK v1.14.28 vocabulary + HTTP API behaviors (silent-drop traps, model-format shape, workspace path encoding, zombie turns, phantom events).
3. **[`docs/PATTERNS.md`](./docs/PATTERNS.md)** — orchestration pattern cheatsheet (one paragraph each + reliability tiers).
4. **[`docs/API.md`](./docs/API.md)** — greppable HTTP endpoint catalog for our routes.
5. **[`docs/VALIDATION.md`](./docs/VALIDATION.md)** — runbook for features shipped but not yet exercised live.
6. **[`CLAUDE.md`](./CLAUDE.md)** — briefing for AI agents opening the repo.

### Situational (read when relevant)

- **[`STATUS.md`](./STATUS.md)** — what shipped + what's queued right now. Time-scoped — re-check before assuming.
- **[`docs/CALL_GRAPH.md`](./docs/CALL_GRAPH.md)** — generated function-call graph across the repo. Useful for "where is this function called from?" without having to grep.
- **[`docs/REVIEW_CHECKLIST.md`](./docs/REVIEW_CHECKLIST.md)** — 30-minute structured walk-through that exercises every major surface of the app. Run before PR, after upgrades, or when re-orienting.

### Postmortems

- **[`docs/POSTMORTEMS/`](./docs/POSTMORTEMS/)** — forensic notes on run failures + notable near-misses. Every entry has *what broke*, *why*, *what we did*, and *how we'd know it regressed* (with the regression probe). Re-run probes after upgrades to catch recurrences. See the [POSTMORTEMS index](./docs/POSTMORTEMS/README.md) for the shape contract.

  Recent (chronological):
  - [2026-04-24 — orchestrator-worker silent dispatch](./docs/POSTMORTEMS/2026-04-24-orchestrator-worker-silent.md)
  - [2026-04-25 — agent-name silent drop trap](./docs/POSTMORTEMS/2026-04-25-agent-name-silent-drop.md)
  - [2026-04-26 — critic-loop runaway tokens](./docs/POSTMORTEMS/2026-04-26-critic-loop-runaway-token.md)
  - [2026-04-27 — blackboard recording diagnostic](./docs/POSTMORTEMS/2026-04-27-blackboard-recording-diagnostic.md)
  - [2026-04-27 — pattern-sweep validation](./docs/POSTMORTEMS/2026-04-27-pattern-sweep-validation.md)
  - [2026-04-27 — natural-stop fixes (council convergence + OW auto-idle)](./docs/POSTMORTEMS/2026-04-27-natural-stop-fixes.md)
  - [2026-04-27 — extended blackboard run (periodic re-sweeps)](./docs/POSTMORTEMS/2026-04-27-extended-blackboard-run.md)

### In-app reference

The **glossary modal** (footer right · `glossary`) covers actor/transcript vocabulary at a glance. The **diagnostics modal** (footer right · `diagnostics`) surfaces the live opencode daemon state — tool catalog, MCP servers, effective `opencode.json`, user-defined commands — with a drift indicator vs. the static `ToolName` union.

## Design stance

- **Chat is the landing lens; timeline is the power lens.** Chat (per-turn bubbles, inline tool pills, multi-session user prompts deduped) reads like every other agent product, so first-time users find their footing. Timeline shows N agents as visual nodes on a 2-D plane and is where 5-agent runs become as legible as 1-agent runs. Both ship; click to switch.
- **All 10 view tabs always visible.** Non-applicable tabs (e.g. `iterations` outside critic-loop) render dim and lead to a per-view explainer with a 7×10 patterns × views availability matrix. Discoverable without docs.
- **Roles are pattern-scoped, not universal.** Self-organizing patterns (blackboard, council) have no pinned roles — agents self-select work within run bounds. Hierarchical patterns carry explicit roles when the work needs them. Routing stays bounds-driven either way; `if role=X → provider=Y` remains off-limits.
- **Declarative and imperative separated.** The routing modal sets policy (saves apply to the next dispatch); the spawn modal and palette trigger actions. Never both in one panel.
- **Dense-factory aesthetic.** Monospace, tabular-nums, hairline borders, h-5/h-6 rows, `text-micro` uppercase labels. Not a ChatGPT/Perplexity/Claude.ai clone.
- **Three provider tiers: `zen` + `go` + `ollama`** (plus `byok` when opencode.json carries a BYOK provider block). All routed through opencode. The new-run team picker and the spawn-agent modal both gate by tier filter chips with per-tier counts, so picking a model implicitly picks a billing path. Each tier has a different shape — zen pay-per-token, go subscription bundle, ollama max subscription.

## Contributing

Opening a PR? Read `DESIGN.md` first — the one rule (single contracts per surface) catches most drift before review.

## License

MIT
