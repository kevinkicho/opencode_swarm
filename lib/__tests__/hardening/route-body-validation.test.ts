//
// Four routes accept POST bodies via `(await req.json()) as TheBody` with
// no field-level typeof checks. After R6 ships, each should call a
// `parseFooBody(raw)` helper that returns `{ ok: true; body } | { ok: false; error }`.
//
// This lint detects the unsafe pattern: `await req.json() as <Type>` directly
// followed by field access without a parse helper.
//
// Status: target — fails today on the 4 known offenders.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const API_DIR = join(REPO_ROOT, 'app', 'api');

// Routes whose request body is intentionally trusted (e.g., internal-only
// endpoints behind feature flags). Empty for now; every entry should be
// commented.
const ALLOWLIST = new Set<string>([]);

interface Violation {
  file: string;
  line: number;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

function findUnsafeBodyCasts(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // `await req.json()` (or `(await req.json())`) directly cast to a
    // typed shape via `as Foo` — without a subsequent parse-helper —
    // is the smell. Casts to `unknown` are fine; they force callers to
    // validate before field access.
    const line = lines[i];
    const castMatch = line.match(/await\s+req\.json\(\)\s*\)?\s*as\s+(\w+)/);
    if (!castMatch) continue;
    const castType = castMatch[1];
    if (castType === 'unknown') continue;

    // Look ahead 25 lines: if a `parse*Body(`, `validate*(`, or
    // `if (... === 'string')` typeof guard appears, treat as
    // already-validated and skip.
    const window = lines.slice(i, Math.min(i + 25, lines.length)).join('\n');
    if (/parse\w*Body\s*\(|validate\w+\s*\(|typeof\s+\w+\s*===\s*['"]/.test(window)) continue;

    out.push({ file: file.replace(REPO_ROOT + '/', ''), line: i + 1 });
  }
  return out;
}

describe('hardening · R6 · request body validation', () => {
  it('every POST handler validates body shape before field access', () => {
    const violations: Violation[] = [];
    for (const f of walk(API_DIR)) {
      const rel = f.replace(REPO_ROOT + '/', '');
      if (ALLOWLIST.has(rel)) continue;
      const src = readFileSync(f, 'utf8');
      violations.push(...findUnsafeBodyCasts(f, src));
    }
    if (violations.length > 0) {
      const msg = [
        `R6 violations: ${violations.length} route(s) cast req.json() to a typed shape without runtime validation.`,
        `Add a parseFooBody(raw): { ok: true; body } | { ok: false; error } helper.`,
 `See `,
        '',
        ...violations.map((v) => `  ${v.file}:${v.line}`),
      ].join('\n');
      throw new Error(msg);
    }
    expect(violations).toHaveLength(0);
  });
});
