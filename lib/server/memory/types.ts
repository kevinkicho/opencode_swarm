// L2 rollup shapes — the structured summaries a future agent reads instead
// of the raw event log. DESIGN.md §7.4 is the source of truth; keep this
// file synchronized with that schema.
//
// Two kinds:
//   - AgentRollup : one per opencode session (child). Captures what *one*
//                   agent produced during *one* session.
//   - RunRetro    : one per swarm-run. Aggregates across sessions + lessons.
//
// Both are stored verbatim as JSON in `rollups.payload`. A small set of
// fields are duplicated into the row's top-level columns (kind, workspace,
// closed_at, tokens_in, tokens_out, tool_calls) so the cheap queries —
// "show me all retros for workspace X newer than T" — don't need to parse
// the blob. The blob is authoritative; columns are denormalized pointers.

import 'server-only';

export interface AgentRollup {
  kind: 'agent';
  swarmRunID: string;
  sessionID: string;
  workspace: string;
  agent: {
    name: string;
    model?: string;              // modelID when known; '' when opencode didn't report one
  };
  closedAt: number;              // epoch ms, server clock
  outcome: 'merged' | 'discarded' | 'partial' | 'aborted';
  counters: {
    tokensIn: number;
    tokensOut: number;
    toolCalls: number;
    retries: number;
    compactions: number;
    toolSuccessRate?: number;
  };
  artifacts: Array<{
    type: 'patch' | 'file' | 'commit';
    filePath?: string;
    addedLines?: number;
    removedLines?: number;
    diffHash?: string;
    status?: 'merged' | 'discarded' | 'superseded';
    reviewNotes?: string;
    // Intent anchor: which plan item was in_progress when this artifact
    // landed? (DESIGN.md §8.4.) v1 uses temporal attribution — the
    // first in-progress todo at patch time. Value is sha256(content) sliced
    // to 16 chars so it survives plan edits (same content → same ID).
    // Undefined when no todo was in-progress, or when the run had no plan.
    originTodoID?: string;
  }>;
  failures: Array<{
    tool: string;
    argsHash?: string;
    exitCode?: number;
    stderrHash?: string;
    resolution: 'retried' | 'abandoned' | 'routed-to' | 'user-intervened';
    routedTo?: string;
  }>;
  decisions: Array<{
    at: number;
    choice: string;
    rationaleHash?: string;
  }>;
  deps: {
    spawnedBy?: string;
    spawned: string[];
  };
  // Final todowrite snapshot for this session, captured at close time.
  // Present only when the agent wrote a plan during the run; omitted for
  // agents that never called `todowrite`. `id` is sha256(content)[:16] —
  // the same key stored on `artifacts[].originTodoID`, so the viewer can
  // resolve a hash to text without any extra fetch.
  plan?: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'abandoned';
  }>;
}

export interface RunRetro {
  kind: 'retro';
  swarmRunID: string;
  workspace: string;
  directive: string | null;
  outcome: 'completed' | 'aborted' | 'failed';
  timeline: { start: number; end: number; durationMs: number };
  cost: { tokensTotal: number; costUSD: number };
  participants: string[];        // sessionIDs with an AgentRollup row
  artifactGraph: {
    filesFinal: string[];
    finalDiffHash?: string;
    commits: string[];
    prURLs: string[];
  };
  lessons: Array<{
    tag: 'tool-failure' | 'routing-miss' | 'good-pattern' | 'user-correction';
    text: string;
    evidencePartIDs: string[];   // pointers into L1 (parts.part_id)
  }>;
}

// Recall tool types historically lived here. The recall() function in
// lib/server/memory/query.ts had no consumers and was deleted 2026-04-26
// alongside its types — agents read L2 rollups directly via the retro
// page, not via a generic recall API. If a librarian-style agent ever
// needs to query L1 part-level data, the types can be reintroduced.
