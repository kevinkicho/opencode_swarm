#!/usr/bin/env node
// HARDENING_PLAN.md#D6 — add `import 'server-only';` to every file under
// lib/server/ that doesn't already have it. Inserts after the leading
// block-comment header so the file's purpose comment stays at the top
// for grep-readability.
//
// Run once during the D6 work item; safe to re-run (idempotent — skips
// files that already have the directive).

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SERVER_DIR = join(ROOT, 'lib', 'server');
const DIRECTIVE = "import 'server-only';";

function* walkTs(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === '__tests__' || entry === '__fixtures__') continue;
      yield* walkTs(p);
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.spec.ts')) {
      yield p;
    }
  }
}

let added = 0;
let skipped = 0;
for (const f of walkTs(SERVER_DIR)) {
  const src = readFileSync(f, 'utf8');
  if (src.includes("import 'server-only'") || src.includes('import "server-only"')) {
    skipped++;
    continue;
  }
  // Find the end of the leading comment block. Walk lines from the top:
  //   - while we see lines that are blank, // comment, or part of /* */ block,
  //     mark them as header.
  //   - First non-comment, non-blank line is where we insert.
  const lines = src.split('\n');
  let insertAt = 0;
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (inBlock) {
      if (trimmed.endsWith('*/')) inBlock = false;
      continue;
    }
    if (trimmed === '') continue;
    if (trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('/*')) {
      if (!trimmed.endsWith('*/')) inBlock = true;
      continue;
    }
    insertAt = i;
    break;
  }
  // Insert directive + blank line so it visually separates from the
  // first import.
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  const out = [...before, DIRECTIVE, '', ...after].join('\n');
  writeFileSync(f, out, 'utf8');
  added++;
}

console.log(`server-only: added=${added} skipped=${skipped} total=${added + skipped}`);
