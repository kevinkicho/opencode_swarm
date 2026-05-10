// Swarm run event and response types.

import type { SwarmRunMeta } from './run-status';

// --- response shape ---------------------------------------------------------

export interface SwarmRunResponse {
  swarmRunID: string;
  sessionIDs: string[];
  meta: SwarmRunMeta;
  // Critic / verifier / auditor sessions are spawned best-effort:
  // a failure used to fall through to undefined silently, so a run
  // with `enableAuditorGate: true` could launch with no auditor
  // session and the user had no signal. Now each failure's reason
  // appears here. Absent when all enabled gate-spawns succeeded.
  gateFailures?: {
    critic?: string;
    verifier?: string;
    auditor?: string;
  };
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
