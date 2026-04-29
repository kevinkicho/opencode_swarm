//
// Empty `catch {}` and `catch (e) {}` blocks silence errors. The audit
// found 3 trivial ones in stream-cleanup paths plus 1 real bug-magnet
// (auto-ticker/state.ts:82). After R3 ships, the bug-magnet gets a log
// line; the trivial three remain (stream-close exceptions are noise).
//
// This test allowlists the known-safe sites and fails on any new ones.
// New empty catches must either be added to the allowlist (with a
// comment explaining why) or upgraded to `catch (err) { console.warn(...) }`.
//
// Status: target initially. After the auto-ticker fix, allowlist is
// updated to ONLY the trivial stream-close sites. Future regressions
// are then caught here.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCAN_DIRS = ['lib', 'app', 'components'].map((d) => join(REPO_ROOT, d));

// file:line of empty-catch sites that are intentionally empty. Each
// entry should have a one-line comment explaining why. New empty
// catches not on this list will fail the test.
//
// Format: "<repo-relative-path>:<line>"
const ALLOWLIST = new Set<string>([
  // Stream cleanup — controller.close()/reader.releaseLock() can throw
  // if the stream is already closed; catching is the canonical pattern.
  // board/events route line shifted from 80 → 89 in 2026-04-26 W4.7
  // ticker+strategy SSE fold (added a switch for the new frame types).
  'app/api/swarm/run/[swarmRunID]/board/events/route.ts:89',
  'app/api/swarm/run/[swarmRunID]/events/route.ts:92',
  'app/api/swarm/run/[swarmRunID]/events/route.ts:238',
]);

interface EmptyCatchSite {
  file: string;
  line: number;
}

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
      yield* walkTs(p);
    } else if ((p.endsWith('.ts') || p.endsWith('.tsx')) && !p.includes('.test.') && !p.includes('.spec.')) {
      yield p;
    }
  }
}

function relPath(file: string): string {
  // Normalize to forward-slash repo-relative so Windows + Linux produce
  // the same string for ALLOWLIST lookups.
  return file
    .replace(REPO_ROOT, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
}

function findEmptyCatches(file: string, src: string): EmptyCatchSite[] {
  const out: EmptyCatchSite[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(line)) {
      out.push({ file: relPath(file), line: i + 1 });
    }
  }
  return out;
}

describe('hardening · R3 · empty-catch allowlist', () => {
  it('no new empty catch blocks outside the allowlist', () => {
    const allSites: EmptyCatchSite[] = [];
    for (const root of SCAN_DIRS) {
      for (const f of walkTs(root)) {
        const src = readFileSync(f, 'utf8');
        allSites.push(...findEmptyCatches(f, src));
      }
    }
    const unexpected = allSites.filter((s) => !ALLOWLIST.has(`${s.file}:${s.line}`));
    if (unexpected.length > 0) {
      const msg = [
        `R3 violation: ${unexpected.length} empty catch block(s) outside the allowlist.`,
        `Either add a `,
        `(a) console.warn(...) inside the catch (preferred — preserves forensic trail), OR`,
        `(b) add the file:line to ALLOWLIST in this test with a comment explaining why.`,
 `See `,
        '',
        ...unexpected.map((s) => `  ${s.file}:${s.line}`),
      ].join('\n');
      throw new Error(msg);
    }
    expect(unexpected).toHaveLength(0);
  });

  it('the allowlist itself is consistent — every entry still exists', () => {
    const stale: string[] = [];
    for (const entry of ALLOWLIST) {
      const [path, lineStr] = entry.split(':');
      const fullPath = join(REPO_ROOT, path);
      try {
        const src = readFileSync(fullPath, 'utf8');
        const line = Number(lineStr);
        const content = src.split('\n')[line - 1] ?? '';
        if (!/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(content)) {
          stale.push(`${entry} — line no longer matches an empty catch`);
        }
      } catch {
        stale.push(`${entry} — file not readable`);
      }
    }
    if (stale.length > 0) {
      const msg = [
        `R3 allowlist drift: ${stale.length} entry(ies) no longer match.`,
        `Re-grep for empty catches and update the allowlist.`,
        '',
        ...stale.map((s) => `  ${s}`),
      ].join('\n');
      throw new Error(msg);
    }
    expect(stale).toHaveLength(0);
  });
});
