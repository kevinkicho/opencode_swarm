// Server-side opencode HTTP helpers.
//
// These mirror the `createSessionBrowser` / `postSessionMessageBrowser` pair in
// `lib/opencode/live.ts`, but call opencode directly from Node via
// `opencodeFetch` instead of going through the `/api/opencode` proxy. Route
// handlers that orchestrate multiple opencode calls (e.g. the swarm-run
// endpoint) use these so they can (a) reuse the same Basic-auth resolution
// everywhere and (b) avoid a self-request round-trip back into the proxy.
//
// Do NOT import this module from a Client Component — it reads server-only
// env vars indirectly (via `opencodeFetch`).
//
// Wire shapes intentionally match the browser helpers line-for-line so the
// swarm-run route can be migrated to pattern='blackboard' / 'map-reduce' by
// fanning out calls here without touching the browser's expectation of what
// an opencode session looks like.

import { opencodeFetch } from '../opencode/client';
import type { OpencodeSession } from '../opencode/client';
import type { OpencodeBuiltinAgent, OpencodeMessage } from '../opencode/types';
import { parseOpencodeJSON } from '../opencode/runtime-shape';
import {
  isOpencodeDiffArray,
  isOpencodeMessageArray,
  isOpencodeSession,
  type OpencodeDiffEntry,
} from '../opencode/validators';
import { estimateTokens, getModelContextLimit } from './opencode-models';
import { startOpencodeLogTail } from './opencode-log-tail';

// POSTMORTEMS/2026-04-24 F2 — kick the opencode log tail on first
// import of this module. instrumentation.ts was the textbook home
// for this but Next.js 14's instrumentationHook pulls instrumentation
// into every route's webpack closure, including Edge ones, where
// fs/os imports fail to resolve. Self-starting from here means the
// tail comes alive the moment any API route touches opencode (which
// is guaranteed before any swarm activity), without breaking the
// build for unrelated routes. Idempotent — second call is a no-op.
startOpencodeLogTail();

// Preflight thresholds — POSTMORTEMS/2026-04-24 F7. Refuse dispatch
// when the prompt's token estimate exceeds 85% of the model's
// context limit; log WARN at 60%. The 85% ceiling leaves headroom
// for tool definitions opencode injects and for the assistant's own
// response budget; the 60% warning lets a sweep proceed with a
// telegraphed risk so the operator can decide whether to retry with
// a smaller prompt.
const PROMPT_REFUSE_RATIO = 0.85;
const PROMPT_WARN_RATIO = 0.6;

// F7 context-size cache. The assembled-context check (layer 2) calls
// getSessionMessagesServer on every dispatch to find the latest
// baselineTokens. When the coordinator dispatches multiple claims from a
// single tick (~10s cadence), the session's context barely changes
// between calls — the same assistant turn sits at the tail. Caching the
// baseline per session for PROMPT_WARN_COOLDOWN_MS avoids N redundant
// HTTP round-trips to opencode during rapid sequential claims.
const PROMPT_WARN_COOLDOWN_MS = 60_000;

interface BaselineCacheEntry {
  tokens: number;
  fetchedAt: number;
}

const globalBaselineKey = Symbol.for('opencode_swarm.promptPreflight.baselineCache');
type GlobalWithBaseline = typeof globalThis & {
  [globalBaselineKey]?: Map<string, BaselineCacheEntry>;
};
function baselineCache(): Map<string, BaselineCacheEntry> {
  const g = globalThis as GlobalWithBaseline;
  if (!g[globalBaselineKey]) g[globalBaselineKey] = new Map();
  return g[globalBaselineKey]!;
}

// Create a session scoped to `directory`. Opencode's POST /session accepts
// an optional { title } body; omitting it lets opencode mint a placeholder
// title that we'll overwrite once the first model turn produces a better one.
export async function createSessionServer(
  directory: string,
  title?: string
): Promise<OpencodeSession> {
  const qs = new URLSearchParams({ directory }).toString();
  const res = await opencodeFetch(`/session?${qs}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(title ? { title } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `opencode session create -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`
    );
  }
  return parseOpencodeJSON(res, isOpencodeSession, 'POST /session');
}

// Read session messages. The status deriver only needs the last assistant
// message to classify a run, but opencode's /message endpoint always returns
// the full history — there's no tail/limit param at this revision. At
// prototype scale each call is a few KB, acceptable for a 4s poll over a
// small ledger. If it starts to hurt, the fix is a server-side cache keyed
// by (sessionID, time.updated) — see GET /api/swarm/run for the plan.
export async function getSessionMessagesServer(
  sessionId: string,
  directory: string,
  signal?: AbortSignal
): Promise<OpencodeMessage[]> {
  const qs = new URLSearchParams({ directory }).toString();
  const res = await opencodeFetch(
    `/session/${encodeURIComponent(sessionId)}/message?${qs}`,
    { signal }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `opencode session messages -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`
    );
  }
  return parseOpencodeJSON(
    res,
    isOpencodeMessageArray,
    `GET /session/${sessionId.slice(-8)}/message`,
  );
}

// Session-aggregate diff. Opencode returns one entry per changed file with a
// unified-diff string covering every patch that landed in the session. There
// is no per-turn granularity from this endpoint (?messageID= / ?hash= are
// ignored — probed 2026-04-20); the memory layer stores these at rollup time
// so shape='diffs' recall can return real hunks instead of just part metadata.
export async function getSessionDiffServer(
  sessionId: string,
  directory: string,
  signal?: AbortSignal
): Promise<OpencodeDiffEntry[]> {
  const qs = new URLSearchParams({ directory }).toString();
  const res = await opencodeFetch(
    `/session/${encodeURIComponent(sessionId)}/diff?${qs}`,
    { signal }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `opencode session diff -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`
    );
  }
  return parseOpencodeJSON(
    res,
    isOpencodeDiffArray,
    `GET /session/${sessionId.slice(-8)}/diff`,
  );
}

// Cancels any in-flight model turn for this session. Soft cancel — any tool
// call that already dispatched finishes, but no further reasoning or tool
// invocations fire. Mirrors `abortSessionBrowser` in lib/opencode/live.ts.
//
// Use this whenever a server-side orchestrator gives up on a session (timeout,
// error, etc.) — without an explicit abort the opencode session keeps
// streaming turns into the void, burning tokens on work that no longer has
// a consumer.
export async function abortSessionServer(
  sessionId: string,
  directory: string,
): Promise<void> {
  const qs = new URLSearchParams({ directory }).toString();
  const res = await opencodeFetch(
    `/session/${encodeURIComponent(sessionId)}/abort?${qs}`,
    { method: 'POST' },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `opencode abort -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
    );
  }
}

// Fire-and-forget prompt submission. Uses /prompt_async so the route handler
// can return immediately — SSE surfaces the resulting parts via the run's
// multiplexed events stream.
//
// `agent` is the opencode agent-config name (e.g. "build", "plan"). When set,
// opencode routes this prompt to that agent-config within the session. Omit
// to broadcast to the session's lead agent.
//
// `model` is a direct model ID (e.g. "opencode/claude-sonnet-4-6" or
// "ollama/glm-5.1:cloud"). When set AND agent is unset, opencode runs the
// turn against that model instead of the session's default. When BOTH are
// set, opencode's agent-config takes precedence — the named agent's
// configured model overrides the direct model hint. Used by the team-
// picker wiring to pin a session to a specific provider/model across its
// whole lifetime (the coordinator threads the same `model` through every
// worker dispatch for the session).
export async function postSessionMessageServer(
  sessionId: string,
  directory: string,
  text: string,
  // #7.Q37 — `agent` typed as the built-in set. Passing a custom role
  // label (e.g. 'orchestrator', 'judge') would have opencode silently
  // 204 the POST; the type now catches that at compile time.
  opts: { agent?: OpencodeBuiltinAgent; model?: string } = {}
): Promise<void> {
  // F7 prompt-size preflight. Only fires when opts.model is set
  // (caller passed a specific model — we have a clear key to look up).
  // When opts.model is omitted (opencode resolves the agent's default
  // model), we don't know which model will run the turn so we can't
  // size-check; fall through and let opencode reject if needed.
  //
  // Two layers (2026-04-24 evening):
  //   (1) Text-only check on the new prompt — catches a single
  //       oversized prompt at dispatch time
  //   (2) Conversation-context check (IMPLEMENTATION_PLAN 6.10) —
  //       fetches the session's latest assistant message and uses
  //       its `tokens.input` as the baseline for what opencode will
  //       assemble on the NEXT call (system prompt + tool defs +
  //       history). Adds the new prompt's estimate. Refuses ≥85%
  //       of model limit. This catches the failure mode observed
  //       in run_modm7vsw_uxxy6b: workers cumulatively hit gemma4's
  //       128K window without F7 ever firing because layer (1) only
  //       sees ~1 K of new prompt text.
  if (opts.model) {
    const limit = await getModelContextLimit(opts.model);
    if (limit !== null) {
      const newTokens = estimateTokens(text);

      // Layer (2): assembled-context projection. Check the per-session
      // cache first — during rapid sequential claims the session's context
      // barely changes between dispatches, so a 60s-old baseline is a
      // close enough approximation and saves a full messages HTTP round-
      // trip per claim.
      let baselineTokens = 0;
      let baselineFromCache = false;
      const now = Date.now();
      const cached = baselineCache().get(sessionId);
      if (cached && now - cached.fetchedAt < PROMPT_WARN_COOLDOWN_MS) {
        baselineTokens = cached.tokens;
        baselineFromCache = true;
      }
      if (!baselineFromCache) {
        try {
          const messages = await getSessionMessagesServer(sessionId, directory);
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            const m = messages[i];
            if (m.info.role !== 'assistant') continue;
            if (!m.info.time.completed) continue;
            const t = m.info.tokens;
            if (!t) continue;
            baselineTokens =
              (t.input ?? 0) +
              (t.cache?.read ?? 0) +
              (t.cache?.write ?? 0) +
              (t.output ?? 0);
            break;
          }
          baselineCache().set(sessionId, { tokens: baselineTokens, fetchedAt: now });
        } catch {
          // Message fetch failed (transient opencode hiccup) — fall back
          // to layer (1) only. We don't want a probe failure to block
          // dispatch.
        }
      }

      const projectedTokens = baselineTokens + newTokens;
      const ratio = projectedTokens / limit;
      if (ratio >= PROMPT_REFUSE_RATIO) {
        const limitK = (limit / 1000).toFixed(1);
        const projK = (projectedTokens / 1000).toFixed(1);
        const baseK = (baselineTokens / 1000).toFixed(1);
        const newK = (newTokens / 1000).toFixed(1);
        throw new Error(
          `prompt-preflight refused: ${projK}k projected tokens for ${opts.model} ` +
            `(baseline ${baseK}k from prior turn + ${newK}k new prompt; ` +
            `limit ${limitK}k, ratio ${(ratio * 100).toFixed(0)}% ≥ ${(PROMPT_REFUSE_RATIO * 100).toFixed(0)}%) — ` +
            `session has saturated this model's context; pin to a higher-context model or start a new session`,
        );
      }
      if (ratio >= PROMPT_WARN_RATIO) {
        console.warn(
          `[opencode-server] prompt-preflight WARN: ${(projectedTokens / 1000).toFixed(1)}k projected for ${opts.model} ` +
            `(${(baselineTokens / 1000).toFixed(1)}k history + ${(newTokens / 1000).toFixed(1)}k new; ` +
            `${(ratio * 100).toFixed(0)}% of ${(limit / 1000).toFixed(1)}k limit) — close to refuse threshold`,
        );
      }
    }
  }

  const qs = new URLSearchParams({ directory }).toString();
  const body: Record<string, unknown> = {
    parts: [{ type: 'text', text }],
  };
  if (opts.agent) body.agent = opts.agent;
  if (opts.model) {
    // Opencode's /prompt expects `model` as an object
    // `{ providerID, modelID }`, not a bare string. Parse the canonical
    // `<provider>/<model>` shape used throughout our catalog (e.g.
    // `ollama/glm-5.1:cloud`, `opencode-go/glm-5.1`). First `/` is the
    // provider-model separator; model ID can contain further slashes
    // (`:cloud` suffixes are safe — they're inside the modelID segment).
    const slash = opts.model.indexOf('/');
    if (slash > 0) {
      body.model = {
        providerID: opts.model.slice(0, slash),
        modelID: opts.model.slice(slash + 1),
      };
    } else {
      // No slash — fall back to opencode's default provider with the
      // raw string as modelID. Lets callers pass a bare opencode slug
      // like `glm-5.1` and have opencode resolve its default provider.
      body.model = { providerID: 'opencode', modelID: opts.model };
    }
  }
  const res = await opencodeFetch(
    `/session/${encodeURIComponent(sessionId)}/prompt_async?${qs}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `opencode prompt -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`
    );
  }
}
