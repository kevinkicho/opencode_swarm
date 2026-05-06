// GET /api/swarm/memory/lessons?workspace=...
//
// Returns lessons from the most recent RunRetro for the given workspace.
// Used by the new-run modal to seed the directive with lessons from the
// previous run. Returns an empty array when no retro exists.

import type { NextRequest } from 'next/server';

import { getLatestLessonsForWorkspace } from '@/lib/server/memory/reader';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const url = req.nextUrl;
  const workspace = url.searchParams.get('workspace');
  if (!workspace) {
    return Response.json({ error: 'workspace query parameter required' }, { status: 400 });
  }
  const lessons = getLatestLessonsForWorkspace(workspace);
  return Response.json({ lessons: lessons ?? [] }, { status: 200 });
}