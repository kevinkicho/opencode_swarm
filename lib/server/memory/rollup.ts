// L2 rollup generation. Takes a swarm run's per-session opencode messages
// and produces:
//   - one AgentRollup per sessionID  (what this agent did)
//   - one RunRetro  per swarmRunID  (aggregate outcome + lessons)
//
// Deterministic reducer, no LLM. The design point is that STRUCTURED
// summaries survive iteration better than prose — count tool calls,
// capture file paths, surface error signatures verbatim. If a future
// version wants nicer prose headlines, wrap this output; don't replace it.
//
// Persistence: rollups land in a single SQLite table keyed on
// (swarm_run_id, session_id). The RunRetro row uses session_id='' so a
// single `WHERE swarm_run_id = ?` returns everything. Per-file unified
// diffs land in the `diffs` table for the retro view.
//
// Idempotent: reruns REPLACE the existing rollup rows. That's intentional —
// rolling up the same run twice with more events should give a strictly
// better summary, not accumulate stale artifacts.

import 'server-only';

import { memoryDb } from './db';
import { getRun, listRuns } from '../swarm-registry';
import { getSessionMessagesServer, getSessionDiffServer } from '../opencode-server';
import type { OpencodeMessage, OpencodePart } from '../../opencode/types';
import type { SwarmRunMeta } from '../../swarm-run-types';
import type { AgentRollup, RunRetro } from './types';
import { aggregateRetro, reduceSession } from './rollup-compute';

// Per-file cap on stored unified diffs. Opencode's diff endpoint can return
// large blobs for long-running sessions; capping keeps the memory DB small.
// Agents that need the full hunk can follow up via /session/{id}/diff
// directly — the memory layer is a searchable projection, not authoritative
// storage.
const DIFF_PATCH_CAP = 16 * 1024;

// §8.3 option (a) anchor: parse `[todo:<16-hex>]` from a task tool call's
// description / prompt. Mirrors the ingest-side extractor — kept here so
// rollup-compute is pure (no opencode-types-heavy regex code) and the
// extraction stays in one place.
const TODO_PREFIX_RE = /^\s*\[todo:([0-9a-f]{16})\]/;

function extractOriginTodoID(part: OpencodePart): string | null {
  if (part.type !== 'tool' || (part as { tool?: string }).tool !== 'task') return null;
  const input = (part as { input?: { description?: unknown; prompt?: unknown } }).input;
  if (!input || typeof input !== 'object') return null;
  for (const c of [input.description, input.prompt]) {
    if (typeof c !== 'string') continue;
    const m = TODO_PREFIX_RE.exec(c);
    if (m) return m[1];
  }
  return null;
}

function extractChildSessionID(part: OpencodePart): string | null {
  if (part.type !== 'tool' || (part as { tool?: string }).tool !== 'task') return null;
  const s = (part as { state?: { sessionID?: unknown; childSessionID?: unknown } }).state;
  if (!s || typeof s !== 'object') return null;
  const id =
    (typeof s.sessionID === 'string' && s.sessionID) ||
    (typeof s.childSessionID === 'string' && s.childSessionID) ||
    null;
  return id || null;
}

// Walks every parent session's task-tool parts to build a
// `childSessionID → originTodoID` map for the rollup pass. Replaces the
// old ingest+SQL path (parts table + child_session_id partial index) —
// since the rollup orchestrator already has every session's messages in
// hand, this single in-memory pass is faster than the SQL lookup ever was.
function buildOriginMap(
  messagesBySession: Map<string, OpencodeMessage[]>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const messages of messagesBySession.values()) {
    for (const msg of messages) {
      for (const part of msg.parts) {
        const originID = extractOriginTodoID(part);
        const childID = extractChildSessionID(part);
        if (originID && childID && !out.has(childID)) {
          out.set(childID, originID);
        }
      }
    }
  }
  return out;
}

// Writes one diffs row per changed file in the session. Best-effort — if
// opencode's diff endpoint fails (network, session gone) we log and return 0
// rather than abort the whole rollup. The rollup's counters + retro still
// land; hunks just stay empty until the next capture attempt.
async function captureSessionDiffs(
  swarmRunID: string,
  sessionID: string,
  workspace: string
): Promise<number> {
  let diffs: Array<{ file: string; patch: string }> = [];
  try {
    diffs = await getSessionDiffServer(sessionID, workspace);
  } catch (err) {
    console.warn(
      `[rollup] diff capture failed for ${sessionID}: ${(err as Error).message}`
    );
    return 0;
  }
  if (diffs.length === 0) return 0;

  const db = memoryDb();
  const upsert = db.prepare(
    `INSERT INTO diffs (swarm_run_id, session_id, file_path, patch, captured_ms)
     VALUES (@swarm_run_id, @session_id, @file_path, @patch, @captured_ms)
     ON CONFLICT(session_id, file_path) DO UPDATE SET
       swarm_run_id = excluded.swarm_run_id,
       patch        = excluded.patch,
       captured_ms  = excluded.captured_ms`
  );
  const now = Date.now();
  const writeAll = db.transaction(() => {
    let n = 0;
    for (const row of diffs) {
      if (!row.file || typeof row.patch !== 'string') continue;
      const patch =
        row.patch.length > DIFF_PATCH_CAP
          ? row.patch.slice(0, DIFF_PATCH_CAP)
          : row.patch;
      upsert.run({
        swarm_run_id: swarmRunID,
        session_id: sessionID,
        file_path: row.file,
        patch,
        captured_ms: now,
      });
      n += 1;
    }
    return n;
  });
  return writeAll();
}


// Generate + persist rollups for one run. Fetches opencode messages per
// session in parallel, builds the origin-ID map across all of them, then
// reduces each into an AgentRollup + writes the L2 rows.
export async function generateRollup(meta: SwarmRunMeta): Promise<{
  agentRollups: AgentRollup[];
  retro: RunRetro;
}> {
  const db = memoryDb();
  const agentRollups: AgentRollup[] = [];

  // Fetch every session's messages first so we can build the origin map
  // before reducing any one of them.
  const messagesBySession = new Map<string, OpencodeMessage[]>();
  for (const sessionID of meta.sessionIDs) {
    try {
      const messages = await getSessionMessagesServer(sessionID, meta.workspace);
      if (messages.length > 0) messagesBySession.set(sessionID, messages);
    } catch (err) {
      console.warn(
        `[rollup] skipping ${sessionID} — opencode fetch failed: ${(err as Error).message}`
      );
    }
  }
  const originMap = buildOriginMap(messagesBySession);

  for (const sessionID of meta.sessionIDs) {
    const messages = messagesBySession.get(sessionID);
    if (!messages || messages.length === 0) continue;
    agentRollups.push(
      reduceSession(
        meta.swarmRunID,
        meta.workspace,
        sessionID,
        messages,
        originMap.get(sessionID) ?? null,
      ),
    );
    // Capture unified diffs for this session for the retro view's hunk
    // display. Best-effort — the helper logs and returns 0 on failure
    // rather than aborting the rollup.
    await captureSessionDiffs(meta.swarmRunID, sessionID, meta.workspace);
  }

  const retro = aggregateRetro(meta, agentRollups);

  const upsert = db.prepare(
    `INSERT INTO rollups
       (swarm_run_id, session_id, kind, workspace, closed_at, tokens_in, tokens_out, tool_calls, payload)
     VALUES
       (@swarm_run_id, @session_id, @kind, @workspace, @closed_at, @tokens_in, @tokens_out, @tool_calls, @payload)
     ON CONFLICT(swarm_run_id, session_id) DO UPDATE SET
       kind       = excluded.kind,
       workspace  = excluded.workspace,
       closed_at  = excluded.closed_at,
       tokens_in  = excluded.tokens_in,
       tokens_out = excluded.tokens_out,
       tool_calls = excluded.tool_calls,
       payload    = excluded.payload`
  );

  const writeAll = db.transaction(() => {
    for (const r of agentRollups) {
      upsert.run({
        swarm_run_id: r.swarmRunID,
        session_id: r.sessionID,
        kind: 'agent',
        workspace: r.workspace,
        closed_at: r.closedAt,
        tokens_in: r.counters.tokensIn,
        tokens_out: r.counters.tokensOut,
        tool_calls: r.counters.toolCalls,
        payload: JSON.stringify(r),
      });
    }
    upsert.run({
      swarm_run_id: retro.swarmRunID,
      session_id: '',
      kind: 'retro',
      workspace: retro.workspace,
      closed_at: retro.timeline.end,
      tokens_in: 0,
      tokens_out: retro.cost.tokensTotal,
      tool_calls: 0,
      payload: JSON.stringify(retro),
    });
  });
  writeAll();

  return { agentRollups, retro };
}

export async function generateRollupById(
  swarmRunID: string
): Promise<{ agentRollups: AgentRollup[]; retro: RunRetro } | null> {
  const meta = await getRun(swarmRunID);
  if (!meta) return null;
  return generateRollup(meta);
}

export async function generateAllRollups(): Promise<
  Array<{ swarmRunID: string; agentCount: number }>
> {
  const metas = await listRuns();
  const out: Array<{ swarmRunID: string; agentCount: number }> = [];
  for (const meta of metas) {
    try {
      const { agentRollups } = await generateRollup(meta);
      out.push({ swarmRunID: meta.swarmRunID, agentCount: agentRollups.length });
    } catch (err) {
      console.warn(
        `[rollup] ${meta.swarmRunID} failed: ${(err as Error).message}`
      );
    }
  }
  return out;
}
