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
  bounds?: SwarmRunBounds;    // costCap is enforced by the proxy gate (DESIGN.md §9); minutesCap still aspirational
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

// --- run lifecycle status ---------------------------------------------------

// Classification of a run's execution state, derived server-side from the
// tail of the run's primary session messages. Not persisted — this is a
// live derivation, valid only for the moment the list endpoint replies.
//
//   live     — most recent assistant turn is in-flight (no completed, no
//              error, recent activity). The run is actively producing.
//   idle     — most recent assistant turn completed cleanly. The run is
//              between turns; may still accept more prompts.
//   error    — most recent assistant turn carries an error. Needs
//              attention; not automatically retried.
//   stale    — in-flight assistant turn older than the staleness threshold.
//              Opencode can leave zombie turns (no completed, no error) if
//              a session crashes mid-turn; we surface these separately so
//              users know the run isn't actually progressing.
//   unknown  — primary session has no messages yet, or the status probe
//              itself failed. Not an error — just "we couldn't tell."
export type SwarmRunStatus = 'live' | 'idle' | 'error' | 'stale' | 'unknown';

// One row in GET /api/swarm/run's response. `meta` is the persisted record;
// the rest is live-derived from the primary session's messages and may
// change across polls.
export interface SwarmRunListRow {
  meta: SwarmRunMeta;
  status: SwarmRunStatus;
  // Epoch ms of the most recent signal we used to classify — usually the
  // latest message's time.completed or time.created. null when the session
  // has no messages.
  lastActivityTs: number | null;
  // Cumulative dollars and tokens across every assistant message in the
  // run's primary session. Falls back to pricing-derived cost when
  // opencode doesn't report info.cost directly (free tiers, go bundle).
  // Zero when the probe failed or the run has no assistant messages yet.
  costTotal: number;
  tokensTotal: number;
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
