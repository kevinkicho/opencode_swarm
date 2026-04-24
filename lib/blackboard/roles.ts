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
    // council / map-reduce / deliberate-execute / none:
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
    case 'blackboard': {
      // See roleNamesFromMeta above for rationale. DISPLAY-ONLY labels.
      meta.sessionIDs.forEach((sid, i) => {
        out.set(sid, i === 0 ? 'planner' : `worker-${i}`);
      });
      break;
    }
  }
  return out;
}

// Role to pass as opencode's `agent` field at dispatch time. Only
// hierarchical patterns (orchestrator-worker, role-differentiated,
// debate-judge, critic-loop) use opencode agent-configs for routing;
// blackboard's planner/worker labels are display-only, so we return
// undefined for it. Keeps user's opencode.json free of synthetic
// `planner`/`worker-N` entries they never asked for.
//
// Hierarchical patterns: the role name IS the opencode agent-config
// name the user set up (e.g. `orchestrator`, `judge`, `architect`).
// Passing these as `agent` on postSessionMessageServer routes to
// those configs; missing entries fall through to opencode's default.
export function opencodeAgentForSession(
  meta: RoleMetaLite | null | undefined,
  sessionID: string,
): string | undefined {
  if (!meta) return undefined;
  if (meta.pattern === 'blackboard') return undefined;
  return roleNamesBySessionID(meta).get(sessionID);
}
