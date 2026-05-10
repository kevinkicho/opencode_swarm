# opencode_swarm

> ⚠️ **Work in progress.** This prototype is under active development and is frequently a target of automated improvement by swarms of agents. Expect rapid iteration, occasional breakage, and new analysis documents appearing between commits. The current postmortem rate is tracked at [`scripts/pm-frequency.ts`](./scripts/pm-frequency.ts) — run it to see the project's health.

> Multi-agent coding swarm for opencode. Point it at a repo, pick an orchestration pattern, watch N agents coordinate through a 2-D timeline — one lane per agent, time flowing downward, every tool call and coordination event a first-class visual node.

Built for keyboard-first developers who want to read a 5-agent run as easily as a 1-agent run. Dense, monospace, no chat scrollback — think Linear polish meets Warp density meets Raycast keyboard feel.

## Table of Contents

| Section | Description |
|---------|-------------|
| [Screenshots](#screenshots) | Highlight features in 4 captures |
| [Status](#status) | Current project state |
| [Quick Start](#quick-start) | Get running in 2 commands |
| [Architecture](#architecture-overview) | System overview |
| [Documentation](#documentation) | All docs organized by purpose |
| [Development](#development-commands) | Commands and scripts |
| [Design Stance](#design-stance) | Philosophy and conventions |
| [Contributing](#contributing) | PR guidelines |

## Screenshots

> Coming soon — automated screenshot capture during live validation run.

<!-- SCREENSHOTS: 2x2 tile grid -->
<!-- 1. New-run modal with pattern recommender + templates -->
<!-- 2. 2D timeline with cross-lane wires + tool chips -->
<!-- 3. Board rail with filter chips + cost-per-todo badge -->
<!-- 4. Run retro modal with agent scoring table -->

## Status

**Functioning prototype.** The UI surface is complete and the backend is wired to real opencode sessions. **Seven orchestration patterns** ship end-to-end (`blackboard`, `council`, `orchestrator-worker`, `debate-judge`, `critic-loop`, `map-reduce`, `pipeline`) plus `none` (single-session opencode native) — see [`docs/PATTERNS.md`](./docs/PATTERNS.md) for one-paragraph descriptions and reliability profiles.

**2026-05-09 update**: Comprehensive strategic analysis session. 12 methodologies applied (Ansoff through Formal Methods 2.0), 50+ code changes, 57 new tests, 20 analysis documents, 8 scripts. All 19 composite plan items shipped. Queue empty. See [`STATUS.md`](./STATUS.md) for details.

Personal-use tooling — no auth, no multi-tenancy, never SaaS. By design, not a deferred feature.

## Stack

Next.js 14 (App Router) · TypeScript strict · Tailwind · framer-motion · cmdk · @floating-ui/react · better-sqlite3 (blackboard state + memory) · opencode SDK over HTTP.

## Prerequisites

**A reachable opencode instance is required.** This app is a UI + orchestration layer on top of opencode — there is no local execution fallback. Every pattern routes through it. If `OPENCODE_URL` can't be reached, run creation returns 502 and live views stall.

## Quick Start

```bash
npm install
npm run dev
```

The dev server is pinned to **port 8044** (override via `DEV_PORT=xxxx`). Open `http://localhost:8044/`.

Point the app at an already-cloned repo via the new-run modal (⌘N), pick a pattern, hit spawn. Agents claim work, edit files, land patches, your chosen view populates live.

## Architecture Overview

Opencode Swarm is a Next.js application that provides a multi-agent orchestration UI. The architecture consists of:

- **Frontend**: React (Next.js 14 App Router), TypeScript, Tailwind CSS.
- **Backend**: Next.js API routes and server-side logic that orchestrate opencode sessions.
- **Orchestration Layer**: Seven coordination patterns. Each pattern defines how agents collaborate.
- **Persistence**: better-sqlite3 for run transcripts, agent states, event logs.
- **Integration**: Communicates with an external opencode instance via HTTP.

## Documentation

### Core (read in order when extending)

| # | Document | Purpose |
|---|----------|---------|
| 1 | [`DESIGN.md`](./DESIGN.md) | Vision, mental model, UI surface, state contracts, retention |
| 2 | [`docs/opencode-quirks.md`](./docs/opencode-quirks.md) | opencode SDK vocabulary + HTTP API behaviors |
| 3 | [`docs/PATTERNS.md`](./docs/PATTERNS.md) | Orchestration pattern cheatsheet + reliability tiers |
| 4 | [`docs/API.md`](./docs/API.md) | HTTP endpoint catalog for our routes |
| 5 | [`docs/VALIDATION.md`](./docs/VALIDATION.md) | Runbook for features not yet exercised live |
| 6 | [`CLAUDE.md`](./CLAUDE.md) | Briefing for AI agents opening the repo |

### Operational

| Document | Purpose |
|----------|---------|
| [`STATUS.md`](./STATUS.md) | What shipped, what's queued — time-scoped |
| [`docs/REVIEW_CHECKLIST.md`](./docs/REVIEW_CHECKLIST.md) | 30-minute structured walk-through |
| [`docs/RECOMMENDATIONS.md`](./docs/RECOMMENDATIONS.md) | Single-source queue + stop-doing list + steady-state conditions |
| [`docs/IMPLEMENTATION_PLAN.md`](./docs/IMPLEMENTATION_PLAN.md) | Consolidated plan from composite analysis |

### Strategic Analysis (12 methodologies, 2026-05-08/09)

| Document | Methodology | Key Finding |
|----------|------------|-------------|
| [`docs/STRATEGY.md`](./docs/STRATEGY.md) | Ansoff + Scenario Planning | Penetration > development; B/D defensive posture |
| [`docs/SYSTEMATIC_FIXES.md`](./docs/SYSTEMATIC_FIXES.md) | Root cause analysis | Unmanaged session context |
| [`docs/MONTE_CARLO.md`](./docs/MONTE_CARLO.md) | Probabilistic simulation (3,000 trials) | $0.034/todo; cost cap stops 93% of runs |
| [`docs/LCCA.md`](./docs/LCCA.md) | Life cycle cost analysis | Operator time 945× more expensive than tokens |
| [`docs/FAULT_TREE.md`](./docs/FAULT_TREE.md) | Fault tree (14 cut sets) | 7 single-event OR-gates at planner |
| [`docs/COMPOSITE_PLAN.md`](./docs/COMPOSITE_PLAN.md) | 5-analysis synthesis | 6 shared findings, 4 plans |
| [`docs/UML_ANALYSIS.md`](./docs/UML_ANALYSIS.md) | Class/state/sequence/component | 55-import type hub, missing transitions |
| [`docs/ARCHITECTURE_EVALUATION.md`](./docs/ARCHITECTURE_EVALUATION.md) | ATAM/SAAM/CBAM/DSM | 4 sensitivity points, 6 recommendations |
| [`docs/FORMAL_METHODS.md`](./docs/FORMAL_METHODS.md) | TLA+/Alloy/Invariants | CAS race-free (proved), 3 of 4 invariants hold |
| [`docs/FORMAL_METHODS_2.md`](./docs/FORMAL_METHODS_2.md) | Refinement/LTL/Data Flow | SQL refines abstract spec; unsanitized directive found |
| [`docs/PERFORMANCE.md`](./docs/PERFORMANCE.md) | Load testing + benchmarking | LLM dominates 96-98%; code ops save <4% |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | SAST/SCA/DAST/PenTest | 0 CRITICAL (local-only), 3 HIGH (all fixed) |

### Scripts

| Script | Purpose |
|--------|---------|
| [`scripts/monte-carlo.ts`](./scripts/monte-carlo.ts) | 3,000-trial probabilistic simulation |
| [`scripts/pm-frequency.ts`](./scripts/pm-frequency.ts) | Postmortem frequency tracker |
| [`scripts/decide.ts`](./scripts/decide.ts) | 6-rule automated decision engine |
| [`scripts/perf-bench.ts`](./scripts/perf-bench.ts) | Performance benchmark |
| [`scripts/lcca-calc.ts`](./scripts/lcca-calc.ts) | LCCA break-even calculator |
| [`scripts/import-graph.ts`](./scripts/import-graph.ts) | Module dependency analyzer |
| [`scripts/frame-extract.ts`](./scripts/frame-extract.ts) | Playwright video → frame extraction |
| [`scripts/morning-summary.ts`](./scripts/morning-summary.ts) | Overnight run summary (cron) |

### Postmortems

| Document | Status |
|----------|--------|
| [`2026-04-24-orchestrator-worker-silent`](./docs/POSTMORTEMS/2026-04-24-orchestrator-worker-silent.md) | F1/F3/F6 VERIFIED |
| [`2026-04-25-agent-name-silent-drop`](./docs/POSTMORTEMS/2026-04-25-agent-name-silent-drop.md) | F1 VERIFIED. Closed |
| [`2026-04-26-critic-loop-runaway-token`](./docs/POSTMORTEMS/2026-04-26-critic-loop-runaway-token.md) | F1 VERIFIED |
| [`2026-05-08-blackboard-planner-sweep-error`](./docs/POSTMORTEMS/2026-05-08-blackboard-planner-sweep-error.md) | F1–F4 SHIPPED |

## Development Commands

- `npm run dev` — Start dev server at port 8044
- `npm run build` — Production build
- `npm run start` — Production server
- `npm test` — Run test suite (713 tests)
- `npm run lint` — ESLint

## Keyboard

- **⌘K / Ctrl+K** — command palette
- **⌘N / Ctrl+N** — new-run modal
- **Esc** — close any modal or drawer

## Design Stance

- **Chat is the landing lens; timeline is the power lens.**
- **All 10 view tabs always visible.**
- **Roles are pattern-scoped, not universal.**
- **Declarative and imperative separated.**
- **Dense-factory aesthetic** — monospace, tabular-nums, hairline borders.
- **Three provider tiers: `zen` + `go` + `ollama`** (plus `byok`).

## Contributing

Read `DESIGN.md` first — the one rule (single contracts per surface) catches most drift before review.

## License

MIT
