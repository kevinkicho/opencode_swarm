import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const dynamic = 'force-static';

const svg = readFileSync(join(process.cwd(), 'app', 'icon.svg'));

export function GET() {
  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
