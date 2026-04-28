// Server-only opencode HTTP client.
// Do NOT import this from a Client Component — credentials from .env must never
// ship to the browser. Route handlers and server components only.
//
// Shape definitions live in ./types so both server and browser modules share
// one source of truth. This file re-exports them for back-compat with existing
// `@/lib/opencode/client` imports.

import type {
  OpencodeProject,
  OpencodeSession,
  OpencodeMessage,
} from './types';
import { parseOpencodeJSON } from './runtime-shape';
import {
  isOpencodeMessageArray,
  isOpencodeProjectArray,
  isOpencodeSessionArray,
} from './validators';
import { OpencodeHttpError } from './errors';

export type {
  OpencodeProject,
  OpencodeSession,
  OpencodeMessage,
  OpencodeMessageInfo,
  OpencodeRole,
  OpencodePartType,
  OpencodeTokenUsage,
  OpencodePart,
  OpencodePartBase,
  OpencodeTextPart,
  OpencodeReasoningPart,
  OpencodeToolPart,
  OpencodeStepStartPart,
  OpencodeStepFinishPart,
} from './types';

import {
  OPENCODE_BASIC_PASS,
  OPENCODE_BASIC_USER,
  OPENCODE_URL,
} from '../config';

function basicAuthHeader(): string | null {
  if (!OPENCODE_BASIC_USER && !OPENCODE_BASIC_PASS) return null;
  const token = Buffer.from(
    `${OPENCODE_BASIC_USER ?? ''}:${OPENCODE_BASIC_PASS ?? ''}`,
  ).toString('base64');
  return `Basic ${token}`;
}

export function opencodeBaseUrl(): string {
  return OPENCODE_URL;
}

// Circuit breaker for the opencode HTTP layer. When opencode :4097 is
// down, every fetch hangs for ~10s waiting on the OS-level TCP timeout.
// A 130-run picker fan-out used to add 11s+ to every cold load (measured
// 2026-04-27). The breaker tracks recent failures in a short rolling
// window and short-circuits subsequent calls until a cooldown probe
// succeeds. Effect: first failure pays the timeout, the next ~5s of
// calls return immediately with a synthesized 503 — the caller's
// existing error path handles that the same as a real outage.
const CIRCUIT_FAIL_THRESHOLD = 3; // # of failures within window to trip
const CIRCUIT_WINDOW_MS = 2_000; // window for counting failures
const CIRCUIT_COOLDOWN_MS = 5_000; // how long the breaker stays tripped
const CIRCUIT_KEY = Symbol.for('opencode_swarm.circuitBreaker.v1');
interface CircuitState {
  recentFailures: number[];
  trippedUntil: number;
}
function circuitState(): CircuitState {
  const g = globalThis as { [CIRCUIT_KEY]?: CircuitState };
  let s = g[CIRCUIT_KEY];
  if (!s) {
    s = { recentFailures: [], trippedUntil: 0 };
    g[CIRCUIT_KEY] = s;
  }
  return s;
}
function recordFailure(): void {
  const s = circuitState();
  const now = Date.now();
  s.recentFailures = s.recentFailures.filter((t) => now - t < CIRCUIT_WINDOW_MS);
  s.recentFailures.push(now);
  if (s.recentFailures.length >= CIRCUIT_FAIL_THRESHOLD) {
    s.trippedUntil = now + CIRCUIT_COOLDOWN_MS;
  }
}
function recordSuccess(): void {
  const s = circuitState();
  s.recentFailures.length = 0;
  s.trippedUntil = 0;
}
function isCircuitTripped(): boolean {
  return Date.now() < circuitState().trippedUntil;
}

// Default per-call timeout. Long enough to absorb a slow but live opencode
// (the /message endpoint can take 10-15s for huge sessions); short enough
// that a hard outage doesn't block the entire request fan-out for 30s+.
// Callers that need a longer ceiling (SSE streams, big POSTs) pass their
// own AbortSignal — `init.signal` is honored as-is.
const DEFAULT_TIMEOUT_MS = 8_000;

export async function opencodeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (isCircuitTripped()) {
    // Synthesize a 503 so callers' existing fail paths handle this without
    // a separate code branch. The body mirrors a generic "service down"
    // response so JSON parsers don't choke.
    return new Response(
      JSON.stringify({ error: 'opencode unreachable (circuit-breaker tripped)' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }
  const url = new URL(path, OPENCODE_URL);
  const headers = new Headers(init.headers);
  const auth = basicAuthHeader();
  if (auth) headers.set('Authorization', auth);

  // If the caller provided their own signal, honor it without composing a
  // new timeout — they're opting out of our default budget.
  if (init.signal) {
    try {
      const res = await fetch(url, { ...init, headers, cache: 'no-store' });
      if (res.ok) recordSuccess();
      else if (res.status >= 500) recordFailure();
      return res;
    } catch (err) {
      recordFailure();
      throw err;
    }
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, headers, cache: 'no-store', signal: ctl.signal });
    if (res.ok) recordSuccess();
    else if (res.status >= 500) recordFailure();
    return res;
  } catch (err) {
    recordFailure();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function getProjects(): Promise<OpencodeProject[]> {
  const path = '/project';
  const res = await opencodeFetch(path);
  if (!res.ok) throw new OpencodeHttpError(path, res.status);
  return parseOpencodeJSON(res, isOpencodeProjectArray, `GET ${path}`);
}

export async function getSessionsByDirectory(directory: string): Promise<OpencodeSession[]> {
  const qs = new URLSearchParams({ directory });
  const path = `/session?${qs.toString()}`;
  const res = await opencodeFetch(path);
  if (!res.ok) throw new OpencodeHttpError(path, res.status);
  return parseOpencodeJSON(res, isOpencodeSessionArray, `GET ${path}`);
}

// `/session` on its own is server-cwd-scoped and truncates the list.
// Real "all sessions" = fan out across every project's worktree, dedupe, sort by recency.
export async function getAllSessions(): Promise<OpencodeSession[]> {
  const projects = await getProjects();
  const batches = await Promise.all(
    projects.map((p) =>
      getSessionsByDirectory(p.worktree).catch(() => [] as OpencodeSession[])
    )
  );
  const seen = new Set<string>();
  const rows: OpencodeSession[] = [];
  for (const batch of batches) {
    for (const s of batch) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      rows.push(s);
    }
  }
  rows.sort((a, b) => b.time.updated - a.time.updated);
  return rows;
}

export async function getSessionMessages(sessionId: string): Promise<OpencodeMessage[]> {
  const path = `/session/${encodeURIComponent(sessionId)}/message`;
  const res = await opencodeFetch(path);
  if (!res.ok) throw new OpencodeHttpError(path, res.status);
  return parseOpencodeJSON(res, isOpencodeMessageArray, `GET ${path}`);
}
