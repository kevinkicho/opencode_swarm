import { type NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { RunTemplate } from '@/lib/run-template-types';

const TEMPLATES_DIR = path.resolve(process.cwd(), '.opencode_swarm', 'templates');

async function ensureDir(): Promise<void> {
  if (!existsSync(TEMPLATES_DIR)) {
    await mkdir(TEMPLATES_DIR, { recursive: true });
  }
}

// GET /api/swarm/templates — list all templates
export async function GET(): Promise<NextResponse> {
  try {
    await ensureDir();
    const files = await readdir(TEMPLATES_DIR);
    const templates: RunTemplate[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await readFile(path.join(TEMPLATES_DIR, f), 'utf8');
        const t = JSON.parse(raw) as RunTemplate;
        templates.push(t);
      } catch {
        // Skip malformed files
      }
    }
    templates.sort((a, b) => b.createdAt - a.createdAt); // newest first
    return NextResponse.json(templates);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/swarm/templates — save or overwrite a template
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await ensureDir();
    const body = (await req.json()) as RunTemplate & { name: string };
    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    const safeName = body.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(TEMPLATES_DIR, `${safeName}.json`);
    const template: RunTemplate = {
      name: safeName,
      pattern: body.pattern ?? 'blackboard',
      directive: body.directive ?? '',
      teamCounts: body.teamCounts ?? {},
      unbounded: body.unbounded ?? true,
      costCap: body.costCap ?? 5,
      minutesCap: body.minutesCap ?? 15,
      branchStrategy: body.branchStrategy ?? 'push-new-branch',
      persistentSweepMinutes: body.persistentSweepMinutes ?? 5,
      enableSynthesisCritic: body.enableSynthesisCritic ?? false,
      startMode: body.startMode ?? 'dry-run',
      createdAt: Date.now(),
    };
    await writeFile(filePath, JSON.stringify(template, null, 2), 'utf8');
    return NextResponse.json(template);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
