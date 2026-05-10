import { type NextRequest, NextResponse } from 'next/server';
import { unlink } from 'node:fs/promises';
import path from 'node:path';

const TEMPLATES_DIR = path.resolve(process.cwd(), '.opencode_swarm', 'templates');

// DELETE /api/swarm/templates/:name
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  try {
    const { name } = await params;
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(TEMPLATES_DIR, `${safeName}.json`);
    await unlink(filePath);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
