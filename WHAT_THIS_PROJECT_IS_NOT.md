# What this project is NOT

A list of design choices we deliberately rejected. Read this before "fixing" something that looks missing — it may be missing on purpose. If you want to revive any of these, open an issue with the rationale; do not just bring them back.

---

## Not a fork of opencode

`opencode_swarm` is a **standalone Next.js prototype** with mocked session data. We did not fork the upstream opencode runtime. Backend wiring is the next phase (see `DESIGN.md` §6) — until then, do not import opencode source, do not embed an opencode binary, do not ship a compiled runtime alongside the UI.

**Why:** prototype-first pattern. Validate the UI surface against mocked state before committing to a fork that would have to track upstream forever.

---

## Not a chat client

The UI is **timeline-centric, not scrollback-centric**. We rejected the chat-pane-on-the-side layout (`components/chat-pane.tsx` is a leftover from early exploration; do not promote it back to a primary surface). Tool calls and agent spawns are first-class visual nodes on a 2-D plane, not log entries to scroll past.

**Why:** the entire premise of swarm is making 5 parallel agents as legible as 1. Chat scroll fails that test the moment a second agent starts.

---

## Not a multi-provider configuration tool

The provider universe is **`zen` (pay-per-token marketplace) and `go` (subscription bundle) only**. We removed:
- BYOK (bring your own key) provider tier
- Local-model selection in the spawn modal
- A "model source" dropdown
- Per-agent provider override outside the routing policy

**Why:** the user explicitly assumes "all users are on opencode zen/go." BYOK and local models are valid in opencode itself but are out of scope for this UI. Adding them back would re-introduce the routing complexity we deliberately collapsed.

---

## Not a desktop window-shell wrapper

We **removed minimize / maximize / close caption buttons** from the topbar. The app runs inside the browser, which already owns those controls. `components/ui/caption-buttons.tsx` exists as a vestige but is unused — do not re-mount it.

**Why:** non-functional UI is worse than absent UI. The browser already provides the controls; duplicating them would dead-click.

---

## Not an imperative routing panel

The routing modal is **declarative policy only**. It sets run-level caps and per-provider soft ceilings; saving applies to the *next dispatched subtask*. We rejected:
- "Force redispatch all running agents" buttons
- "Abort all" / "Pause swarm" actions inside the routing modal
- Real-time slider that re-routes in-flight agents

**Why:** mixing declarative (rules) and imperative (actions) in one panel destroys the user's mental model. See `DESIGN.md` §12. Imperatives belong in the spawn modal, agent inspector, and command palette — never in policy.

---

## Not a glossary of opencode internals

The in-product glossary covers **actor and transcript vocabulary only** — parts (text, reasoning, tool, subtask, patch, …), tools (bash, grep, edit, …), session statuses (idle, busy, retry). We deliberately excluded:
- API endpoint signatures
- Config schema fields
- SDK class hierarchies
- Plumbing types (transports, codecs, retry policies)

**Why:** the glossary is a runtime reference for someone reading the timeline. API/config docs belong in the SDK reference, not in a UI tooltip.

---

## Not a generic AI chat aesthetic

We rejected the AI-app design defaults:
- ❌ Inter / Roboto / Arial / system fonts
- ❌ Purple gradients on white backgrounds
- ❌ Pastel "friendly" palettes
- ❌ Rounded everything, generous whitespace, soft shadows

The aesthetic is **dense-factory**: monospace, tabular-nums, hairline borders, ink-* / fog-* / molten / mint / iris / amber palette, h-5/h-6 row heights, `text-micro` uppercase labels. Linear's polish, Warp's density, Raycast's keyboard feel — *not* ChatGPT, Claude.ai, or Perplexity.

**Why:** the aesthetic is a deliberate point of view. It signals "this is a developer tool" before any text is read.

---

## Not a rich A2A pin / typed-message schema

We considered four A2A communication models — circuit-board (typed pins), bounty-board (broadcast tasks), writers-room (shared whiteboard), subpoena (request-response). **Circuit-board won** because it preserves direct sender→receiver topology on the timeline.

But we then learned opencode itself has **no separate A2A schema**: sub-agent communication happens via the `task` tool and `subtask` parts. So the UI uses opencode's native primitives, not an invented pin taxonomy. Do not re-introduce the typed-pin schema.

**Why:** opencode's `task`-tool A2A is the authoritative model. Inventing a parallel schema would diverge from upstream and create a translation layer we'd have to maintain forever.

---

## Not a chat composer with rich formatting

The composer is a single-line dispatch field with a target picker. We rejected:
- Markdown editor with toolbar
- Slash commands competing with the palette
- Drag-and-drop file attachments
- @-mentions for agent targeting (target picker handles this with a dropdown)

**Why:** the palette (⌘K) is the keyboard surface. The composer is for the one specific job of sending a message. Two surfaces with overlapping affordances confuses users.

---

## Not a "one-size-fits-all roles" system

Roles are **pattern-scoped, not universal**. Self-organizing runs (blackboard, council, stigmergy) have no pinned roles — agents self-select what to work on. Hierarchical runs (orchestrator-worker, role differentiation, debate+judge, critic loops) have explicit roles (`orchestrator`, `worker`, `judge`, `critic`, etc.) because those patterns need them to function. The human picks the pattern that fits the work; the pattern decides whether roles apply.

We still reject:
- ❌ **System-minted "shape" readouts** — inferred labels like "planner-shaped" / "implementer-shaped" computed from observed behavior, applied without pattern context. If a pattern says an agent has a role, the role is declared; nothing is ever derived post-hoc by the system and surfaced as if it were real.
- ❌ **Role as a routing proxy** — `if role=X → provider=Y`. Role scopes *what* an agent does within its pattern; bounds (cost, time, workspace) still drive *which model* gets used.

Identity base: **name + optional self-authored focus line**, with an optional **role** added by hierarchical patterns. On self-organizing runs, roles stay empty. The `observation` eyebrow tooltip in the routing modal explains the difference in-product.

*History note (2026-04-23):* this section previously rejected roles in all forms on a "no supervisor-worker dialectic" principle. Reversed after extended runs demonstrated that hierarchical patterns produce stronger work for mission-shaped tasks. See DESIGN.md §1 and `memory/feedback_no_role_hierarchy.md`.

---

## Not a "select agent first" interaction model

Clicking a timeline node directly focuses it (no need to first select the agent that owns the lane). Clicking empty timeline area releases all selections. We rejected:
- Modal "select agent → then act on its messages" flows
- Right-click context menus as primary affordances
- Multi-select with Shift/Cmd

**Why:** keyboard-first, click-anywhere-to-act. Mode switching is friction; direct manipulation wins.

---

## Not a required-field spawn modal

Agent **name and directive are optional** at spawn. Only the family + model + tools are required. Empty name auto-fills (`agent-03`); empty directive lets the agent "roam and self-negotiate scope." Optional input fields are visually dimmed (dashed border, lower opacity) so the user notices.

**Why:** with frontier models, narrow directives matter for *coordination* in a 5+-agent swarm, not for capability scoping. Forcing the user to write a directive every time would create busywork without improving outcomes.

---

## Not authenticated, not multi-tenant, not yet

There is no auth UI. The `kk` chip in the topbar is a placeholder. There is no run picker, no team scoping, no per-user budget. These belong to the post-prototype phase (`DESIGN.md` §6, Phase 4) and should not be added piecemeal before then.

**Why:** auth and multi-tenancy require backend decisions that haven't been made. Mocking them in the UI would lock us into shapes we'd have to reverse later.

---

## Not a "show inspector" footer button

The inspector opens automatically when you click a timeline node or agent row. We **removed the footer toggle button** because:
- Modern users dismiss panels by clicking outside them
- The button was disabled when no message/agent was selected — a dead-state with no value
- The drawer's own × close is sufficient

**Why:** redundant affordances clutter the status rail. Click-outside-to-dismiss is the universal pattern.

---

## The discipline behind this list

Every item here was once a real proposal that someone (often me) thought was a good idea. Each was rejected for a *specific* reason recorded above. If you find yourself re-discovering one of these — you're probably right that the gap exists — but read the rationale before adding it back, because the rationale usually still applies.

**Default:** when in doubt, do less. Prototypes drown in optionality.
