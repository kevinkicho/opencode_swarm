# opencode_swarm

> Multi-agent coding swarm for opencode. Spawn specialist agents, route work by declarative policy, watch every tool call and decision land on a per-agent timeline. — **UI prototype only, mock data, no backend yet.**

`opencode_swarm` reimagines the opencode session view as a 2-D timeline: one lane per agent, time flowing downward, and every tool call / sub-agent spawn / routing decision rendered as a first-class visual node. Built for keyboard-first developers who want to read a 5-agent run as easily as a 1-agent run.

## Status

- **Stack:** Next.js 14 (App Router) · TypeScript · Tailwind CSS · framer-motion · cmdk · @floating-ui/react
- **Data:** all mocked in `lib/swarm-data.ts` — no opencode runtime is wired in
- **What works:** the entire interactive UI surface (timeline, roster, inspector, palette, routing policy modal, spawn modal, branch history, glossary, composer)
- **What's missing:** the backend — see [`DESIGN.md`](./DESIGN.md) §6 for the wiring plan

## Quick start

```bash
npm install
npm run dev
# open http://localhost:3000
```

That's it — there is nothing to configure. The UI boots straight into a mocked run with five agents already running.

## Keyboard

- **⌘K / Ctrl+K** — open the command palette (jump to any timeline node, run an action)
- **Esc** — close any open modal or drawer

## Architecture

The single most important document is **[`DESIGN.md`](./DESIGN.md)**. It explains:

- The mental model (why timeline-centric, not chat-centric)
- opencode SDK vocabulary alignment (sessions, parts, tools, events)
- The component map and per-modal contracts
- The data shapes the UI consumes
- **The phased plan for wiring a real backend** (read-only mirror → control plane → branch history → multi-tenant)
- Decisions already made (so contributors don't re-litigate them)
- Open design questions

If you are about to write backend code or extend the UI, read `DESIGN.md` first.

Secondary references:
- [`docs/opencode-vocabulary.md`](./docs/opencode-vocabulary.md) — canonical opencode SDK names
- In-product **glossary modal** (footer link) — actor/transcript vocabulary at a glance

## Contributing

This is a pre-backend prototype. Issues and PRs that:
- ✅ Refine the UI surface, fix visual bugs, add timeline interactions
- ✅ Sketch a backend integration against the `lib/swarm-types.ts` contracts
- ✅ Improve the design plan based on real opencode SDK behavior

are all welcome. Before opening a feature PR, read `DESIGN.md` §12 — the one rule about surface contracts.

## License

TBD
