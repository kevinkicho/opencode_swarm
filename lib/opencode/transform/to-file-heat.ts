//
// File-heat projection — stigmergy v0. Aggregates every patch part's
// `files` list across the run into per-file edit counts + distinct-session
// counts + last-touched timestamps. Used by the heat rail in LeftTabs to
// answer "which files has the swarm actually converged on?" without
// prescribing any coordinator behavior. Observation, not assignment —
// matches the project's no-role-hierarchy stance.
//
// Stigmergy v1 (server-side picker bias) graduated to a real signal in
// lib/server/blackboard/coordinator/heat.ts; this transformer remains the
// client-side projection of the same data.

import type { OpencodeMessage } from '../types';

export interface FileHeat {
  path: string;
  editCount: number;         // total patch.files mentions (one per assistant step)
  distinctSessions: number;  // how many different opencode sessions touched it
  lastTouchedMs: number;     // most recent assistant completion time that touched it
  sessionIDs: string[];      // deduped; agents in the roster index by session.id
  // consumers detect "session 3 edits src/auth/ constantly while the
  // rest avoid it" — a specialization signal that the flat sessionIDs
  // list can't surface. Keys are the same opencode sessionIDs that
  // appear in the array; sum across all keys equals editCount.
  // Empty record on heat entries derived from the legacy code path.
  editsBySession: Record<string, number>;
}

export function toFileHeat(messages: OpencodeMessage[]): FileHeat[] {
  interface Bucket {
    path: string;
    count: number;
    sessions: Set<string>;
    lastMs: number;
    bySession: Map<string, number>;
  }
  const byPath = new Map<string, Bucket>();

  for (const m of messages) {
    if (m.info.role !== 'assistant') continue;
    const sessionID = m.info.sessionID;
    const completedMs = m.info.time.completed ?? m.info.time.created;
    for (const p of m.parts) {
      if (p.type !== 'patch') continue;
      for (const path of p.files) {
        let entry = byPath.get(path);
        if (!entry) {
          entry = { path, count: 0, sessions: new Set(), lastMs: 0, bySession: new Map() };
          byPath.set(path, entry);
        }
        entry.count += 1;
        entry.sessions.add(sessionID);
        entry.bySession.set(sessionID, (entry.bySession.get(sessionID) ?? 0) + 1);
        if (completedMs > entry.lastMs) entry.lastMs = completedMs;
      }
    }
  }

  return Array.from(byPath.values())
    .map<FileHeat>((e) => ({
      path: e.path,
      editCount: e.count,
      distinctSessions: e.sessions.size,
      lastTouchedMs: e.lastMs,
      sessionIDs: Array.from(e.sessions),
      editsBySession: Object.fromEntries(e.bySession),
    }))
    // Hot first — desc by editCount, tie-break by recency so a file
    // touched many times long ago doesn't outrank a freshly-claimed
    // contended file in the scan order.
    .sort((a, b) => {
      if (b.editCount !== a.editCount) return b.editCount - a.editCount;
      return b.lastTouchedMs - a.lastTouchedMs;
    });
}
