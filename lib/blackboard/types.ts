// Board shape for the blackboard preset. Shared between the `/board-preview`
// client view and the server-side store at `lib/server/blackboard/*`. Moved
// out of lib/blackboard-mock.ts when the SQLite store landed; the mock file
// now re-exports from here and retains MOCK_AGENTS / MOCK_BOARD only.
//
// See SWARM_PATTERNS.md §1 for the semantic model (claim/question/todo/finding
// + optimistic-CAS-with-file-hashes lifecycle). The types are deliberately
// narrow — anything that would graduate to policy (retention, re-plan interval,
// stale-retry bounds) belongs in the routing modal, not here.

// Board-item kinds.
//   - claim      — an agent declared intent to work, recorded file hashes it
//                  intends to touch. Converts to in-progress once it's building.
//   - question   — an agent asked; any idle agent can answer. Resolves in place.
//   - todo       — a work item on the board. Unclaimed (open), claimed, or done.
//   - finding    — completed output. Immutable once posted.
//   - synthesize — map-reduce reduce-phase work. Content is the full synthesis
//                  prompt (member drafts already embedded). Coordinator posts
//                  content verbatim instead of wrapping in the "edit relevant
//                  files" todo preamble. See SWARM_PATTERNS.md §3 v2 migration
//                  and lib/server/map-reduce.ts::runMapReduceSynthesis for the
//                  dispatch contract.
//   - criterion  — an acceptance condition the auditor verdicts against
//                  (2026-04-24 Stage 2 declared-roles alignment). Status
//                  reused for verdicts: `open`=pending, `done`=met,
//                  `blocked`=unmet (could flip to met later), `stale`=wont-do.
//                  Authored by planner or auditor; never rewritten once
//                  authored (ollama-swarm spec: auditor can ADD but not
//                  REWRITE existing criteria). Criteria never dispatch to
//                  a worker — the coordinator's picker skips kind='criterion'.
export type BoardItemKind =
  | 'claim'
  | 'question'
  | 'todo'
  | 'finding'
  | 'synthesize'
  | 'criterion';

// Status values are shared across kinds but interpreted per-kind:
//   todo   : open → claimed → in-progress → done | stale | blocked
//   claim  : in-progress → done | stale
//   finding: done (immutable)
//   criterion: open (pending) → done (met) | blocked (unmet) | stale (wont-do)
export type BoardItemStatus =
  | 'open'         // on the board, nobody claimed it
  | 'claimed'      // owner declared intent, hasn't started producing output
  | 'in-progress'  // actively being worked on
  | 'done'         // completed
  | 'stale'        // CAS rejection: files moved under the claim; replan needed
  | 'blocked';     // owner hit a dependency / question; waiting on a sibling

export interface BoardAgent {
  id: string;
  name: string;
  accent: 'molten' | 'mint' | 'iris' | 'amber' | 'fog';
  glyph: string;
}

export interface BoardItem {
  id: string;
  kind: BoardItemKind;
  content: string;
  status: BoardItemStatus;
  ownerAgentId?: string;
  // SHAs the claim snapshotted at pickup time. Mismatch at commit time →
  // status transitions to 'stale'. Stored as 7-char hex (git-short style).
  fileHashes?: { path: string; sha: string }[];
  // Populated on transition to 'stale' so the UI can show "moved under you".
  staleSinceSha?: string;
  createdAtMs: number;
  completedAtMs?: number;
  // Short annotation, e.g. "waiting on t_002 answer".
  note?: string;
  // Playwright grounding: when true and the run has enableVerifierGate
  // set, the coordinator consults the verifier session (browser-
  // automated check) after the critic gate approves — before marking
  // the item done. For todos that claim user-observable outcomes
  // ("the dashboard renders X", "clicking Y opens Z"). Planner sets
  // this on its todowrite emission for items that fit.
  requiresVerification?: boolean;
  // Soft role affinity for hierarchical-pattern runs. When set and the
  // run uses role-differentiated (or similar role-pinning shape), the
  // coordinator picker biases toward claiming this item with a session
  // whose pinned role matches. Non-matching sessions can still claim —
  // this is exploration bias, not hard routing. Planner sets it via a
  // `[role:<name>]` content prefix on todowrite; see
  // lib/server/blackboard/planner.ts::stripRoleTag. Left undefined on
  // self-organizing runs (blackboard, council, stigmergy).
  preferredRole?: string;
  // Pre-announced file scope for the worker (2026-04-24, declared-roles
  // alignment). Planner emits via a `[files:a.ts,b.tsx]` content prefix
  // capped at 2 paths — smaller = smaller contention surface. At claim
  // time the coordinator hashes each file and stores the (path, sha)
  // pair in fileHashes as the CAS anchor; at commit time it re-hashes
  // the expectedFiles NOT in the worker's edited paths and rejects the
  // commit on drift (another worker modified the file under us). See
  // SWARM_PATTERNS.md §1 "Implementation modules" and ollama-swarm's
  // blackboard spec for the design rationale.
  // Undefined → worker unconstrained, no CAS protection (pre-Stage-1
  // behavior; kept working so legacy runs + un-tagged todos still move).
  expectedFiles?: string[];
  // PATTERN_DESIGN/deliberate-execute.md I2 — synthesis traceability.
  // 1-based member-draft indices that contributed to this todo, parsed
  // from a `[from:1,3]` content prefix the synthesizer emits. Only set
  // on deliberate-execute runs; other patterns leave it undefined.
  // Lets a future inspector drawer answer "why does this todo exist?"
  // by linking back to the member drafts that motivated it.
  sourceDrafts?: number[];
  // PATTERN_DESIGN/stigmergy.md "heat-picked-timeline-chip" — set true
  // by the coordinator when the heat-weighted picker preferred this
  // item over what age-only ordering would have chosen. Diagnostic
  // signal that stigmergy actually shifted the dispatch (vs. when the
  // bias agreed with oldest-first anyway). Surfaced as a small amber
  // 🜂 chip on the board-rail row. Stays on the item for the run's
  // lifetime — flips false on re-claim only if the new claim's heat
  // bias didn't fire. Default undefined → render no chip.
  pickedByHeat?: boolean;
}
