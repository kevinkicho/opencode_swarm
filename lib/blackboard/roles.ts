// Pattern-aware role resolution, shared between client and server paths.
// Lives outside live.ts (which carries 'use client') so server code —
// route handlers, auto-ticker, coordinator — can import it safely.
//
// Produces the ownerAgentId → role-name map used by:
//   - board chip labels (deriveBoardAgents via lib/blackboard/live.ts)
//   - the roster label path (agent-roster.tsx, threaded from page.tsx)
//   - the coordinator's worker-dispatch post (agent={role} on work prompts
//     so workers carry their role in opencode's info.agent downstream)

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
    case 'role-differentiated': {
      meta.sessionIDs.forEach((sid, i) => {
        const role = meta.teamRoles?.[i];
        if (role) out.set(ownerIdForSession(sid), role);
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
    // council / map-reduce / blackboard / deliberate-execute / none:
    // no pinned role at the pattern level. Returns empty map.
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
    case 'role-differentiated': {
      meta.sessionIDs.forEach((sid, i) => {
        const role = meta.teamRoles?.[i];
        if (role) out.set(sid, role);
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
  }
  return out;
}
