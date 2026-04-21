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
  };
  artifacts: Array<{
    type: 'patch' | 'file' | 'commit';
    filePath?: string;
    addedLines?: number;
    removedLines?: number;
    diffHash?: string;
    status?: 'merged' | 'discarded' | 'superseded';
    reviewNotes?: string;
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

// recall() tool shape — the HTTP boundary between the UI / agents and the
// memory layer. Matches DESIGN.md §7.5 with minor pragmatic changes:
//   - `workspace` is always required on an unrestricted query (prevent
//     accidentally scanning the entire ledger)
//   - timeRange is in epoch ms, not "[number, number]" tuples, to avoid
//     ambiguity across consumers
export interface RecallRequest {
  swarmRunID?: string;
  sessionID?: string;
  workspace?: string;
  filter?: {
    agents?: string[];
    partTypes?: string[];
    toolNames?: string[];
    filePath?: string;
    outcome?: 'merged' | 'discarded';
    timeRange?: { startMs: number; endMs: number };
    query?: string;              // FTS MATCH expression
  };
  shape?: 'summary' | 'parts' | 'diffs';
  limit?: number;
}

export interface RecallSummaryItem {
  kind: 'summary';
  swarmRunID: string;
  sessionID: string;
  agent?: string;
  closedAt: number;
  headline: string;              // first artifact / decision, or fallback
  counters?: AgentRollup['counters'];
}

export interface RecallPartItem {
  kind: 'part';
  partID: string;
  swarmRunID: string;
  sessionID: string;
  agent: string | null;
  partType: string;
  toolName: string | null;
  createdMs: number;
  snippet: string;               // FTS highlight when query was set, else text[0:N]
}

export type RecallItem = RecallSummaryItem | RecallPartItem;

export interface RecallResponse {
  items: RecallItem[];
  tokenEstimate: number;
  truncated: boolean;
  shape: 'summary' | 'parts' | 'diffs';
}
