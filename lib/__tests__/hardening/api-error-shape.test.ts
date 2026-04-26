// HARDENING_PLAN.md#R5 — API error response shape conformance.
//
// Asserts that every `Response.json({ error: ... }, { status: ... })` site
// in app/api/ uses the canonical { error: string; detail?: string; hint?: string }
// shape. Drift to legacy shapes (`{ error, message }`) is caught here.
//
// Status: target (fails today). Will flip to passing once R5 is shipped.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const API_DIR = join(REPO_ROOT, 'app', 'api');

// Field names that may appear in an error response. `error` and `detail`
// are canonical; `message` is the legacy shape we're migrating away from.
// `hint` is acceptable when paired with a recoverable user action; we
// allow it but expect it to fold into `detail` over time.
const CANONICAL_FIELDS = new Set(['error', 'detail', 'hint']);
const LEGACY_FIELDS = new Set(['message']);
// Discriminator-style fields (intentionally allowed because they encode
// which sub-shape the response is). Add new ones here when justified.
const DISCRIMINATOR_FIELDS = new Set([
  'currentStatus', // board CAS conflict signal
  'swarmRunID', 'costTotal', 'costCap', // CostCapError serialized form
]);

interface Violation {
  file: string;
  line: number;
  excerpt: string;
  reason: string;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

function findResponseJsonErrorSites(file: string, src: string): Violation[] {
  const violations: Violation[] = [];
  const lines = src.split('\n');

  // Collect Response.json({ ... }) calls that contain an `error:` key.
  // We tolerate template-literal-spanning by looking at a 6-line window.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('Response.json(')) continue;
    const window = lines.slice(i, Math.min(i + 8, lines.length)).join('\n');
    if (!window.includes('error:')) continue;

    // Extract the object literal — between the first `{` and matching `}`
    const startIdx = window.indexOf('{');
    if (startIdx < 0) continue;
    let depth = 0;
    let endIdx = -1;
    for (let j = startIdx; j < window.length; j++) {
      const c = window[j];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { endIdx = j; break; }
      }
    }
    if (endIdx < 0) continue;
    const body = window.slice(startIdx + 1, endIdx);

    // Pull out the keys at the top level — naive but enough for the
    // small object shapes we use. Skip nested objects.
    const keys = extractTopLevelKeys(body);
    for (const k of keys) {
      if (CANONICAL_FIELDS.has(k)) continue;
      if (DISCRIMINATOR_FIELDS.has(k)) continue;
      if (LEGACY_FIELDS.has(k)) {
        violations.push({
          file: file.replace(REPO_ROOT + '/', ''),
          line: i + 1,
          excerpt: line.trim(),
          reason: `legacy field '${k}' — fold into 'detail' (R5)`,
        });
      } else {
        violations.push({
          file: file.replace(REPO_ROOT + '/', ''),
          line: i + 1,
          excerpt: line.trim(),
          reason: `unrecognized error-response field '${k}' — add to CANONICAL_FIELDS or DISCRIMINATOR_FIELDS with justification, or rename`,
        });
      }
    }
  }
  return violations;
}

function extractTopLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let buf = '';
  for (const c of body) {
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) { collectKey(buf, keys); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) collectKey(buf, keys);
  return keys;
}

function collectKey(segment: string, keys: string[]): void {
  // Match `keyName:` or `'keyName':` at the start of a segment.
  const m = segment.trim().match(/^['"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['"]?\s*:/);
  if (m) keys.push(m[1]);
}

describe('hardening · R5 · API error response shape', () => {
  it('every Response.json error site uses { error, detail?, hint? } shape', () => {
    const files = [...walk(API_DIR)];
    const allViolations: Violation[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      allViolations.push(...findResponseJsonErrorSites(f, src));
    }

    if (allViolations.length > 0) {
      // Helpful failure message — list every violation so the operator
      // can fix them in one pass.
      const msg = [
        `R5 violations: ${allViolations.length} error responses use a non-canonical shape.`,
        `Canonical: { error: string; detail?: string; hint?: string }`,
        `See HARDENING_PLAN.md#R5.`,
        '',
        ...allViolations.map((v) => `  ${v.file}:${v.line} · ${v.reason}`),
      ].join('\n');
      throw new Error(msg);
    }
    expect(allViolations).toHaveLength(0);
  });
});
