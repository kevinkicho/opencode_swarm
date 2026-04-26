#!/usr/bin/env node
// Function-level call-graph analyzer for the codebase.
// Walks lib/, app/, components/ — extracts function definitions per file,
// then for each function counts incoming call sites across the codebase.
// Surfaces the structural shape: hubs (high fan-in), orphans (zero
// callers, candidates for dead code), cross-module duplicates, cycles.
//
// Regex-based — not a real parser. Misses dynamic dispatch, ignores
// scoping (treats every name as global), conflates same-name funcs in
// different files. Good enough for "where do the hot paths cluster?"
// gut-check; not for refactor-rename safety.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const ROOTS = ['lib', 'app', 'components'];
const EXCLUDE = /node_modules|__tests__|\.test\.|\.spec\./;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (EXCLUDE.test(p)) continue;
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));

// Per-file: list of function names defined.
// Per name: list of files that define it (cross-file dupes), list of files that call it.
const defs = new Map(); // name -> [files]
const calls = new Map(); // name -> [files]
const fileFns = new Map(); // file -> [names]
const fileLines = new Map(); // file -> line count

const FN_DEF_RES = [
  /^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[\(<]/gm,
  /^(?:export\s+)?const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[:=]\s*(?:async\s+)?(?:\([^)]*\)|<[^>]+>)\s*=>/gm,
];

const CALL_RE = /\b([a-zA-Z_$][a-zA-Z0-9_$]{2,})\s*\(/g;
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'return', 'function', 'async',
  'await', 'typeof', 'new', 'throw', 'catch', 'try', 'set', 'get',
  'console', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Promise', 'Map', 'Set', 'Date', 'JSON', 'Math', 'Error',
  'parseInt', 'parseFloat', 'String', 'isNaN', 'undefined', 'null',
  'Symbol', 'forEach', 'map', 'filter', 'reduce', 'find', 'some',
  'every', 'push', 'pop', 'shift', 'unshift', 'splice', 'slice',
  'concat', 'join', 'split', 'trim', 'toLowerCase', 'toUpperCase',
  'replace', 'match', 'test', 'exec', 'startsWith', 'endsWith',
  'includes', 'indexOf', 'charAt', 'substring', 'substr', 'fill',
  'has', 'add', 'delete', 'clear', 'entries', 'keys', 'values', 'size',
  'length', 'fromEntries', 'fromCharCode', 'getTime', 'now',
  'createElement', 'useState', 'useEffect', 'useMemo', 'useCallback',
  'useRef', 'useContext', 'useReducer', 'useLayoutEffect', 'useId',
  'await', 'String', 'Boolean', 'Number',
]);

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(ROOT, f);
  fileLines.set(rel, src.split('\n').length);
  const localDefs = [];
  for (const re of FN_DEF_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const name = m[1];
      localDefs.push(name);
      if (!defs.has(name)) defs.set(name, []);
      defs.get(name).push(rel);
    }
  }
  fileFns.set(rel, localDefs);
}

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(ROOT, f);
  // Strip strings + comments crudely so we don't treat literals as calls.
  const cleaned = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''")
    .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
    .replace(/`[^`\\]*(?:\\.[^`\\]*)*`/g, '``');
  CALL_RE.lastIndex = 0;
  const seen = new Set();
  let m;
  while ((m = CALL_RE.exec(cleaned))) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    if (!defs.has(name)) continue; // only count names defined somewhere
    const key = `${name}::${rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!calls.has(name)) calls.set(name, []);
    calls.get(name).push(rel);
  }
}

// Synthesize report
const lines = [];

lines.push('# CALL_GRAPH.md');
lines.push('');
lines.push(`Generated 2026-04-26. Files scanned: ${files.length}. Function defs: ${defs.size}.`);
lines.push('');

// 1. Hubs — functions with high fan-in
const hubs = [...defs.entries()]
  .map(([name, defFiles]) => {
    const callerFiles = (calls.get(name) ?? []).filter((f) => !defFiles.includes(f));
    return { name, defFiles, callerCount: callerFiles.length };
  })
  .filter((h) => h.callerCount >= 8)
  .sort((a, b) => b.callerCount - a.callerCount);

lines.push('## High-fan-in hubs (≥8 caller files) — break these and many cascade');
lines.push('');
lines.push('| Function | Defined in | Callers |');
lines.push('|---|---|---|');
for (const h of hubs.slice(0, 30)) {
  const def = h.defFiles.length === 1 ? h.defFiles[0] : `${h.defFiles.length} files`;
  lines.push(`| \`${h.name}\` | ${def} | ${h.callerCount} |`);
}
lines.push('');

// 2. Cross-module duplicates
const dupes = [...defs.entries()]
  .filter(([_, files]) => new Set(files).size > 1)
  .sort((a, b) => b[1].length - a[1].length);

lines.push('## Cross-module duplicates (same name, multiple files)');
lines.push('');
lines.push('| Name | Defined in N files |');
lines.push('|---|---|');
for (const [name, defFiles] of dupes.slice(0, 30)) {
  const unique = [...new Set(defFiles)];
  if (unique.length < 2) continue;
  lines.push(`| \`${name}\` | ${unique.length} (${unique.slice(0, 4).join(', ')}${unique.length > 4 ? '…' : ''}) |`);
}
lines.push('');

// 3. Orphans — defined but never called outside their own file
const orphans = [...defs.entries()]
  .map(([name, defFiles]) => {
    const callerFiles = (calls.get(name) ?? []).filter((f) => !defFiles.includes(f));
    return { name, defFiles, callerCount: callerFiles.length };
  })
  .filter((o) => o.callerCount === 0)
  .filter((o) => !KEYWORDS.has(o.name));

lines.push(`## Possibly unused (no caller outside the defining file): ${orphans.length}`);
lines.push('');
lines.push('Note: regex-based — misses dynamic dispatch, default exports, JSX consumption (`<Foo>`),');
lines.push('and things called via re-exports. Treat as candidates for review, not certainties.');
lines.push('');
lines.push('Top 30 by file (deepest dead-code suspects):');
lines.push('');
const orphansByFile = new Map();
for (const o of orphans) {
  const f = o.defFiles[0];
  if (!orphansByFile.has(f)) orphansByFile.set(f, []);
  orphansByFile.get(f).push(o.name);
}
const orphanFiles = [...orphansByFile.entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 30);
for (const [f, names] of orphanFiles) {
  lines.push(`- \`${f}\` (${names.length}): ${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''}`);
}
lines.push('');

// 4. Per-file complexity: defs + lines
lines.push('## Per-file complexity (top 20 by function count)');
lines.push('');
lines.push('| File | Lines | Functions defined |');
lines.push('|---|---|---|');
const byComplexity = [...fileFns.entries()]
  .map(([f, names]) => ({ f, fnCount: names.length, lines: fileLines.get(f) ?? 0 }))
  .sort((a, b) => b.fnCount - a.fnCount);
for (const e of byComplexity.slice(0, 20)) {
  lines.push(`| ${e.f} | ${e.lines} | ${e.fnCount} |`);
}
lines.push('');

// 5. Files that import from many other files (high fan-out at file level)
// Count `from '...';` import statements per file
lines.push('## Files importing from many places (high static fan-out)');
lines.push('');
const fanout = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const importLines = (src.match(/^import\s+/gm) ?? []).length;
  fanout.push({ f: relative(ROOT, f), importLines });
}
fanout.sort((a, b) => b.importLines - a.importLines);
lines.push('| File | Import statements |');
lines.push('|---|---|');
for (const e of fanout.slice(0, 15)) {
  lines.push(`| ${e.f} | ${e.importLines} |`);
}
lines.push('');

// 6. Detect probable import cycles (file A imports B, file B imports A — symmetric edges)
// Build edges: file -> set of files imported from
const edges = new Map();
const importPathRe = /from\s+['"]([^'"]+)['"]/g;
function resolveImport(fromFile, spec) {
  if (spec.startsWith('@/')) {
    return spec.slice(2); // '@/lib/foo' -> 'lib/foo'
  }
  if (spec.startsWith('.')) {
    const baseDir = fromFile.split('/').slice(0, -1).join('/');
    let resolved = baseDir + '/' + spec;
    // Normalize ./ ../
    const parts = resolved.split('/');
    const norm = [];
    for (const p of parts) {
      if (p === '.' || p === '') continue;
      if (p === '..') norm.pop();
      else norm.push(p);
    }
    return norm.join('/');
  }
  return null;
}
for (const f of files) {
  const rel = relative(ROOT, f);
  const src = readFileSync(f, 'utf8');
  const out = new Set();
  let m;
  importPathRe.lastIndex = 0;
  while ((m = importPathRe.exec(src))) {
    const spec = m[1];
    const target = resolveImport(rel, spec);
    if (!target) continue;
    // Try .ts and .tsx and /index extensions to find a real file
    const candidates = [
      `${target}.ts`,
      `${target}.tsx`,
      `${target}/index.ts`,
      `${target}/index.tsx`,
    ];
    for (const c of candidates) {
      if (fileLines.has(c)) {
        out.add(c);
        break;
      }
    }
  }
  edges.set(rel, out);
}
const cycles = [];
for (const [a, targets] of edges) {
  for (const b of targets) {
    const reverse = edges.get(b);
    if (reverse && reverse.has(a) && a < b) {
      cycles.push([a, b]);
    }
  }
}
lines.push(`## Direct import cycles (A imports B AND B imports A): ${cycles.length}`);
lines.push('');
if (cycles.length > 0) {
  for (const [a, b] of cycles.slice(0, 20)) {
    lines.push(`- \`${a}\` ⟷ \`${b}\``);
  }
}
lines.push('');

console.log(lines.join('\n'));
