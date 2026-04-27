//
// Every file under lib/server/ should declare `import 'server-only';` as
// the first non-comment line. This is the Next.js convention for marking a
// module that must never be bundled into the client. Without it, an
// accidental client import drags fs/child_process/better-sqlite3 into the
// browser bundle and the page crashes at module evaluation.
//
// Status: target (fails today — 0 of 64 server modules have it).
// Will flip to passing once D6 is shipped.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SERVER_DIR = join(REPO_ROOT, 'lib', 'server');

// Files that legitimately don't need 'server-only' — pure type modules
// imported by both server and client. The list should stay tiny; add a
// comment explaining why each entry is here.
const ALLOWLIST = new Set<string>([
  // (intentionally empty — server-side type modules belong in lib/, not
  // lib/server/. If this set grows, audit whether the file should move.)
]);

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      // Skip __tests__ directories and __fixtures__
      if (entry === '__tests__' || entry === '__fixtures__') continue;
      yield* walkTs(p);
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) {
      yield p;
    }
  }
}

function hasServerOnlyImport(src: string): boolean {
  // Look in the first 20 non-blank, non-comment lines. The directive
  // should be near the top; if it's buried, that's also a finding.
  const lines = src.split('\n');
  let nonBoilerplateSeen = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    if (trimmed === "import 'server-only';" || trimmed === 'import "server-only";') {
      return true;
    }
    nonBoilerplateSeen++;
    if (nonBoilerplateSeen > 20) break;
  }
  return false;
}

describe('hardening · D6 · server-only enforcement', () => {
  it('every file under lib/server/ declares `import \'server-only\'`', () => {
    const files = [...walkTs(SERVER_DIR)];
    const missing: string[] = [];
    for (const f of files) {
      const rel = f.replace(REPO_ROOT + '/', '');
      if (ALLOWLIST.has(rel)) continue;
      const src = readFileSync(f, 'utf8');
      if (!hasServerOnlyImport(src)) missing.push(rel);
    }
    if (missing.length > 0) {
      const msg = [
        `D6 violations: ${missing.length} of ${files.length} server modules lack \`import 'server-only';\`.`,
        `Add it as the first non-comment line to prevent accidental client bundling.`,
 `See `,
        '',
        ...missing.slice(0, 30).map((f) => `  ${f}`),
        ...(missing.length > 30 ? [`  ... and ${missing.length - 30} more`] : []),
      ].join('\n');
      throw new Error(msg);
    }
    expect(missing).toHaveLength(0);
  });
});
