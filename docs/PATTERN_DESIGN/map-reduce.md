# Pattern: map-reduce

**Status:** shipped, unvalidated
**Session topology:** N sessions fan out on disjoint scopes (MAP); any idle session claims the synthesis todo (REDUCE)
**Observability maturity:** medium — synthesis-strip exists; no timeline of map-phase progress

## 1 · Mechanics

Classic map-reduce laid over the blackboard store. Two distinct phases.

- **Kickoff:** `runMapReduceKickoff` (lib/server/map-reduce.ts).
  Discovers top-level workspace directories, round-robin buckets
  them across N sessions (`buildScopedDirective`, file:98-114).
  Each session receives base-directive + scope annotation as its
  kickoff message — no shared transcript, independent work.
- **MAP phase:** sessions operate in parallel on their assigned
  slices. No board activity during this phase.
- **Sync point:** background orchestrator calls
  `waitForSessionIdle` on every session. When all sessions idle,
  MAP is complete.
- **Harvest:** for each session, extract latest assistant text
  (`extractLatestAssistantText`, file:51-61) — this is each member's
  draft.
- **REDUCE phase (v2):** a single board item with
  `kind='synthesize'` and deterministic id `synth_<swarmRunID>` is
  inserted. Its content is the synthesis prompt with every member
  draft embedded. The coordinator posts the item's content verbatim
  (skipping the normal edit-files preamble). Any idle session can
  claim it (CAS-safe, deterministic id = idempotent).
- **Termination:** synthesize item transitions to done. Run is
  complete.

The v2 shape (board-mediated synthesis with deterministic id) was
chosen to fix a v1 bug where posting directly to `sessionIDs[0]`
produced duplicate synthesis attempts on retry.

## 2 · Signals already emitted

- Per-session scope annotation (`buildScopedDirective`) — which
  top-level dirs this session covers
- Per-session idle status from `waitForSessionIdle`
- Per-member draft text (latest assistant text at sync point)
- Per-member draft length + touched-files count (from patch parts)
- Synthesize board item with `kind='synthesize'` and
  `ownerAgentId` set when claimed
- `ownerAgentId` on the synthesize item tells us which session won
  the claim (and therefore which one ran the reduce)

What's NOT surfaced today:
- Per-session touched-files breakdown during map phase
- Draft-length distribution across members (did member 3 write
  4 lines while member 1 wrote 200?)
- Synthesis claim latency (how long the item sat open)

## 3 · Observability surface

### Existing
- `components/synthesis-strip.tsx` — above-composer strip when
  `pattern === 'map-reduce'`. Shows per-member draft pills and
  transitions through `awaiting-synthesis` → `synthesizing…` →
  `ready`. Click a pill jumps to that member's transcript.

### Proposed — `map` tab

**Scope:** `pattern === 'map-reduce'`. Left-panel tab group.

**Layout:** two collapsible sections stacked vertically.

**§ MAP** — one row per session. h-5, monospace.

| col | content | width |
|---|---|---|
| glyph | session glyph (accent + short label, e.g. `s1`) | 40px |
| scope | joined scope dirs, ellipsized | flex |
| status | `working` / `idle` / `failed` chip | 60px |
| output | draft length in lines (tabular-nums) | 48px |
| files | touched file count | 32px |
| tokens | session's total tokens (tabular-nums) | 48px |

**§ REDUCE** — one row, sticky bottom when synthesize exists.

| col | content | width |
|---|---|---|
| glyph | synthesize glyph (`⬢` in iris) | 16px |
| item | `synth_<...>` id short form | 80px |
| status | `awaiting` / `claimed` / `running` / `done` / `stale` | 80px |
| owner | claimant session glyph + accent | 32px |
| elapsed | time since claim (tabular-nums `Xm`) | 48px |
| output | synthesis text length in lines | 48px |

**Header chips:** `MAP: N/N idle · Y synthesizing · Z ready`.

**Phase transition banner:** when MAP completes and REDUCE starts,
render a single-line iris accent banner "MAP complete — synthesizer
dispatched". Disappears once REDUCE done.

**Empty state:** `no scopes assigned yet` if kickoff hasn't run;
`map in progress — 2/5 sessions idle` during map phase.

## 4 · Mechanics gaps

### I1 · Synthesis-critic gate

Synthesize output is shipped as-is. If it's shallow or fails to
incorporate key findings across members, there's no correction.
Add optional `enableSynthesisCritic` with a dedicated
`synthesisCriticSessionID`. After synthesizer idles, critic
reviews the synthesis against the member drafts and returns
APPROVED / REVISE + specific feedback. On REVISE, loop the
synthesizer back with feedback; cap at 2 revisions.

### I2 · Scope imbalance detection

Round-robin bucketing of top-level dirs is naive: one dir may have
10x the code of another. After kickoff, estimate lines-of-code
per scope and WARN in the dev log if the ratio of largest:smallest
scope >5x. Optional auto-redistribution on future runs.

### I3 · Partial-map tolerance

Today the synthesis waits for ALL map sessions to idle. If one
session fails (model unavailable, hung turn), the entire run
stalls. Add a
`partialMapTolerance: { minMembers: 3, maxMemberFailures: 2 }`
knob. If ≥minMembers idle AND ≤maxMemberFailures errored, proceed
to synthesis with the available drafts and a note "<N> members
failed, synthesis based on <M> drafts."

### I4 · Deterministic synthesis model

Synthesize item is posted via the normal tick path, so whichever
model the claiming session uses is what synthesizes. For
consistency, force the synthesis to run on a specific
`synthesisModel` (`modelID`) regardless of which session claims.
The coordinator's prompt-send can accept an optional
`modelOverride` already — wire it through the claim path for this
kind.

## 5 · Ledger

| ID | Kind | Status | Commit | Verified against | Notes |
|---|---|---|---|---|---|
| map-tab | tab | SHIPPED | (next commit) | — | LeftTabs gates on pattern=map-reduce; MAP per-session rows + REDUCE synthesize row + phase-transition banner; reads slots + board.items |
| I1 | improvement | PROPOSED | — | — | new critic ~4 h |
| I2 | improvement | PROPOSED | — | — | detector ~2 h |
| I3 | improvement | PROPOSED | — | — | kickoff + wait logic ~3 h |
| I4 | improvement | SHIPPED | (next commit) | — | meta.synthesisModel field added; coordinator dispatch picks it for `kind === 'synthesize'` items regardless of which session claims. Falls through to per-session pinning when synthesisModel undefined (backward compat). |

## 6 · Cross-references

- `SWARM_PATTERNS.md` §3 — map-reduce stance
- `lib/server/map-reduce.ts` — kickoff, scope builder, synth seeder
- `components/synthesis-strip.tsx` — existing per-member pills
- `blackboard.md` — the synthesize item rides the blackboard store
