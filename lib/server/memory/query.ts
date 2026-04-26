// recall() query implementation. Translates a RecallRequest into one of
// two SQL strategies:
//
//   shape='summary' — hits `rollups` table, returns AgentRollup/RunRetro
//                     digests. Default path; cheapest in tokens and IO.
//                     `filter.filePath` is ignored here — rollups carry file
//                     lists inside the payload blob, not indexed columns, so
//                     path filtering on summaries would require an O(N) JSON
//                     parse per row. Use shape='parts' or 'diffs' for path
//                     queries; callers that want "which rollups touched X"
//                     should follow up with a summary fetch using the
//                     swarmRunIDs surfaced by the parts query.
//   shape='parts'   — hits `parts` (+ parts_fts when filter.query is set),
//                     returns per-part snippets. For "show me the exact
//                     edit part that touched src/auth.ts".
//   shape='diffs'   — hits `parts` filtered to part_type='patch' and
//                     LEFT JOINs the `diffs` table to populate `hunks[]`
//                     on each returned item. Hunk text is the session-
//                     aggregate unified diff captured at rollup time
//                     (opencode's /session/{id}/diff is session-scoped,
//                     not per-patch — see DESIGN.md §7.5 + schema.sql).
//                     Patch parts whose session hasn't been rolled up
//                     yet come back with an empty hunks array.
//
// Budget: we cap `limit` at 50 server-side so a misconfigured caller can't
// blow an agent's context window. Callers paginate by advancing an offset
// cursor in the request shape (not exposed at v1 — single-page fetch is
// sufficient for prototype usage).

import 'server-only';

import { memoryDb } from './db';
import { validateMemoryKindDiscriminator } from '../swarm-registry-validate';
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

// When filter.filePath is set, SQL pre-filters on `file_paths IS NOT NULL`
// plus a coarse LIKE on the pattern's fixed prefix, then JS applies the
// exact shell-glob match. Overfetch multiplier accounts for the rows the
// JS filter will reject; capped so we never scan more than N rows even on
// patterns with no shared prefix.
const FILEPATH_OVERFETCH = 4;

// Very rough token estimate from text length. Good enough to flag when a
// caller should paginate; not a pricing-grade calculation. ~4 chars/token
// is the conventional approximation for English prose/code.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Longest leading substring of `pattern` that contains no glob metachars.
// Used as a SQL LIKE pre-filter so the glob-match JS pass only runs against
// plausibly-matching rows. '**'/'*'/'?'/'[' all terminate the prefix.
function globPrefix(pattern: string): string {
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*' || ch === '?' || ch === '[') break;
    i += 1;
  }
  return pattern.slice(0, i);
}

// Compile a shell-style glob to a RegExp that matches ONE path string.
//   **        → any sequence (including /)
//   *         → any sequence except /
//   ?         → single char except /
//   [abc]     → character class
// Everything else is treated literally and regex-escaped. Anchored to the
// full path (^…$) so `src/auth` doesn't match `foo/src/auth/bar` — the
// caller should use `**/src/auth/**` if they want prefix-free matching.
function globToRegex(pattern: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (pattern[i] === '/') i += 1; // collapse `**/` → `.*`
      continue;
    }
    if (ch === '*') {
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        re += '\\[';
        i += 1;
        continue;
      }
      re += pattern.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (/[.+^$(){}|\\]/.test(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
    i += 1;
  }
  re += '$';
  return new RegExp(re);
}

// Split a `|p1|p2|`-delimited column back into its path components.
// Shared by filePathsMatch and the shape='diffs' hunk hydration pass.
function decodeFilePaths(encoded: string | null): string[] {
  if (!encoded) return [];
  const trimmed = encoded.startsWith('|') ? encoded.slice(1) : encoded;
  const ready = trimmed.endsWith('|') ? trimmed.slice(0, -1) : trimmed;
  if (!ready) return [];
  return ready.split('|').filter(Boolean);
}

// Does any path in a `|p1|p2|`-delimited column match the compiled glob?
function filePathsMatch(encoded: string | null, rx: RegExp): boolean {
  for (const p of decodeFilePaths(encoded)) {
    if (rx.test(p)) return true;
  }
  return false;
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
    // HARDENING_PLAN.md#R7 — validate the kind discriminator before
    // the union cast. Pre-fix the cast trusted any parsed JSON; a row
    // missing the kind field would propagate into UI as agent-shaped
    // garbage. Validator returns null on shape failure (warn-once).
    let blob: AgentRollup | RunRetro | null = null;
    let raw: unknown = null;
    try {
      raw = JSON.parse(r.payload);
    } catch {
      raw = null;
    }
    const checked = raw === null ? null : validateMemoryKindDiscriminator(raw);
    if (checked && (checked.kind === 'retro' || checked.kind === 'agent')) {
      blob = raw as AgentRollup | RunRetro;
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

  // filter.filePath handling: pre-filter at SQL with `file_paths IS NOT NULL`
  // + a LIKE on the pattern's fixed prefix, then apply the compiled glob in
  // JS below. Only rows from patch/file parts land here because ingest only
  // populates file_paths for those types.
  const filePathPattern = req.filter?.filePath?.trim();
  let filePathRegex: RegExp | null = null;
  if (filePathPattern) {
    where.push('p.file_paths IS NOT NULL');
    const prefix = globPrefix(filePathPattern);
    if (prefix.length > 0) {
      // `|<prefix>` anchors on a whole-segment boundary — `src/auth` won't
      // match `mysrc/authless/…`. SQLite `||` concatenation lets us keep the
      // pattern parameterized instead of inlining user input.
      where.push("p.file_paths LIKE '%|' || @fpPrefix || '%'");
      params.fpPrefix = prefix;
    }
    filePathRegex = globToRegex(filePathPattern);
  }

  // Overfetch when we have a JS-side post-filter so the final row count can
  // still reach `limit`. Bounded at MAX_LIMIT * FILEPATH_OVERFETCH to prevent
  // a pathological pattern (no prefix, e.g. `**`) from scanning the whole
  // table — that much scan is still cheap at prototype scale.
  const fetchLimit = filePathRegex ? limit * FILEPATH_OVERFETCH : limit;

  const sql = useFts
    ? `
    SELECT p.part_id, p.swarm_run_id, p.session_id, p.agent, p.part_type, p.tool_name,
           p.created_ms, p.file_paths, snippet(parts_fts, 0, '[', ']', '…', 16) AS snip
    FROM parts_fts
    JOIN parts p ON p.rowid = parts_fts.rowid
    WHERE parts_fts MATCH @fts
      ${where.length ? 'AND ' + where.join(' AND ') : ''}
    ORDER BY rank
    LIMIT @limit
  `
    : `
    SELECT p.part_id, p.swarm_run_id, p.session_id, p.agent, p.part_type, p.tool_name,
           p.created_ms, p.file_paths, substr(p.text, 1, 240) AS snip
    FROM parts p
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.created_ms DESC
    LIMIT @limit
  `;

  if (useFts) params.fts = ftsQuery;
  params.limit = fetchLimit;

  const rows = db.prepare(sql).all(params) as Array<{
    part_id: string;
    swarm_run_id: string;
    session_id: string;
    agent: string | null;
    part_type: string;
    tool_name: string | null;
    created_ms: number;
    file_paths: string | null;
    snip: string | null;
  }>;

  // Apply the shell-style glob on the fetched rows. We stop as soon as we
  // hit `limit` matches so the response stays inside the caller's budget
  // regardless of how many rows the SQL pre-filter let through.
  const matched: typeof rows = [];
  if (filePathRegex) {
    for (const r of rows) {
      if (filePathsMatch(r.file_paths, filePathRegex)) {
        matched.push(r);
        if (matched.length >= limit) break;
      }
    }
  } else {
    matched.push(...rows.slice(0, limit));
  }

  // For shape='diffs', hydrate each matched patch part with the session-
  // aggregate hunk text captured at rollup time. Build a (session_id,
  // file_path) → patch map in one query so N matched parts cost one IN-list
  // lookup, not N per-row joins. Rows with no diff row in the table (session
  // not yet rolled up) get an empty hunks array.
  const hunkMap = new Map<string, string>();
  if (shape === 'diffs' && matched.length > 0) {
    const sessionIDs = Array.from(new Set(matched.map((r) => r.session_id)));
    if (sessionIDs.length > 0) {
      const sessParams: Record<string, unknown> = {};
      const diffSql = `
        SELECT session_id, file_path, patch
        FROM diffs
        WHERE session_id IN (${bindList('ds', sessionIDs, sessParams)})
      `;
      const diffRows = db.prepare(diffSql).all(sessParams) as Array<{
        session_id: string;
        file_path: string;
        patch: string;
      }>;
      for (const d of diffRows) {
        hunkMap.set(`${d.session_id}\u0000${d.file_path}`, d.patch);
      }
    }
  }

  let tokenEstimate = 0;
  const items: RecallPartItem[] = matched.map((r) => {
    const snippet = r.snip ?? '';
    tokenEstimate += estimateTokens(snippet);
    const base: RecallPartItem = {
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
    if (shape === 'diffs') {
      const hunks: Array<{ filePath: string; patch: string }> = [];
      const paths = decodeFilePaths(r.file_paths);
      for (const filePath of paths) {
        const patch = hunkMap.get(`${r.session_id}\u0000${filePath}`);
        if (patch) {
          hunks.push({ filePath, patch });
          tokenEstimate += estimateTokens(patch);
        }
      }
      base.hunks = hunks;
    }
    return base;
  });

  // `truncated` reports whether the caller likely has more to paginate
  // through. For the glob path, that's "SQL returned the overfetch cap AND
  // we actually filled the response" — otherwise either the pre-filter was
  // exhaustive or the glob rejected most rows, both of which are terminal.
  const truncated = filePathRegex
    ? rows.length === fetchLimit && matched.length === limit
    : rows.length === limit;

  return {
    items: items as RecallItem[],
    tokenEstimate,
    truncated,
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
