// GET /api/swarm/memory/recent — return the last N memory entries for a workspace.
//
// Query params:
//   workspace (required) — absolute path or cwd-relative path
//   n        (optional)  — how many entries, default 5, max 20
//
// Not authenticated — personal-use deployment.

import type { NextRequest } from 'next/server';
import { resolve } from 'node:path';

import { readRecentMemory } from '@/lib/server/memory/memory-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = req.nextUrl;
  const workspace = searchParams.get('workspace');
  if (!workspace) {
    return Response.json({ error: 'workspace is required' }, { status: 400 });
  }
  // Prevent path traversal — resolve and reject paths with .. segments
  // or paths that don't look like absolute/local directories.
  const resolved = resolve(workspace);
  if (resolved.includes('..')) {
    return Response.json({ error: 'workspace path must not contain ..' }, { status: 400 });
  }
  const nRaw = searchParams.get('n');
  const n = Math.min(Math.max(Number(nRaw) || 5, 1), 20);
  try {
    const entries = await readRecentMemory(workspace, n);
    return Response.json({ entries });
  } catch (err) {
    return Response.json(
      { error: 'read failed', detail: (err as Error).message },
      { status: 500 },
    );
  }
}