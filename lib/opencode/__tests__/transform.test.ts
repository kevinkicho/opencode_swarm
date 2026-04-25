import { describe, expect, it } from 'vitest';
import {
  parseUnifiedDiff,
  parseSessionDiffs,
  filterDiffsForTurn,
} from '../transform';

// Diff parsing is on the cards-view + commit-history hot path. Drift
// here means wrong line numbers in the inspector, +/- counts wrong on
// the heat rail, broken navigation in the diff viewer. The format is
// a strict subset of unified diff — keep it locked.

describe('parseUnifiedDiff — single hunk', () => {
  it('parses a simple add-only hunk', () => {
    const patch = [
      '@@ -1,2 +1,3 @@',
      ' line one',
      ' line two',
      '+line three',
    ].join('\n');
    const out = parseUnifiedDiff('foo.ts', patch);
    expect(out.file).toBe('foo.ts');
    expect(out.additions).toBe(1);
    expect(out.deletions).toBe(0);
    expect(out.hunks).toHaveLength(1);
    expect(out.hunks[0].lines).toHaveLength(3);
    expect(out.hunks[0].lines[2]).toEqual({
      type: 'add',
      num: 3,
      text: 'line three',
    });
  });

  it('parses a simple delete-only hunk', () => {
    const patch = [
      '@@ -1,3 +1,2 @@',
      ' kept',
      '-removed',
      ' kept2',
    ].join('\n');
    const out = parseUnifiedDiff('foo.ts', patch);
    expect(out.additions).toBe(0);
    expect(out.deletions).toBe(1);
    expect(out.hunks[0].lines[1]).toEqual({
      type: 'remove',
      num: 2,
      text: 'removed',
    });
  });

  it('parses mixed add+delete hunk', () => {
    const patch = [
      '@@ -10,3 +10,3 @@',
      ' before',
      '-old line',
      '+new line',
      ' after',
    ].join('\n');
    const out = parseUnifiedDiff('bar.ts', patch);
    expect(out.additions).toBe(1);
    expect(out.deletions).toBe(1);
  });

  it('counts line numbers correctly across context+add+remove', () => {
    const patch = [
      '@@ -5,4 +5,4 @@',
      ' a',
      '-b',
      '+B',
      ' c',
    ].join('\n');
    const out = parseUnifiedDiff('x.ts', patch);
    const lines = out.hunks[0].lines;
    expect(lines[0]).toEqual({ type: 'context', num: 5, text: 'a' });
    expect(lines[1]).toEqual({ type: 'remove', num: 6, text: 'b' });
    // After a remove (oldLine bumped 5→6) and an add (newLine bumped 5→6),
    // the next add should land at newLine=6.
    expect(lines[2]).toEqual({ type: 'add', num: 6, text: 'B' });
  });

  it('skips file-header lines (---/+++/Index:/===)', () => {
    const patch = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,1 +1,2 @@',
      ' line',
      '+added',
    ].join('\n');
    const out = parseUnifiedDiff('foo.ts', patch);
    expect(out.additions).toBe(1);
    expect(out.hunks[0].lines).toHaveLength(2); // file headers excluded
  });

  it('skips "\\ No newline at end of file" markers', () => {
    const patch = [
      '@@ -1,1 +1,2 @@',
      ' line',
      '+added',
      '\\ No newline at end of file',
    ].join('\n');
    const out = parseUnifiedDiff('foo.ts', patch);
    expect(out.additions).toBe(1);
    expect(out.hunks[0].lines).toHaveLength(2);
  });
});

describe('parseUnifiedDiff — multi-hunk', () => {
  it('parses two hunks in one patch', () => {
    const patch = [
      '@@ -1,1 +1,2 @@',
      ' a',
      '+aa',
      '@@ -10,1 +11,2 @@',
      ' b',
      '+bb',
    ].join('\n');
    const out = parseUnifiedDiff('foo.ts', patch);
    expect(out.hunks).toHaveLength(2);
    expect(out.additions).toBe(2);
    expect(out.deletions).toBe(0);
  });

  it('hunk line numbers reset to each hunk header', () => {
    const patch = [
      '@@ -1,1 +1,2 @@',
      ' a',
      '+aa',
      '@@ -100,1 +101,2 @@',
      ' z',
      '+zz',
    ].join('\n');
    const out = parseUnifiedDiff('foo.ts', patch);
    expect(out.hunks[1].lines[0].num).toBe(101); // hunk 2 starts fresh at 101
  });
});

describe('parseUnifiedDiff — edge cases', () => {
  it('returns empty hunks for empty patch', () => {
    const out = parseUnifiedDiff('foo.ts', '');
    expect(out.hunks).toEqual([]);
    expect(out.additions).toBe(0);
    expect(out.deletions).toBe(0);
  });

  it('ignores lines before any @@ header', () => {
    const patch = [
      'random preamble',
      'should be ignored',
      '@@ -1,1 +1,2 @@',
      ' a',
      '+aa',
    ].join('\n');
    const out = parseUnifiedDiff('foo.ts', patch);
    expect(out.additions).toBe(1);
    expect(out.hunks[0].lines).toHaveLength(2);
  });

  it('handles \\r\\n line endings', () => {
    const patch = '@@ -1,1 +1,2 @@\r\n a\r\n+aa\r\n';
    const out = parseUnifiedDiff('foo.ts', patch);
    expect(out.additions).toBe(1);
  });

  it('skips malformed @@ headers gracefully', () => {
    const patch = [
      '@@ malformed @@',
      '+this never gets attached to a hunk',
    ].join('\n');
    const out = parseUnifiedDiff('foo.ts', patch);
    // Malformed hunk header → no current hunk → following lines orphaned/dropped.
    expect(out.hunks).toEqual([]);
    expect(out.additions).toBe(0);
  });
});

describe('parseSessionDiffs', () => {
  it('returns array of parsed diffs', () => {
    const out = parseSessionDiffs([
      { file: 'a.ts', patch: '@@ -1,1 +1,2 @@\n a\n+aa' },
      { file: 'b.ts', patch: '@@ -1,1 +1,2 @@\n b\n+bb' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].file).toBe('a.ts');
    expect(out[1].file).toBe('b.ts');
    expect(out[0].additions).toBe(1);
  });

  it('returns empty array on empty input', () => {
    expect(parseSessionDiffs([])).toEqual([]);
  });
});

describe('filterDiffsForTurn', () => {
  const allDiffs = [
    { file: 'a.ts', patch: '', additions: 1, deletions: 0, hunks: [] },
    { file: 'b.ts', patch: '', additions: 2, deletions: 0, hunks: [] },
    { file: 'c.ts', patch: '', additions: 3, deletions: 0, hunks: [] },
  ];

  it('returns empty array when turnFiles is empty', () => {
    expect(filterDiffsForTurn(allDiffs, [])).toEqual([]);
  });

  it('filters to only the named files', () => {
    const out = filterDiffsForTurn(allDiffs, ['a.ts', 'c.ts']);
    expect(out.map((d) => d.file)).toEqual(['a.ts', 'c.ts']);
  });

  it('returns empty when no overlap', () => {
    expect(filterDiffsForTurn(allDiffs, ['x.ts'])).toEqual([]);
  });
});
