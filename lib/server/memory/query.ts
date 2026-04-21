// recall() query implementation. Translates a RecallRequest into one of
// two SQL strategies:
//
//   shape='summary' — hits `rollups` table, returns AgentRollup/RunRetro
//                     digests. Default path; cheapest in tokens and IO.
//   shape='parts'   — hits `parts` (+ parts_fts when filter.query is set),
//                     returns per-part snippets. For "show me the exact
//                     edit part that touched src/auth.ts".
//   shape='diffs'   — currently falls through to 'parts' filtered to
//                     part_type='patch'. True diff expansion (full hunks
//                     from L0) is a follow-up — needs content-addressed
//                     resolution by diffHash, which isn't built yet.
//
// Budget: we cap `limit` at 50 server-side so a misconfigured caller can't
// blow an agent's context window. Callers paginate by advancing an offset
// cursor in the request shape (not exposed at v1 — single-page fetch is
// sufficient for prototype usage).

import { memoryDb } from './db';
import type {
  AgentRollup,
  RecallItem,
  RecallPartItem,
  RecallRequest,
  RecallResponse,
  RecallSummaryItem,
  RunRetro,
} from './types';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Very rough token estimate from text length. Good enough to flag when a
// caller should paginate; not a pricing-grade calculation. ~4 chars/token
// is the conventional approximation for English prose/code.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function recall(req: RecallRequest): RecallResponse {
  const shape = req.shape ?? 'summary';
  const limit = Math.min(req.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  if (shape === 'summary') {
    return querySummaries(req, limit);
  }
  return queryParts(req, limit, shape);
}

function querySummaries(req: RecallRequest, limit: number): RecallResponse {
  const db = memoryDb();
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (req.swarmRunID) {
    where.push('swarm_run_id = @swarmRunID');
    params.swarmRunID = req.swarmRunID;
  }
  if (req.sessionID) {
    where.push('session_id = @sessionID');
    params.sessionID = req.sessionID;
  }
  if (req.workspace) {
    where.push('workspace = @workspace');
    params.workspace = req.workspace;
  }
  if (req.filter?.timeRange) {
    where.push('closed_at BETWEEN @startMs AND @endMs');
    params.startMs = req.filter.timeRange.startMs;
    params.endMs = req.filter.timeRange.endMs;
  }

  const sql = `
    SELECT swarm_run_id, session_id, kind, closed_at, tokens_in, tokens_out, tool_calls, payload
    FROM rollups
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY closed_at DESC
    LIMIT @limit
  `;
  params.limit = limit;

  const rows = db.prepare(sql).all(params) as Array<{
    swarm_run_id: string;
    session_id: string;
    kind: string;
    closed_at: number;
    tokens_in: number;
    tokens_out: number;
    tool_calls: number;
    payload: string;
  }>;

  let tokenEstimate = 0;
  const items: RecallSummaryItem[] = rows.map((r) => {
    let blob: AgentRollup | RunRetro | null = null;
    try {
      blob = JSON.parse(r.payload) as AgentRollup | RunRetro;
    } catch {
      blob = null;
    }
    const headline = headlineFor(blob);
    tokenEstimate += estimateTokens(headline);
    const base: RecallSummaryItem = {
      kind: 'summary',
      swarmRunID: r.swarm_run_id,
      sessionID: r.session_id,
      agent: blob && blob.kind === 'agent' ? blob.agent.name : undefined,
      closedAt: r.closed_at,
      headline,
      counters:
        blob && blob.kind === 'agent'
          ? blob.counters
          : undefined,
    };
    return base;
  });

  return {
    items,
    tokenEstimate,
    truncated: rows.length === limit,
    shape: 'summary',
  };
}

// Picks the most useful one-liner for a rollup card: first lesson for a
// retro; first decision or artifact for an agent summary. Falls back to
// "no summary" so the card still renders even if the blob is malformed.
function headlineFor(blob: AgentRollup | RunRetro | null): string {
  if (!blob) return 'no summary';
  if (blob.kind === 'retro') {
    const lesson = blob.lessons[0]?.text;
    if (lesson) return lesson;
    const files = blob.artifactGraph.filesFinal;
    if (files.length > 0) return `touched ${files.length} files: ${files.slice(0, 3).join(', ')}`;
    return `run ${blob.outcome}`;
  }
  const decision = blob.decisions[0]?.choice;
  if (decision) return decision;
  const artifact = blob.artifacts[0];
  if (artifact?.filePath) return `${artifact.type} ${artifact.filePath}`;
  return `${blob.agent.name} · ${blob.outcome}`;
}

function queryParts(
  req: RecallRequest,
  limit: number,
  shape: 'parts' | 'diffs'
): RecallResponse {
  const db = memoryDb();
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  // FTS MATCH is opt-in via filter.query. When present, we join against
  // parts_fts for ranked results; otherwise fall back to a plain scan with
  // time-descending order.
  const ftsQuery = req.filter?.query?.trim();
  const useFts = !!ftsQuery;

  if (req.swarmRunID) {
    where.push('p.swarm_run_id = @swarmRunID');
    params.swarmRunID = req.swarmRunID;
  }
  if (req.sessionID) {
    where.push('p.session_id = @sessionID');
    params.sessionID = req.sessionID;
  }
  if (req.workspace) {
    where.push('p.workspace = @workspace');
    params.workspace = req.workspace;
  }
  if (req.filter?.agents?.length) {
    where.push(`p.agent IN (${bindList('agent', req.filter.agents, params)})`);
  }
  if (shape === 'diffs') {
    where.push("p.part_type = 'patch'");
  } else if (req.filter?.partTypes?.length) {
    where.push(`p.part_type IN (${bindList('pt', req.filter.partTypes, params)})`);
  }
  if (req.filter?.toolNames?.length) {
    where.push(`p.tool_name IN (${bindList('tn', req.filter.toolNames, params)})`);
  }
  if (req.filter?.timeRange) {
    where.push('p.created_ms BETWEEN @startMs AND @endMs');
    params.startMs = req.filter.timeRange.startMs;
    params.endMs = req.filter.timeRange.endMs;
  }

  const sql = useFts
    ? `
    SELECT p.part_id, p.swarm_run_id, p.session_id, p.agent, p.part_type, p.tool_name,
           p.created_ms, snippet(parts_fts, 0, '[', ']', '…', 16) AS snip
    FROM parts_fts
    JOIN parts p ON p.rowid = parts_fts.rowid
    WHERE parts_fts MATCH @fts
      ${where.length ? 'AND ' + where.join(' AND ') : ''}
    ORDER BY rank
    LIMIT @limit
  `
    : `
    SELECT p.part_id, p.swarm_run_id, p.session_id, p.agent, p.part_type, p.tool_name,
           p.created_ms, substr(p.text, 1, 240) AS snip
    FROM parts p
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.created_ms DESC
    LIMIT @limit
  `;

  if (useFts) params.fts = ftsQuery;
  params.limit = limit;

  const rows = db.prepare(sql).all(params) as Array<{
    part_id: string;
    swarm_run_id: string;
    session_id: string;
    agent: string | null;
    part_type: string;
    tool_name: string | null;
    created_ms: number;
    snip: string | null;
  }>;

  let tokenEstimate = 0;
  const items: RecallPartItem[] = rows.map((r) => {
    const snippet = r.snip ?? '';
    tokenEstimate += estimateTokens(snippet);
    return {
      kind: 'part',
      partID: r.part_id,
      swarmRunID: r.swarm_run_id,
      sessionID: r.session_id,
      agent: r.agent,
      partType: r.part_type,
      toolName: r.tool_name,
      createdMs: r.created_ms,
      snippet,
    };
  });

  return {
    items: items as RecallItem[],
    tokenEstimate,
    truncated: rows.length === limit,
    shape,
  };
}

// Helper: bind a list of values into a parametrized IN (...) clause without
// building a raw string. Avoids SQL injection via untrusted agents / tool
// names and keeps prepared-statement caching working across calls.
function bindList(
  prefix: string,
  values: string[],
  params: Record<string, unknown>
): string {
  const keys: string[] = [];
  values.forEach((v, i) => {
    const key = `${prefix}${i}`;
    params[key] = v;
    keys.push('@' + key);
  });
  return keys.join(', ');
}
