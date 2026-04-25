import { describe, expect, it } from 'vitest';
import {
  turnTimeoutFor,
  zombieThresholdFor,
  currentRetryCount,
  extractPathTokens,
  pathOverlaps,
  relativizeToWorkspace,
} from '../coordinator';

// Pure-helper tests for the coordinator's internal logic. These are
// the functions whose silent drift would corrupt the dispatch / retry
// / file-collision detection. The full tickCoordinator + waitForSessionIdle
// path requires opencode HTTP infrastructure to test; the pure helpers
// here are the testable seams.

describe('turnTimeoutFor — per-pattern dispatch timeout', () => {
  it('blackboard: 10 minutes', () => {
    expect(turnTimeoutFor('blackboard')).toBe(10 * 60_000);
  });

  it('orchestrator-worker: 10 minutes', () => {
    expect(turnTimeoutFor('orchestrator-worker')).toBe(10 * 60_000);
  });

  it('role-differentiated: 10 minutes', () => {
    expect(turnTimeoutFor('role-differentiated')).toBe(10 * 60_000);
  });

  it('deliberate-execute: 15 minutes (longer for cross-phase work)', () => {
    expect(turnTimeoutFor('deliberate-execute')).toBe(15 * 60_000);
  });

  it('unknown pattern: falls back to default 10 minutes', () => {
    expect(turnTimeoutFor('unknown-pattern')).toBe(10 * 60_000);
    expect(turnTimeoutFor('')).toBe(10 * 60_000);
  });
});

describe('zombieThresholdFor — per-pattern silent-turn threshold', () => {
  it('returns positive ms for every supported pattern', () => {
    for (const p of [
      'blackboard',
      'orchestrator-worker',
      'role-differentiated',
      'deliberate-execute',
      'critic-loop',
      'debate-judge',
      'map-reduce',
      'council',
    ]) {
      const t = zombieThresholdFor(p);
      expect(t).toBeGreaterThan(0);
      // Sanity: thresholds shouldn't be < 1s or > 1h.
      expect(t).toBeGreaterThanOrEqual(1000);
      expect(t).toBeLessThanOrEqual(60 * 60_000);
    }
  });

  it('unknown pattern: falls back to a positive default', () => {
    const t = zombieThresholdFor('unknown-pattern');
    expect(t).toBeGreaterThan(0);
  });
});

describe('currentRetryCount — retry note parser', () => {
  it('returns 0 for null / undefined / empty', () => {
    expect(currentRetryCount(null)).toBe(0);
    expect(currentRetryCount(undefined)).toBe(0);
    expect(currentRetryCount('')).toBe(0);
  });

  it('returns 0 for notes without [retry:N] tag', () => {
    expect(currentRetryCount('plain note text')).toBe(0);
    expect(currentRetryCount('waiting on t_002')).toBe(0);
  });

  it('parses [retry:N] tag at start of note', () => {
    expect(currentRetryCount('[retry:1] turn timed out')).toBe(1);
    expect(currentRetryCount('[retry:5] something failed')).toBe(5);
  });

  it('does NOT parse retry tag in the middle of the note', () => {
    // Tag is anchored at start with ^[retry:N]\s*
    expect(currentRetryCount('hello [retry:3] world')).toBe(0);
  });

  it('multi-digit retry counts work', () => {
    expect(currentRetryCount('[retry:42] something')).toBe(42);
  });
});

describe('extractPathTokens — file-collision detection tokenizer', () => {
  it('extracts file paths with directory prefix', () => {
    const tokens = extractPathTokens('Edit src/foo/bar.ts to add the feature');
    expect(tokens.has('src/foo/bar.ts')).toBe(true);
  });

  it('extracts bare filenames with extension (≥4 chars + extension)', () => {
    const tokens = extractPathTokens('Update server.ts and config.json');
    expect(tokens.has('server.ts')).toBe(true);
    expect(tokens.has('config.json')).toBe(true);
  });

  it('skips short basenames (< 4 chars before extension)', () => {
    // "xy.ts" is 5 chars total but basename is 2 chars — still passes
    // because the regex matches \w{4,}\.<ext>. Let's check.
    const tokens = extractPathTokens('Edit a.ts');
    expect(tokens.has('a.ts')).toBe(false); // 'a' is 1 char, fails \w{4,}
  });

  it('extracts multi-segment directory paths', () => {
    const tokens = extractPathTokens(
      'work in lib/server/blackboard/store.ts and components/run-rail.tsx',
    );
    expect(tokens.has('lib/server/blackboard/store.ts')).toBe(true);
    expect(tokens.has('components/run-rail.tsx')).toBe(true);
  });

  it('does NOT extract backslash-only paths (regex requires forward slashes)', () => {
    // Practical implication: path tags emitted with Windows-native
    // backslashes (e.g. on opencode running natively on Windows) won't
    // surface here. Documented as a known limitation; planner uses
    // [files:a,b] tags with forward-slash paths.
    const tokens = extractPathTokens('Edit src\\foo\\bar.ts');
    expect(tokens.size).toBe(0);
  });

  it('returns empty set when no paths present', () => {
    const tokens = extractPathTokens('do some thinking');
    expect(tokens.size).toBe(0);
  });
});

describe('pathOverlaps — claim-collision check', () => {
  it('returns false for two empty sets', () => {
    expect(pathOverlaps(new Set(), new Set())).toBe(false);
  });

  it('returns false when sets have no shared paths', () => {
    const a = new Set(['src/foo.ts']);
    const b = new Set(['src/bar.ts']);
    expect(pathOverlaps(a, b)).toBe(false);
  });

  it('returns true on exact path match', () => {
    const a = new Set(['src/foo.ts']);
    const b = new Set(['src/foo.ts']);
    expect(pathOverlaps(a, b)).toBe(true);
  });

  it('returns true when one path is an ancestor of the other (b contains a)', () => {
    const a = new Set(['src/foo']);
    const b = new Set(['src/foo/bar.ts']);
    // pathOverlaps treats ancestor-of as overlap (collision risk).
    expect(pathOverlaps(a, b)).toBe(true);
  });

  it('returns true when one path is an ancestor of the other (a contains b)', () => {
    const a = new Set(['src/foo/bar.ts']);
    const b = new Set(['src/foo']);
    expect(pathOverlaps(a, b)).toBe(true);
  });

  it('does NOT match prefix substrings (src/foo vs src/foobar)', () => {
    const a = new Set(['src/foo']);
    const b = new Set(['src/foobar.ts']);
    // The implementation requires '/' boundary — 'foo' doesn't ancestor 'foobar.ts'.
    expect(pathOverlaps(a, b)).toBe(false);
  });
});

describe('relativizeToWorkspace — path normalization', () => {
  it('returns relative path when workspace prefixes p', () => {
    const out = relativizeToWorkspace('/work/repo', '/work/repo/src/foo.ts');
    expect(out).toBe('src/foo.ts');
  });

  it('normalizes backslashes to forward slashes', () => {
    const out = relativizeToWorkspace('C:/Users/x', 'C:\\Users\\x\\src\\foo.ts');
    // Result should be forward-slash normalized.
    expect(out).not.toContain('\\');
  });

  it('returns the original path when not under the workspace', () => {
    const out = relativizeToWorkspace('/work/repo', '/elsewhere/file.ts');
    // Falls back to the original p (slash-normalized).
    expect(out).toBe('/elsewhere/file.ts');
  });

  it('handles workspace-root file', () => {
    const out = relativizeToWorkspace('/work/repo', '/work/repo/README.md');
    expect(out).toBe('README.md');
  });
});
