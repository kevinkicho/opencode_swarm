// L2 rollup generation. Takes a swarm run's L0 events + L1 parts + live
// session messages and produces:
//   - one AgentRollup per sessionID  (what this agent did)
//   - one RunRetro  per swarmRunID  (aggregate outcome + lessons)
//
// Deterministic reducer, no LLM. The design point (§7.3) is that
// STRUCTURED summaries survive iteration better than prose — count tool
// calls, capture file paths, surface error signatures verbatim. If a future
// version wants nicer prose headlines, wrap this output; don't replace it.
//
// Write path: both shapes land in the `rollups` table keyed on
// (swarm_run_id, session_id). The RunRetro row uses session_id='' so a
// single `WHERE swarm_run_id = ?` returns everything.
//
// Idempotent: reruns REPLACE the existing rollup rows. That's intentional —
// rolling up the same run twice with more events should give a strictly
// better summary, not accumulate stale artifacts.

import 'server-only';

import { memoryDb } from './db';
import { getRun, listRuns } from '../swarm-registry';
import { getSessionMessagesServer, getSessionDiffServer } from '../opencode-server';
import type { OpencodeMessage } from '../../opencode/types';
import type { SwarmRunMeta } from '../../swarm-run-types';
import type { AgentRollup, RunRetro } from './types';
// HARDENING_PLAN.md#C13 — pure-compute helpers + reducers extracted to
// rollup-compute.ts. This module owns orchestration + I/O only:
// captureSessionDiffs (opencode + DB write) and generateRollup (the
// fan-out + persist orchestrator).
import { aggregateRetro, reduceSession } from './rollup-compute';

// Per-file cap on stored unified diffs. Opencode's diff endpoint can return
// large blobs for long-running sessions; capping keeps the memory DB small
// and bounds the token cost of shape='diffs' recall. Agents that need the
// full hunk can follow up via /session/{id}/diff directly — the memory
// layer is a searchable projection, not authoritative storage.
const DIFF_PATCH_CAP = 16 * 1024;

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
// session (one request each — at v1 N=1 so it's a single call). Returns
// the generated shapes so the caller can show them without a second read.
export async function generateRollup(meta: SwarmRunMeta): Promise<{
  agentRollups: AgentRollup[];
  retro: RunRetro;
}> {
  const db = memoryDb();
  const agentRollups: AgentRollup[] = [];

  for (const sessionID of meta.sessionIDs) {
    let messages: OpencodeMessage[] = [];
    try {
      messages = await getSessionMessagesServer(sessionID, meta.workspace);
    } catch (err) {
      console.warn(
        `[rollup] skipping ${sessionID} — opencode fetch failed: ${(err as Error).message}`
      );
      continue;
    }
    if (messages.length === 0) continue;
    agentRollups.push(reduceSession(meta.swarmRunID, meta.workspace, sessionID, messages));
    // Capture unified diffs for this session so shape='diffs' recall can
    // return real hunks alongside patch-part metadata. Best-effort — the
    // helper logs and returns 0 on failure rather than aborting the rollup.
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
