// Unit tests for the wire-protocol parsers in lib/server/blackboard/planner.ts.
//
// These regex-based strippers are the contract between the planner's
// todowrite emission and the board's typed columns (requiresVerification,
// preferredRole, expectedFiles, sourceDrafts, isCriterion, roleNote).
// A drift breaks Playwright grounding, role-differentiated routing,
// CAS file-scope, and the deliberate-execute traceability story silently.
//
// Migrated from scripts/_parser_smoke.mjs (which we kept as a runnable
// node script) into the vitest suite so they run on every commit. Same
// 41-case coverage; identical assertions.
//
// First test in the new automated suite — see vitest.config.ts for
// the framework setup. Run via `npm run test`.

import { describe, expect, it } from 'vitest';
import {
  stripVerifyTag,
  stripRoleTag,
  stripFilesTag,
  stripCriterionTag,
  stripFromTag,
  stripRoleNoteTag,
  buildZeroTodoSummary,
  buildAllFilteredSummary,
} from '../planner';

describe('stripVerifyTag', () => {
  it('strips simple [verify] prefix', () => {
    expect(stripVerifyTag('[verify] Dashboard renders')).toEqual({
      content: 'Dashboard renders',
      requiresVerification: true,
    });
  });

  it('handles uppercase [VERIFY]', () => {
    expect(stripVerifyTag('[VERIFY] Dashboard renders')).toEqual({
      content: 'Dashboard renders',
      requiresVerification: true,
    });
  });

  it('handles mixed-case + extra whitespace', () => {
    expect(stripVerifyTag('  [Verify]   Dashboard renders')).toEqual({
      content: 'Dashboard renders',
      requiresVerification: true,
    });
  });

  it('passes through untagged content unchanged', () => {
    expect(stripVerifyTag('Untagged content')).toEqual({
      content: 'Untagged content',
      requiresVerification: false,
    });
  });

  it('handles empty input', () => {
    expect(stripVerifyTag('')).toEqual({
      content: '',
      requiresVerification: false,
    });
  });

  it('handles bare [verify] with no body', () => {
    expect(stripVerifyTag('[verify]')).toEqual({
      content: '',
      requiresVerification: true,
    });
  });
});

describe('stripRoleTag', () => {
  it('strips simple [role:tester]', () => {
    expect(stripRoleTag('[role:tester] Add unit tests')).toEqual({
      content: 'Add unit tests',
      preferredRole: 'tester',
    });
  });

  it('normalises whitespace + capitalisation', () => {
    expect(stripRoleTag('[role: Architect ] Design a thing')).toEqual({
      content: 'Design a thing',
      preferredRole: 'architect',
    });
  });

  it('kebab-cases multi-word roles', () => {
    expect(stripRoleTag('[role:Senior_Reviewer] Review PR')).toEqual({
      content: 'Review PR',
      preferredRole: 'senior-reviewer',
    });
  });

  it('truncates a role 28 chars long down to ≤24 after kebab-normalisation', () => {
    // 28-char role is within the regex capture group's 32-char cap, so
    // it matches and gets sliced to 24 chars by the function body.
    const role = 'a'.repeat(28); // 28 chars, within regex cap (≤32)
    const out = stripRoleTag(`[role:${role}] task`);
    expect(out.preferredRole?.length).toBeLessThanOrEqual(24);
    expect(out.content).toBe('task');
  });

  it('passes through unchanged when role exceeds 32-char regex cap', () => {
    // KNOWN BEHAVIOR (possible behavior gap noted 2026-04-25 during test
    // suite bring-up): the regex `[a-z0-9][a-z0-9\s\-_]{0,31}` caps at
    // 32 input chars. Roles longer than that cause regex non-match, and
    // the original content is returned unchanged. Function's docstring
    // says "≤ 24 chars" implying always-truncate; reality is "match +
    // truncate, OR preserve original". If a planner ever emits role
    // names >32 chars, the worker would see the literal [role:...]
    // prefix in its work prompt. Worth fixing if it surfaces in real
    // runs; for now this test documents the actual behavior so a
    // regex change here is an intentional contract update, not a
    // surprise regression.
    const long = 'a'.repeat(40); // 40 chars, exceeds regex cap
    const out = stripRoleTag(`[role:${long}] task`);
    expect(out.preferredRole).toBeUndefined();
    expect(out.content).toBe(`[role:${long}] task`); // unchanged
  });

  it('passes through untagged content', () => {
    expect(stripRoleTag('Untagged content')).toEqual({
      content: 'Untagged content',
      preferredRole: undefined,
    });
  });
});

describe('stripFilesTag', () => {
  it('strips a single-file [files:a.ts]', () => {
    expect(stripFilesTag('[files:lib/x.ts] Fix typo')).toEqual({
      content: 'Fix typo',
      expectedFiles: ['lib/x.ts'],
    });
  });

  it('strips comma-separated multi-file', () => {
    expect(stripFilesTag('[files:a.ts,b.tsx] Refactor')).toEqual({
      content: 'Refactor',
      expectedFiles: ['a.ts', 'b.tsx'],
    });
  });

  it('caps at 2 paths even when more given', () => {
    const out = stripFilesTag('[files:a.ts,b.ts,c.ts,d.ts] Big task');
    expect(out.expectedFiles).toHaveLength(2);
    expect(out.expectedFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('returns undefined for empty list', () => {
    expect(stripFilesTag('[files:] empty list')).toEqual({
      content: 'empty list',
      expectedFiles: undefined,
    });
  });

  it('passes through untagged content', () => {
    expect(stripFilesTag('Untagged content')).toEqual({
      content: 'Untagged content',
      expectedFiles: undefined,
    });
  });
});

describe('stripCriterionTag', () => {
  it('marks [criterion] entries', () => {
    expect(stripCriterionTag('[criterion] Dashboard renders live data')).toEqual({
      content: 'Dashboard renders live data',
      isCriterion: true,
    });
  });

  it('handles uppercase + whitespace', () => {
    expect(stripCriterionTag('  [CRITERION]  Acceptance')).toEqual({
      content: 'Acceptance',
      isCriterion: true,
    });
  });

  it('passes through untagged content', () => {
    expect(stripCriterionTag('Untagged content')).toEqual({
      content: 'Untagged content',
      isCriterion: false,
    });
  });

  it('handles empty input', () => {
    expect(stripCriterionTag('')).toEqual({
      content: '',
      isCriterion: false,
    });
  });
});

describe('stripFromTag (deliberate-execute I2)', () => {
  it('parses comma-separated indices', () => {
    expect(stripFromTag('[from:1,3] Wire watchdog')).toEqual({
      content: 'Wire watchdog',
      sourceDrafts: [1, 3],
    });
  });

  it('handles single + whitespace + uppercase', () => {
    expect(stripFromTag('[FROM: 2 ] Single member')).toEqual({
      content: 'Single member',
      sourceDrafts: [2],
    });
  });

  it('passes through untagged', () => {
    expect(stripFromTag('Untagged')).toEqual({
      content: 'Untagged',
      sourceDrafts: undefined,
    });
  });

  it('skips non-positive + non-numeric tokens', () => {
    expect(stripFromTag('[from:abc, 0, 4] Drops bad tokens')).toEqual({
      content: 'Drops bad tokens',
      sourceDrafts: [4],
    });
  });

  it('dedups duplicates', () => {
    expect(stripFromTag('[from:3,3,3] Dedup')).toEqual({
      content: 'Dedup',
      sourceDrafts: [3],
    });
  });

  it('strips empty tag prefix, leaves drafts unset', () => {
    expect(stripFromTag('[from:] Empty list')).toEqual({
      content: 'Empty list',
      sourceDrafts: undefined,
    });
  });
});

describe('stripRoleNoteTag (role-differentiated I3)', () => {
  it('strips simple [rolenote:tester]', () => {
    expect(
      stripRoleNoteTag('[rolenote:tester] Focus on Playwright not unit tests'),
    ).toEqual({
      content: 'Focus on Playwright not unit tests',
      roleNote: 'tester',
    });
  });

  it('normalises case + whitespace', () => {
    expect(stripRoleNoteTag('[ROLENOTE: Architect ] Stay close to data flow')).toEqual({
      content: 'Stay close to data flow',
      roleNote: 'architect',
    });
  });

  it('passes through untagged', () => {
    expect(stripRoleNoteTag('Untagged')).toEqual({
      content: 'Untagged',
      roleNote: undefined,
    });
  });

  it('does not match empty role — prefix preserved', () => {
    expect(stripRoleNoteTag('[rolenote:] Empty role')).toEqual({
      content: '[rolenote:] Empty role',
      roleNote: undefined,
    });
  });
});

describe('compose: full prefix chain', () => {
  it('verify + role', () => {
    const a = stripVerifyTag('[verify] [role:tester] Browser-test the form');
    const b = stripRoleTag(a.content);
    expect({
      content: b.content,
      verify: a.requiresVerification,
      role: b.preferredRole,
    }).toEqual({
      content: 'Browser-test the form',
      verify: true,
      role: 'tester',
    });
  });

  it('role only (no verify)', () => {
    const a = stripVerifyTag('[role:tester] Test X');
    const b = stripRoleTag(a.content);
    expect({
      content: b.content,
      verify: a.requiresVerification,
      role: b.preferredRole,
    }).toEqual({
      content: 'Test X',
      verify: false,
      role: 'tester',
    });
  });

  it('verify + role + files in spec order', () => {
    const a = stripVerifyTag('[verify] [role:tester] [files:a.ts,b.ts] Write tests');
    const b = stripRoleTag(a.content);
    const c = stripFilesTag(b.content);
    expect({
      content: c.content,
      verify: a.requiresVerification,
      role: b.preferredRole,
      files: c.expectedFiles,
    }).toEqual({
      content: 'Write tests',
      verify: true,
      role: 'tester',
      files: ['a.ts', 'b.ts'],
    });
  });

  it('files only', () => {
    const a = stripVerifyTag('[files:lib/x.ts] Fix typo');
    const b = stripRoleTag(a.content);
    const c = stripFilesTag(b.content);
    expect({
      content: c.content,
      verify: a.requiresVerification,
      role: b.preferredRole,
      files: c.expectedFiles,
    }).toEqual({
      content: 'Fix typo',
      verify: false,
      role: undefined,
      files: ['lib/x.ts'],
    });
  });

  it('full chain with from-tag', () => {
    const a = stripVerifyTag('[verify] [role:tester] [files:a.ts] [from:1,2] Build it');
    const b = stripRoleTag(a.content);
    const c = stripFilesTag(b.content);
    const d = stripFromTag(c.content);
    expect({
      content: d.content,
      verify: a.requiresVerification,
      role: b.preferredRole,
      files: c.expectedFiles,
      drafts: d.sourceDrafts,
    }).toEqual({
      content: 'Build it',
      verify: true,
      role: 'tester',
      files: ['a.ts'],
      drafts: [1, 2],
    });
  });
});

// #99 — operator-visible findings for planner sweeps that produced
// no work. Drift in these strings either fails to point operators at
// the right fix path (rephrase directive vs. switch pattern), or
// erases the assistant's reply excerpt — the only signal showing
// what the planner actually said.

describe('buildZeroTodoSummary', () => {
  it('quotes the assistant excerpt when provided', () => {
    const out = buildZeroTodoSummary('I will think about this carefully...');
    expect(out).toMatch(/Assistant reply excerpt: "I will think about this/);
    expect(out).toMatch(/did not call todowrite/);
  });

  it('handles null excerpt gracefully', () => {
    const out = buildZeroTodoSummary(null);
    expect(out).toMatch(/Assistant produced no extractable text/);
    expect(out).not.toMatch(/excerpt: ""/);
  });

  it('always includes the operator-action remediation hint', () => {
    const a = buildZeroTodoSummary('foo');
    const b = buildZeroTodoSummary(null);
    for (const out of [a, b]) {
      expect(out).toMatch(/Operator action:/);
      expect(out).toMatch(/rephrase the directive/);
      expect(out).toMatch(/switch to a different pattern/);
    }
  });

  it('lists the three common-causes bullets', () => {
    const out = buildZeroTodoSummary('any');
    expect(out).toMatch(/Directive was abstract/);
    expect(out).toMatch(/structured todowrite call \(model regression\)/);
    expect(out).toMatch(/missing files/);
  });
});

describe('buildAllFilteredSummary', () => {
  it('reports the totals correctly', () => {
    const out = buildAllFilteredSummary(8, 5);
    expect(out).toMatch(/with 8 item\(s\)/);
    expect(out).toMatch(/Dropped criteria: 5/);
  });

  it('points at the strategy tab + the enableCriticGate escape hatch', () => {
    const out = buildAllFilteredSummary(3, 3);
    expect(out).toMatch(/strategy tab/);
    expect(out).toMatch(/enableCriticGate: false/);
  });

  it('mentions the isViableCriterion gate', () => {
    const out = buildAllFilteredSummary(2, 2);
    expect(out).toMatch(/isViableCriterion/);
  });

  it('handles zero dropped (e.g., all empty content)', () => {
    const out = buildAllFilteredSummary(4, 0);
    expect(out).toMatch(/Dropped criteria: 0/);
  });
});
