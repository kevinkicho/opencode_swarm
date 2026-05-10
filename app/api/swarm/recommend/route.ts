import type { NextRequest } from 'next/server';
import { readRunHistory, recommendFromHistory } from '@/lib/server/run-history';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const directive = url.searchParams.get('directive') || '';

  const history = await readRunHistory(50);
  const recommendation = recommendFromHistory(directive, history);

  if (!recommendation) {
    return Response.json({
      recommendation: null,
      historyCount: history.length,
      recentPatterns: history.slice(0, 5).map((r) => ({
        pattern: r.pattern,
        costPerTodo: r.costPerTodo,
        completionRate: r.completionRate,
      })),
    });
  }

  return Response.json({ recommendation, historyCount: history.length });
}
