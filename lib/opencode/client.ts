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

const OPENCODE_URL = process.env.OPENCODE_URL ?? 'http://localhost:4096';
const OPENCODE_BASIC_USER = process.env.OPENCODE_BASIC_USER ?? '';
const OPENCODE_BASIC_PASS = process.env.OPENCODE_BASIC_PASS ?? '';

function basicAuthHeader(): string | null {
  if (!OPENCODE_BASIC_USER && !OPENCODE_BASIC_PASS) return null;
  const token = Buffer.from(`${OPENCODE_BASIC_USER}:${OPENCODE_BASIC_PASS}`).toString('base64');
  return `Basic ${token}`;
}

export function opencodeBaseUrl(): string {
  return OPENCODE_URL;
}

export async function opencodeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, OPENCODE_URL);
  const headers = new Headers(init.headers);
  const auth = basicAuthHeader();
  if (auth) headers.set('Authorization', auth);
  return fetch(url, { ...init, headers, cache: 'no-store' });
}

async function getJson<T>(path: string): Promise<T> {
  const res = await opencodeFetch(path);
  if (!res.ok) {
    throw new Error(`opencode ${path} -> HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body && typeof body === 'object' && !Array.isArray(body) && 'value' in body) {
    return (body as { value: T }).value;
  }
  return body as T;
}

export function getProjects(): Promise<OpencodeProject[]> {
  return getJson<OpencodeProject[]>('/project');
}

export function getSessionsByDirectory(directory: string): Promise<OpencodeSession[]> {
  const qs = new URLSearchParams({ directory });
  return getJson<OpencodeSession[]>(`/session?${qs.toString()}`);
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

export function getSessionMessages(sessionId: string): Promise<OpencodeMessage[]> {
  return getJson<OpencodeMessage[]>(`/session/${encodeURIComponent(sessionId)}/message`);
}
