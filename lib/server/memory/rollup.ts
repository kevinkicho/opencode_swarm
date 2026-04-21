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

import crypto from 'node:crypto';

import { memoryDb } from './db';
import { getRun, listRuns } from '../swarm-registry';
import { getSessionMessagesServer } from '../opencode-server';
import { priceFor } from '../../opencode/pricing';
import type {
  OpencodeMessage,
  OpencodeMessageInfo,
  OpencodePart,
} from '../../opencode/types';
import type { SwarmRunMeta } from '../../swarm-run-types';
import type { AgentRollup, RunRetro } from './types';

// A decision heuristic: reasoning parts that start with (or contain early)
// one of these verbs get promoted to the `decisions[]` list. The full text
// isn't copied — only a short excerpt — so this stays cheap even on chatty
// sessions.
const DECISION_MARKERS = [
  'decided',
  'chose',
  'will use',
  'opting for',
  'going with',
  'ruled out',
  'rejected',
];

const DECISION_EXCERPT_LEN = 140;
const LESSON_EXCERPT_LEN = 200;

// Heuristic lessons: count tool-error frequencies; anything above N within
// the run surfaces as a tool-failure lesson. Keep the bar low at v1 — the
// signal is "this tool was painful", not statistical significance.
const LESSON_ERROR_THRESHOLD = 3;

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// Cost fallback mirrors swarm-registry.ts costForAssistant. Duplicated so
// this module has no import from anywhere client-adjacent; both should be
// moved into a `lib/server/opencode-metrics.ts` helper when/if a third
// caller appears.
function costForAssistant(info: OpencodeMessageInfo): number {
  if (typeof info.cost === 'number') return info.cost;
  const price = priceFor(info.modelID);
  const t = info.tokens;
  if (!price || !t) return 0;
  const input = t.input * price.input;
  const output = t.output * price.output;
  const cachedRead = t.cache.read * price.cached;
  const cachedWrite = t.cache.write * (price.write ?? price.input);
  return (input + output + cachedRead + cachedWrite) / 1_000_000;
}

// Reduce a list of OpencodeMessages into the shape we want per session.
// Pulls counters from assistant `info`, artifacts from patch parts,
// failures from errored tool parts, and candidate decisions from reasoning.
function reduceSession(
  swarmRunID: string,
  workspace: string,
  sessionID: string,
  messages: OpencodeMessage[]
): AgentRollup {
  let tokensIn = 0;
  let tokensOut = 0;
  let toolCalls = 0;
  let retries = 0;
  let compactions = 0;
  let costUSD = 0;
  let startMs: number | null = null;
  let endMs: number | null = null;
  let agentName = 'unknown';
  let agentModel: string | undefined;
  let outcome: AgentRollup['outcome'] = 'partial';

  const artifacts: AgentRollup['artifacts'] = [];
  const failures: AgentRollup['failures'] = [];
  const decisions: AgentRollup['decisions'] = [];
  const spawned: string[] = [];

  for (const m of messages) {
    const info = m.info;
    startMs = startMs == null ? info.time.created : Math.min(startMs, info.time.created);
    endMs = Math.max(endMs ?? 0, info.time.completed ?? info.time.created);

    if (info.role === 'assistant') {
      if (info.agent) agentName = info.agent;
      if (info.modelID) agentModel = info.modelID;
      if (info.tokens) {
        tokensIn += info.tokens.input;
        tokensOut += info.tokens.output;
      }
      costUSD += costForAssistant(info);
      if (info.error) outcome = 'aborted';
      else if (info.time.completed) outcome = outcome === 'aborted' ? 'aborted' : 'merged';
    }

    for (const p of m.parts) {
      reducePart(p, {
        artifacts,
        failures,
        decisions,
        spawned,
        onToolCall: () => (toolCalls += 1),
        onRetry: () => (retries += 1),
        onCompaction: () => (compactions += 1),
      });
    }
  }

  return {
    kind: 'agent',
    swarmRunID,
    sessionID,
    workspace,
    agent: { name: agentName, model: agentModel ?? '' },
    closedAt: endMs ?? Date.now(),
    outcome,
    counters: { tokensIn, tokensOut, toolCalls, retries, compactions },
    artifacts,
    failures,
    decisions,
    deps: { spawned },
    // cost is tracked on RunRetro, not per-session, per DESIGN.md §7.4
  };
}

interface PartReduceContext {
  artifacts: AgentRollup['artifacts'];
  failures: AgentRollup['failures'];
  decisions: AgentRollup['decisions'];
  spawned: string[];
  onToolCall: () => void;
  onRetry: () => void;
  onCompaction: () => void;
}

function reducePart(p: OpencodePart, ctx: PartReduceContext): void {
  switch (p.type) {
    case 'tool': {
      ctx.onToolCall();
      const state = (p as unknown as { state?: { status?: string; error?: string; output?: string } }).state;
      const status = state && typeof state === 'object' ? state.status : undefined;
      if (status === 'error') {
        const err = typeof state?.error === 'string' ? state.error : undefined;
        ctx.failures.push({
          tool: p.tool ?? 'unknown',
          argsHash: err ? sha256(err) : undefined,
          resolution: 'abandoned',
        });
      }
      // child-session id lives on the task tool's output — opaque at this
      // layer, so capture whatever string we can find without unwrapping
      if (p.tool === 'task' && state && typeof state === 'object') {
        const maybeChild =
          (state as { sessionID?: string; childSessionID?: string }).sessionID ??
          (state as { childSessionID?: string }).childSessionID;
        if (typeof maybeChild === 'string' && !ctx.spawned.includes(maybeChild)) {
          ctx.spawned.push(maybeChild);
        }
      }
      return;
    }
    case 'patch': {
      // opencode's patch parts carry a file list + a content hash. Counting
      // +/- lines requires fetching the session diff (not done here — the
      // rollup stays cheap). Leave added/removed undefined; the viewer can
      // resolve via /session/{id}/diff when the detail is asked for.
      for (const filePath of p.files) {
        ctx.artifacts.push({
          type: 'patch',
          filePath,
          diffHash: p.hash,
          status: 'merged',
        });
      }
      return;
    }
    case 'reasoning': {
      const text = (p as { text?: string }).text;
      if (!text) return;
      const lowered = text.toLowerCase();
      const found = DECISION_MARKERS.find((m) => lowered.includes(m));
      if (!found) return;
      const excerpt = text.length > DECISION_EXCERPT_LEN
        ? text.slice(0, DECISION_EXCERPT_LEN) + '…'
        : text;
      ctx.decisions.push({
        at: Date.now(),
        choice: excerpt,
        rationaleHash: sha256(text),
      });
      return;
    }
    default:
      return;
  }
}

// Aggregate per-session rollups into one run-level retro. Lessons are
// mechanical heuristics — they're a *bootstrap* for future runs, not the
// final word. When a dedicated librarian agent ships (§7.6), it can read
// the same L0+L1 and produce richer prose; until then, these signal-based
// entries are better than nothing.
function aggregateRetro(
  meta: SwarmRunMeta,
  rollups: AgentRollup[]
): RunRetro {
  const start = Math.min(...rollups.map((r) => r.closedAt));
  const end = Math.max(...rollups.map((r) => r.closedAt));
  const tokensTotal = rollups.reduce(
    (acc, r) => acc + r.counters.tokensIn + r.counters.tokensOut,
    0
  );
  // Cost lives on the list endpoint; we don't duplicate it here because a
  // rollup write race could let it drift from the authoritative sum. Leave
  // it at 0 and read the list endpoint when callers want $.
  const costUSD = 0;

  const filesFinal = new Set<string>();
  for (const r of rollups) {
    for (const a of r.artifacts) {
      if (a.filePath) filesFinal.add(a.filePath);
    }
  }

  const toolErrorCounts = new Map<string, number>();
  for (const r of rollups) {
    for (const f of r.failures) {
      toolErrorCounts.set(f.tool, (toolErrorCounts.get(f.tool) ?? 0) + 1);
    }
  }
  const lessons: RunRetro['lessons'] = [];
  for (const [tool, count] of toolErrorCounts) {
    if (count >= LESSON_ERROR_THRESHOLD) {
      lessons.push({
        tag: 'tool-failure',
        text: `${tool} failed ${count}× in this run — consider alternate tool or pre-flight check`.slice(
          0,
          LESSON_EXCERPT_LEN
        ),
        evidencePartIDs: [],
      });
    }
  }

  // Outcome aggregation: if *any* session aborted, the run is aborted; if
  // any is partial, the run is… partial isn't in the RunRetro shape, so it
  // rolls up to 'failed' which is closer to user-visible truth than pretending
  // we completed. All-merged → completed.
  let outcome: RunRetro['outcome'] = 'completed';
  for (const r of rollups) {
    if (r.outcome === 'aborted') {
      outcome = 'aborted';
      break;
    }
    if (r.outcome !== 'merged') outcome = 'failed';
  }

  return {
    kind: 'retro',
    swarmRunID: meta.swarmRunID,
    workspace: meta.workspace,
    directive: meta.directive ?? null,
    outcome,
    timeline: { start, end, durationMs: end - start },
    cost: { tokensTotal, costUSD },
    participants: rollups.map((r) => r.sessionID),
    artifactGraph: {
      filesFinal: Array.from(filesFinal).sort(),
      commits: [],
      prURLs: [],
    },
    lessons,
  };
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
