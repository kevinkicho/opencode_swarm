// GET /api/_debug/swarm-run/:swarmRunID/parse-failures
//
// Aggregates parse-failure findings from a run's board, grouped by
// pattern and role. Used by developers to identify the most common
// parse-failure shapes and prioritize regex improvements.
//
// Returns:
//   { byPattern: { [pattern]: { [role]: { count, examples[] } } },
//     total: number }

import type { NextRequest } from 'next/server';
import { getRun } from '@/lib/server/swarm-registry';
import { listBoardItems } from '@/lib/server/blackboard/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface PatternRoleBucket {
  count: number;
  examples: Array<{ content: string; note: string }>;
}

type ByPattern = Record<string, Record<string, PatternRoleBucket>>;

export async function GET(
  _req: NextRequest,
  { params }: { params: { swarmRunID: string } },
) {
  if (!process.env.DEBUG_ENABLED && process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'debug endpoints disabled in production' }, { status: 403 });
  }

  const { swarmRunID } = params;
  const meta = await getRun(swarmRunID);
  if (!meta) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }

  const items = listBoardItems(swarmRunID);
  const failures = items.filter(
    (i) => i.kind === 'finding' && i.content?.includes('parse-failure'),
  );

  const byPattern: ByPattern = {};
  let total = 0;

  for (const item of failures) {
    // Content format: "[pattern] role parse-failure"
    // e.g., "[critic-loop] critic parse-failure"
    const contentMatch = item.content?.match(/^\[(.+?)\]\s+(.+?)\s+parse-failure$/);
    if (!contentMatch) continue;
    const pattern = contentMatch[1];
    const role = contentMatch[2];

    if (!byPattern[pattern]) byPattern[pattern] = {};
    if (!byPattern[pattern][role]) {
      byPattern[pattern][role] = { count: 0, examples: [] };
    }
    byPattern[pattern][role].count += 1;
    total += 1;

    // Keep up to 5 examples per pattern+role bucket
    if (byPattern[pattern][role].examples.length < 5) {
      byPattern[pattern][role].examples.push({
        content: item.content,
        note: item.note?.slice(0, 500) ?? '',
      });
    }
  }

  return new Response(
    JSON.stringify({ byPattern, total }, null, 2),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}