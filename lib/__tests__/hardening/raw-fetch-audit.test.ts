// HARDENING_PLAN.md#E2 — raw fetch audit.
//
// Four pages do `fetch('/api/swarm/run')` directly instead of using the
// `useSwarmRuns` TanStack hook. Result: 4 cold-load round trips that
// would dedupe behind a shared queryKey. After E2 ships, only the
// canonical hooks should issue these calls.
//
// Status: target (fails today). Will flip to passing once each page
// is migrated to useSwarmRuns / useQuery.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const APP_DIR = join(REPO_ROOT, 'app');
const COMPONENTS_DIR = join(REPO_ROOT, 'components');

// Endpoints that already have a canonical hook. Match only exact URLs
// (no path-suffix), so `/api/swarm/run/${id}` (specific-run fetch) does
// NOT trip the lint — only the list endpoint `/api/swarm/run` does.
const HOOK_BACKED_ENDPOINTS_EXACT = new Set<string>([
  '/api/swarm/run',          // useSwarmRuns
  '/api/opencode/health',    // useOpencodeHealth
  '/api/opencode/session',   // useLiveSessions / useLiveSession
]);

// Files allowed to fetch directly — typically the hook implementations
// themselves, or one-shot mutations where the hook isn't appropriate.
const FETCH_ALLOWLIST = new Set<string>([
  'lib/opencode/live.ts',
  'lib/blackboard/live.ts',
  'lib/blackboard/strategy.ts',
  // Mutations (POST) are fine without a hook — useMutation is heavyweight
  // for one-shot calls. We only fail on GET fetches.
]);

interface Violation {
  file: string;
  line: number;
  endpoint: string;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue;
      yield* walk(p);
    } else if ((p.endsWith('.tsx') || p.endsWith('.ts')) && !p.includes('.test.')) {
      yield p;
    }
  }
}

function findRawGetFetches(file: string, src: string): Violation[] {
  const violations: Violation[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Look for fetch('...') or fetch(`...`) where the URL matches one of
    // our hook-backed endpoints. We exclude POST/PUT/DELETE — only GETs
    // are candidates for hook migration.
    const match = line.match(/fetch\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (!match) continue;
    const url = match[1];
    // Strip any query string before the exact-match check so fetches
    // like `/api/swarm/run?since=...` still trip if such variants
    // existed (none today, but cheap to be defensive).
    const path = url.split('?')[0];
    if (!HOOK_BACKED_ENDPOINTS_EXACT.has(path)) continue;

    // Look ahead 5 lines for a method: 'POST'/'PUT'/etc.; if none, it's a GET.
    const window = lines.slice(i, Math.min(i + 6, lines.length)).join(' ');
    if (/method:\s*['"](POST|PUT|DELETE|PATCH)['"]/.test(window)) continue;

    violations.push({
      file: file.replace(REPO_ROOT + '/', ''),
      line: i + 1,
      endpoint: url,
    });
  }
  return violations;
}

describe('hardening · E2 · raw fetch audit', () => {
  it('no GET fetch to hook-backed endpoints outside the allowlist', () => {
    const violations: Violation[] = [];
    for (const root of [APP_DIR, COMPONENTS_DIR]) {
      for (const f of walk(root)) {
        const rel = f.replace(REPO_ROOT + '/', '');
        if (FETCH_ALLOWLIST.has(rel)) continue;
        const src = readFileSync(f, 'utf8');
        violations.push(...findRawGetFetches(f, src));
      }
    }
    if (violations.length > 0) {
      const msg = [
        `E2 violations: ${violations.length} raw GET fetch(es) bypass canonical hooks.`,
        `Migrate to useSwarmRuns / useOpencodeHealth / useLiveSessions for cache dedup.`,
        `See HARDENING_PLAN.md#E2.`,
        '',
        ...violations.map((v) => `  ${v.file}:${v.line} → fetch('${v.endpoint}')`),
      ].join('\n');
      throw new Error(msg);
    }
    expect(violations).toHaveLength(0);
  });
});
