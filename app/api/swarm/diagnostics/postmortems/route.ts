// GET /api/swarm/diagnostics/postmortems
// Returns postmortem frequency statistics from docs/POSTMORTEMS/

import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PM_DIR = resolve(process.cwd(), 'docs', 'POSTMORTEMS');

function parseDate(filename: string): Date | null {
  const m = filename.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function GET(): Response {
  try {
    const files = readdirSync(PM_DIR).filter(
      (f) => f.endsWith('.md') && f !== 'README.md',
    );

    const dates: Date[] = [];
    for (const f of files) {
      const d = parseDate(f);
      if (d) dates.push(d);
    }

    dates.sort((a, b) => a.getTime() - b.getTime());

    if (dates.length === 0) {
      return Response.json({
        count: 0,
        firstDate: null,
        lastDate: null,
        spanWeeks: 0,
        rate: 0,
      });
    }

    const first = dates[0];
    const last = dates[dates.length - 1];
    const spanDays = (last.getTime() - first.getTime()) / (24 * 60 * 60 * 1000);
    const spanWeeks = spanDays / 7;
    const rate = spanWeeks > 0 ? dates.length / spanWeeks : dates.length;

    return Response.json({
      count: dates.length,
      firstDate: first.toISOString().slice(0, 10),
      lastDate: last.toISOString().slice(0, 10),
      spanWeeks: Math.round(spanWeeks * 10) / 10,
      rate: Math.round(rate * 10) / 10,
    });
  } catch (err) {
    return Response.json(
      { error: 'failed to read postmortems', detail: (err as Error).message },
      { status: 500 },
    );
  }
}
