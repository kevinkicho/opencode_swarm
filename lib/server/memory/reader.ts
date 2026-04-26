// Read-side helpers that return typed L2 shapes directly, without the
// `recall()` envelope (items[], tokenEstimate, truncated, shape). The retro
// page consumes these on the server so it can render without a round-trip
// back through its own HTTP surface.
//
// Kept separate from query.ts because query.ts is purpose-built for the
// generic recall() endpoint — summarizing into headlines, estimating
// tokens, capping limits. For page-level reads we want the full AgentRollup
// / RunRetro blobs back as-is.

import 'server-only';

import { memoryDb } from './db';
import { validateMemoryKindDiscriminator } from '../swarm-registry-validate';
import type { AgentRollup, RunRetro } from './types';

interface RollupRow {
  swarm_run_id: string;
  session_id: string;
  kind: string;
  closed_at: number;
  payload: string;
}

// Fetch the retro + every agent rollup for one run. Returns null when the
// run has no rollups at all — the caller decides whether that's a 404 or a
// "generate now" prompt.
export function getRetro(swarmRunID: string): {
  retro: RunRetro | null;
  agentRollups: AgentRollup[];
} | null {
  const db = memoryDb();
  const rows = db
    .prepare(
      `SELECT swarm_run_id, session_id, kind, closed_at, payload
       FROM rollups
       WHERE swarm_run_id = ?
       ORDER BY closed_at ASC`
    )
    .all(swarmRunID) as RollupRow[];

  if (rows.length === 0) return null;

  let retro: RunRetro | null = null;
  const agentRollups: AgentRollup[] = [];
  for (const r of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(r.payload);
    } catch {
      // Malformed JSON — skip rather than throw. A single bad row
      // shouldn't hide the rest of the run's data; the rollup
      // generator can be re-run to rewrite it.
      continue;
    }
    // HARDENING_PLAN.md#R7 — discriminator validator. Pre-fix the cast
    // `as AgentRollup | RunRetro` trusted the parsed JSON without
    // checking the kind field. A row with missing/wrong kind would
    // propagate undefined into UI consumers. Validator returns null
    // + warns once when the discriminator is missing.
    const checked = validateMemoryKindDiscriminator(raw);
    if (!checked) continue;
    if (checked.kind === 'retro') retro = raw as RunRetro;
    else if (checked.kind === 'agent') agentRollups.push(raw as AgentRollup);
    // Other (unknown) kinds skipped silently — forward-compat for new
    // L2 shapes added later.
  }

  return { retro, agentRollups };
}

// Lightweight row count used by the retro link in the runs picker: "does
// this run have rollups yet?" in one query. Avoids deserializing payloads
// when the caller just needs a boolean/count.
export function countRollups(swarmRunID: string): number {
  const db = memoryDb();
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM rollups WHERE swarm_run_id = ?')
    .get(swarmRunID) as { n: number };
  return row.n;
}
