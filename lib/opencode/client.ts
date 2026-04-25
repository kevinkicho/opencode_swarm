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

export async function getProjects(): Promise<OpencodeProject[]> {
  const path = '/project';
  const res = await opencodeFetch(path);
  if (!res.ok) throw new Error(`opencode ${path} -> HTTP ${res.status}`);
  return parseOpencodeJSON(res, isOpencodeProjectArray, `GET ${path}`);
}

export async function getSessionsByDirectory(directory: string): Promise<OpencodeSession[]> {
  const qs = new URLSearchParams({ directory });
  const path = `/session?${qs.toString()}`;
  const res = await opencodeFetch(path);
  if (!res.ok) throw new Error(`opencode ${path} -> HTTP ${res.status}`);
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
  if (!res.ok) throw new Error(`opencode ${path} -> HTTP ${res.status}`);
  return parseOpencodeJSON(res, isOpencodeMessageArray, `GET ${path}`);
}
