// HARDENING_PLAN.md#C17 — direct import cycles.
//
// Two known cycles per the call-graph analysis:
//   - lib/server/blackboard/planner.ts ⟷ lib/server/degraded-completion.ts
//   - components/heat-rail.tsx ⟷ components/heat-rail/sub-components.tsx
//
// After C17 ships, both should be broken via shared-types extraction.
// This test re-runs the cycle detection and fails if cycles are present.
//
// Status: target (fails today on the 2 known cycles).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCAN_DIRS = ['lib', 'app', 'components'].map((d) => join(REPO_ROOT, d));

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue;
      yield* walk(p);
    } else if ((p.endsWith('.ts') || p.endsWith('.tsx')) && !p.includes('.test.') && !p.includes('.spec.')) {
      yield p;
    }
  }
}

function resolveImport(fromFile: string, spec: string, allFiles: Set<string>): string | null {
  let target: string;
  if (spec.startsWith('@/')) {
    target = spec.slice(2);
  } else if (spec.startsWith('.')) {
    const baseDir = fromFile.split('/').slice(0, -1).join('/');
    const parts = (baseDir + '/' + spec).split('/');
    const norm: string[] = [];
    for (const p of parts) {
      if (p === '.' || p === '') continue;
      if (p === '..') norm.pop();
      else norm.push(p);
    }
    target = norm.join('/');
  } else {
    return null;
  }
  // Try .ts, .tsx, /index.ts, /index.tsx
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const candidate = target + ext;
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

// Strip line + block comments + string-literal contents BEFORE matching
// `from '...'`. Without this the detector trips on prose inside comments
// (e.g., `// imported it back from '../foo'`) and reports phantom cycles.
function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    // Empty out single/double/template string literals so a `from '...'`
    // literal inside an unrelated string can't trip the regex.
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

function buildEdges(): Map<string, Set<string>> {
  const allFiles = new Set<string>();
  for (const root of SCAN_DIRS) {
    for (const f of walk(root)) {
      allFiles.add(relative(REPO_ROOT, f));
    }
  }
  const edges = new Map<string, Set<string>>();
  // Detect `import ... from '...'` and bare `import '...'` directives.
  // Using two regexes is simpler than one mega-pattern and the
  // strip-comments pass means string-literal noise is already neutralized.
  const importFromRe = /\bfrom\s*['"]([^'"]+)['"]/g;
  const bareImportRe = /\bimport\s*['"]([^'"]+)['"]/g;
  for (const rel of allFiles) {
    const rawSrc = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const src = stripCommentsAndStrings(rawSrc);
    const out = new Set<string>();
    for (const re of [importFromRe, bareImportRe]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const target = resolveImport(rel, m[1], allFiles);
        if (target) out.add(target);
      }
    }
    edges.set(rel, out);
  }
  return edges;
}

describe('hardening · C17 · direct import cycles', () => {
  it('no two files import each other', () => {
    const edges = buildEdges();
    const cycles: [string, string][] = [];
    for (const [a, targets] of edges) {
      for (const b of targets) {
        if (a >= b) continue; // dedupe pair
        const reverse = edges.get(b);
        if (reverse && reverse.has(a)) {
          cycles.push([a, b]);
        }
      }
    }
    if (cycles.length > 0) {
      const msg = [
        `C17 violations: ${cycles.length} direct import cycle(s).`,
        `Extract shared types to a third file to break each cycle.`,
        `See HARDENING_PLAN.md#C17.`,
        '',
        ...cycles.map(([a, b]) => `  ${a} ⟷ ${b}`),
      ].join('\n');
      throw new Error(msg);
    }
    expect(cycles).toHaveLength(0);
  });
});
