// Wire contracts for the swarm-run backend (Tier 2 of the roadmap).
//
// A "swarm run" is one logical run that wraps N opencode sessions under a
// single coordinator. At v1 N=1 and the pattern is always 'none' — the
// shape generalizes to N when blackboard / map-reduce / council backends
// ship (see SWARM_PATTERNS.md §"Backend gap").
//
// Ownership: these types are shared between the browser (POST body, event
// consumer) and the Next.js route handler. Keep server-only types in
// `lib/server/` so this file stays import-safe from 'use client' modules.

import type { SwarmPattern } from './swarm-types';

// --- POST /api/swarm/run ----------------------------------------------------

// Body accepted by the run endpoint. `pattern` and `workspace` are the only
// non-aspirational fields at v1 — the rest are recorded in meta.json for
// later replay / analytics but don't drive runtime routing yet.
export interface SwarmRunRequest {
  pattern: SwarmPattern;
  workspace: string;          // → opencode ?directory=
  source?: string;            // GitHub URL; recorded for provenance
  directive?: string;         // first prompt posted to the root session
  title?: string;             // session title seed; falls back to directive line 1
  teamSize?: number;          // aspirational — ignored for pattern='none'
  bounds?: SwarmRunBounds;    // aspirational — recorded, not enforced yet
}

export interface SwarmRunBounds {
  costCap?: number;
  minutesCap?: number;
}

// --- run metadata (persisted to meta.json) ----------------------------------

// One record per run. Written once at create time; updated only to append
// newly-spawned sessionIDs (future patterns). Never mutated retroactively.
export interface SwarmRunMeta {
  swarmRunID: string;
  pattern: SwarmPattern;
  createdAt: number;          // epoch ms, server clock
  workspace: string;
  sessionIDs: string[];       // component opencode sessions
  source?: string;
  directive?: string;
  title?: string;
  bounds?: SwarmRunBounds;
}

// --- response shape ---------------------------------------------------------

export interface SwarmRunResponse {
  swarmRunID: string;
  sessionIDs: string[];
  meta: SwarmRunMeta;
}

// --- multiplexed event shape (out of /api/swarm/run/:id/events) -------------

// Each line the multiplexer emits tags the raw opencode event with the
// originating sessionID plus a server-receive timestamp. The opencode event
// body — `type` + `properties` — is forwarded verbatim so clients can reuse
// the same part-handling logic they use for single-session streams.
export interface SwarmRunEvent {
  swarmRunID: string;
  sessionID: string;
  ts: number;                 // epoch ms, server clock on receipt
  type: string;               // opencode event type (e.g. 'message.part.updated')
  properties: unknown;        // opencode event properties, untouched
}
