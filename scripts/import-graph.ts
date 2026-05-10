#!/usr/bin/env npx tsx
//
// Import graph analyzer — computes dependency metrics for UML class diagram.
// Finds: most-imported modules, coupling hotspots, import density.
//
// Run: npx tsx scripts/import-graph.ts

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const ROOT = resolve(__dirname, '..');
const SERVER_DIR = join(ROOT, 'lib', 'server');

interface ImportEdge {
  from: string;
  to: string;
}

function walkDir(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry.startsWith('.') || entry === 'node_modules' || entry === '__tests__') continue;
    const s = statSync(full);
    if (s.isDirectory()) { walkDir(full, files); }
    else if (entry.endsWith('.ts')) { files.push(full); }
  }
}

function parseImports(filePath: string): ImportEdge[] {
  try {
    const content = readFileSync(filePath, 'utf8');
    const edges: ImportEdge[] = [];
    const importRe = /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(content)) !== null) {
      const target = m[1];
      if (target.startsWith('node:') || target === 'server-only') continue;
      edges.push({
        from: relative(ROOT, filePath),
        to: target,
      });
    }
    return edges;
  } catch { return []; }
}

function main(): void {
  const files: string[] = [];
  walkDir(SERVER_DIR, files);

  const allEdges: ImportEdge[] = [];
  for (const f of files) {
    allEdges.push(...parseImports(join(ROOT, f)));
  }

  // Fan-out per file
  const fanout = new Map<string, number>();
  // In-degree count
  const indegree = new Map<string, number>();
  // Who imports who
  const importedBy = new Map<string, Set<string>>();

  for (const edge of allEdges) {
    fanout.set(edge.from, (fanout.get(edge.from) ?? 0) + 1);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    if (!importedBy.has(edge.to)) importedBy.set(edge.to, new Set());
    importedBy.get(edge.to)!.add(edge.from);
  }

  console.log('# Import Graph Analysis — UML Class Diagram Input\n');
  console.log(`  Files analyzed: ${files.length}`);
  console.log(`  Total imports: ${allEdges.length}`);
  console.log(`  Unique import targets: ${indegree.size}\n`);

  // Coupling hotspots: modules imported by 3+ files
  const hotspots = [...importedBy.entries()]
    .filter(([, s]) => s.size >= 3)
    .sort(([, a], [, b]) => b.size - a.size);

  console.log('## Coupling Hotspots (Imported by 3+ Files)\n');
  for (const [mod, importers] of hotspots.slice(0, 10)) {
    console.log(`### ${mod} (${importers.size} importers)`);
    for (const imp of [...importers].sort().slice(0, 5)) {
      console.log(`  - ${imp}`);
    }
    if (importers.size > 5) console.log(`  ... and ${importers.size - 5} more`);
    console.log();
  }

  // Files with highest fan-out
  console.log('## High Fan-Out Files (Most Dependencies)\n');
  const topOut = [...fanout.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6);
  for (const [file, count] of topOut) {
    console.log(`  ${file}: ${count} imports`);
  }
}

main();
