// Pattern-aware role resolution, shared between client and server paths.
// Lives outside live.ts (which carries 'use client') so server code —
// route handlers, auto-ticker, coordinator — can import it safely.
//
// Produces the ownerAgentId → role-name map used by:
//   - board chip labels (deriveBoardAgents via lib/blackboard/live.ts)
//   - the roster label path (agent-roster.tsx, threaded from page.tsx)
//   - the coordinator's worker-dispatch post (agent={role} on work prompts
//     so workers carry their role in opencode's info.agent downstream)

import type { OpencodeBuiltinAgent } from '../opencode/types';

// The coordinator's ownerIdForSession convention — duplicated here to
// keep this module dependency-light. If that convention ever changes,
// search repo for `ag_ses_` and update both.
function ownerIdForSession(sessionID: string): string {
  return 'ag_ses_' + sessionID.slice(-8);
}

export interface RoleMetaLite {
  pattern: string;
  sessionIDs: readonly string[];
  teamRoles?: readonly string[];
}

export function roleNamesFromMeta(
  meta: RoleMetaLite | null | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!meta) return out;
  switch (meta.pattern) {
    case 'orchestrator-worker': {
      meta.sessionIDs.forEach((sid, i) => {
        out.set(ownerIdForSession(sid), i === 0 ? 'orchestrator' : `worker-${i}`);
      });
      break;
    }
    case 'debate-judge': {
      meta.sessionIDs.forEach((sid, i) => {
        out.set(ownerIdForSession(sid), i === 0 ? 'judge' : `generator-${i}`);
      });
      break;
    }
    case 'critic-loop': {
      meta.sessionIDs.forEach((sid, i) => {
        out.set(ownerIdForSession(sid), i === 0 ? 'worker' : 'critic');
      });
      break;
    }
    case 'blackboard': {
      // Declared roles for blackboard (2026-04-24 stance revision, see
      // STATUS.md). Session 0 is the planner (owns contract authorship,
      // todowrite posts, replans); sessions 1..N are workers (claim →
      // implement). Labels are DISPLAY-ONLY for blackboard — the
      // coordinator doesn't pass them to opencode as `agent` field via
      // this map; use `opencodeAgentForSession` for dispatch routing.
      // User's opencode.json does NOT need matching `planner` or
      // `worker-<N>` agent entries.
      meta.sessionIDs.forEach((sid, i) => {
        out.set(ownerIdForSession(sid), i === 0 ? 'planner' : `worker-${i}`);
      });
      break;
    }
    // Display labels for council / map-reduce. The role isn't enforced
    // (no preferredRole gating, no per-session prompt diff), but the
    // user wants the lane header to show what each session IS doing in
    // the run, not just the provider. Labels are DISPLAY-ONLY here.
    case 'council': {
      meta.sessionIDs.forEach((sid, i) => {
        out.set(ownerIdForSession(sid), `member-${i + 1}`);
      });
      break;
    }
    case 'map-reduce': {
      meta.sessionIDs.forEach((sid, i) => {
        out.set(ownerIdForSession(sid), `mapper-${i + 1}`);
      });
      break;
    }
    // 'none' has no swarm-pattern roles → empty map (caller falls back
    // to the model name on the chip).
  }
  return out;
}

// Same map but keyed by sessionID instead of ownerAgentId. Convenience
// for consumers that iterate sessionIDs directly (e.g. coordinator when
// dispatching work prompts).
export function roleNamesBySessionID(
  meta: RoleMetaLite | null | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!meta) return out;
  switch (meta.pattern) {
    case 'orchestrator-worker': {
      meta.sessionIDs.forEach((sid, i) => {
        out.set(sid, i === 0 ? 'orchestrator' : `worker-${i}`);
      });
      break;
    }
    case 'debate-judge': {
      meta.sessionIDs.forEach((sid, i) => {
        out.set(sid, i === 0 ? 'judge' : `generator-${i}`);
      });
      break;
    }
    case 'critic-loop': {
      meta.sessionIDs.forEach((sid, i) => {
        out.set(sid, i === 0 ? 'worker' : 'critic');
      });
      break;
    }
    case 'blackboard': {
      // See roleNamesFromMeta above for rationale. DISPLAY-ONLY labels.
      meta.sessionIDs.forEach((sid, i) => {
        out.set(sid, i === 0 ? 'planner' : `worker-${i}`);
      });
      break;
    }
    case 'council': {
      meta.sessionIDs.forEach((sid, i) => {
        out.set(sid, `member-${i + 1}`);
      });
      break;
    }
    case 'map-reduce': {
      meta.sessionIDs.forEach((sid, i) => {
        out.set(sid, `mapper-${i + 1}`);
      });
      break;
    }
  }
  return out;
}

// Role to pass as opencode's `agent` field at dispatch time.
//
// HISTORY: returned role names for hierarchical patterns until
// 2026-04-25 live validation (run_mody4whw_bp0o4o, run_mody4z4g_fhvd7a)
// surfaced a silent-drop bug — opencode's `prompt_async` returns HTTP
// 204 success but never persists the user message OR starts an
// assistant turn when given an `agent` name that isn't in
// opencode.json. The earlier comment claiming "missing entries fall
// through to opencode's default" was wrong. Empirically: 'worker-1',
// 'worker-2', 'architect', 'tester' — all dropped silently. Workers
// got msgs=0 and the F1 watchdog tripped at 240s with retry-stale.
//
// FIX: return undefined for ALL patterns. Role display in our UI
// already comes from `roleNamesBySessionID(meta)` (a client-side
// derivation), not from opencode's agent metadata, so this is a
// no-op for users. If a user later defines real agent configs in
// opencode.json and wants them honored, that's a separate opt-in
// path — for the default case where opencode.json has no custom
// agents, NEVER passing the param is the only reliable behavior.
//
// #7.Q37 — return type narrowed to `OpencodeBuiltinAgent | undefined`
// so dispatch's `agent` param matches the postSessionMessage signature.
// The current implementation is `undefined`-only; if a future opt-in
// path returns a real agent it must be one of opencode's built-ins.
export function opencodeAgentForSession(
  _meta: RoleMetaLite | null | undefined,
  _sessionID: string,
): OpencodeBuiltinAgent | undefined {
  return undefined;
}
