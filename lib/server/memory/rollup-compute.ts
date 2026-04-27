//
// Pure-compute side of the rollup pipeline: deterministic functions
// that take messages and produce AgentRollup / RunRetro shapes. No
// HTTP, no opencode, no DB. Orchestration (generateRollup + cousins)
// and side-effecting capture (captureSessionDiffs) stay in rollup.ts
// so callers see one entry point. The split makes the reducer logic
// testable in isolation (no opencode mocks needed).

import 'server-only';

import crypto from 'node:crypto';

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

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// Plan-state tracker: walks todowrite snapshots across a session so we can
// attribute each patch to whichever todo was in_progress when it landed.
// DESIGN.md §8.4 — temporal attribution, v1. Multiple concurrent in_progress
// todos resolve to the *first* one in document order (opencode's convention
// is one-at-a-time, but the shape allows more).
export interface RawTodoState {
  content: string;
  status?: string;
}

export function extractTodowriteTodos(state: unknown): RawTodoState[] | null {
  if (!state || typeof state !== 'object') return null;
  const s = state as { input?: unknown };
  if (!s.input || typeof s.input !== 'object') return null;
  const inp = s.input as { todos?: unknown };
  if (!Array.isArray(inp.todos)) return null;
  return inp.todos.filter(
    (t): t is RawTodoState =>
      !!t && typeof t === 'object' && typeof (t as RawTodoState).content === 'string'
  );
}

export function firstInProgressHash(todos: RawTodoState[]): string | null {
  for (const t of todos) {
    if (t.status === 'in_progress') return sha256(t.content);
  }
  return null;
}

// Cost fallback mirrors swarm-registry.ts costForAssistant. Duplicated so
// this module has no import from anywhere client-adjacent; both should be
// moved into a `lib/server/opencode-metrics.ts` helper when/if a third
// caller appears.
export function costForAssistant(info: OpencodeMessageInfo): number {
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
export function reduceSession(
  swarmRunID: string,
  workspace: string,
  sessionID: string,
  messages: OpencodeMessage[],
  // §8.3 option (a) anchor: if this session was spawned by a task call
  // with an injected `[todo:<id>]` prefix, the caller passes that ID
  // here. Used as the default origin for any patch the agent makes
  // without first calling todowrite itself. Null when no parent task
  // call carried a prefix — reduceSession falls back to option (b)
  // temporal attribution via planState.inProgressHash.
  sessionOriginTodoID: string | null = null,
): AgentRollup {
  let tokensIn = 0;
  let tokensOut = 0;
  let toolCalls = 0;
  let retries = 0;
  let compactions = 0;
  let toolSuccessRate = 0;
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

  // Chronological walk is required for the plan-state tracker — a patch
  // should see the todowrite snapshot that landed *before* it, even when
  // parts straddle message boundaries.
  const ordered = [...messages].sort(
    (a, b) => a.info.time.created - b.info.time.created
  );

  const planState: PlanState = { inProgressHash: null, lastTodos: null };

  for (const m of ordered) {
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
        planState,
        sessionOriginTodoID,
        onToolCall: () => {
          toolCalls += 1;
          // Recalculate success rate whenever a tool call happens
          const total = toolCalls + retries;
          toolSuccessRate = total > 0 ? (toolCalls - retries) / total : 0;
        },
        onRetry: () => {
          retries += 1;
          // Recalculate success rate whenever a retry happens
          const total = toolCalls + retries;
          toolSuccessRate = total > 0 ? (toolCalls - retries) / total : 0;
        },
        onCompaction: () => (compactions += 1),
      });
    }
  }

  const plan = planState.lastTodos
    ? planState.lastTodos.map((t) => ({
        id: sha256(t.content),
        content: t.content,
        status: normalizePlanStatus(t.status),
      }))
    : undefined;

  return {
    kind: 'agent',
    swarmRunID,
    sessionID,
    workspace,
    agent: { name: agentName, model: agentModel ?? '' },
    closedAt: endMs ?? Date.now(),
    outcome,
    counters: { tokensIn, tokensOut, toolCalls, retries, compactions, toolSuccessRate },
    artifacts,
    failures,
    decisions,
    deps: { spawned },
    ...(plan ? { plan } : {}),
    // cost is tracked on RunRetro, not per-session, per DESIGN.md §7.4
  };
}

// Tighten opencode's free-form status string to our typed union. Unknown
// values fall through to 'pending' — matches transform.ts mapTodoStatus.
export function normalizePlanStatus(
  s: string | undefined
): NonNullable<AgentRollup['plan']>[number]['status'] {
  switch (s) {
    case 'completed': return 'completed';
    case 'in_progress': return 'in_progress';
    case 'failed': return 'failed';
    case 'cancelled':
    case 'abandoned': return 'abandoned';
    default: return 'pending';
  }
}

interface PlanState {
  inProgressHash: string | null;
  // Snapshot of the latest todowrite payload — stored so the agent rollup
  // can ship the final plan alongside originTodoID hashes. Without this,
  // the viewer can't resolve a hash back to human-readable text.
  lastTodos: RawTodoState[] | null;
}

interface PartReduceContext {
  artifacts: AgentRollup['artifacts'];
  failures: AgentRollup['failures'];
  decisions: AgentRollup['decisions'];
  spawned: string[];
  planState: PlanState;
  // §8.3 (a) session-level fallback. Null when the session wasn't spawned
  // by a prefix-tagged task call. In-session planState.inProgressHash still
  // wins when present — it's the most specific attribution available.
  sessionOriginTodoID: string | null;
  onToolCall: () => void;
  onRetry: () => void;
  onCompaction: () => void;
}

export function reducePart(p: OpencodePart, ctx: PartReduceContext): void {
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
      // todowrite snapshot drives originTodoID attribution for later
      // patches. Each call replaces the list entirely; skip errored calls so
      // a transient failure doesn't blank out the prior state.
      if (p.tool === 'todowrite' && status !== 'error') {
        const todos = extractTodowriteTodos(state);
        if (todos) {
          ctx.planState.inProgressHash = firstInProgressHash(todos);
          ctx.planState.lastTodos = todos;
        }
      }
      return;
    }
    case 'patch': {
      // opencode's patch parts carry a file list + a content hash. Counting
      // +/- lines requires fetching the session diff (not done here — the
      // rollup stays cheap). Leave added/removed undefined; the viewer can
      // resolve via /session/{id}/diff when the detail is asked for.
      //
      // Attribution precedence (DESIGN.md §8.3):
      //   1. In-session planState.inProgressHash — agent called todowrite
      //      within this session before patching; most specific signal.
      //   2. sessionOriginTodoID — parent task injected `[todo:<id>]` when
      //      dispatching this child; inherited across session boundaries.
      //   3. undefined — no attribution; viewer falls back to filename only.
      const originTodoID =
        ctx.planState.inProgressHash ?? ctx.sessionOriginTodoID ?? undefined;
      for (const filePath of p.files) {
        ctx.artifacts.push({
          type: 'patch',
          filePath,
          diffHash: p.hash,
          status: 'merged',
          ...(originTodoID ? { originTodoID } : {}),
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
export function aggregateRetro(
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
