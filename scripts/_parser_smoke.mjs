#!/usr/bin/env node
// Parser smoke: assertions over stripVerifyTag / stripRoleTag in
// lib/server/blackboard/planner.ts. These two regex-based parsers are
// the wire protocol between the planner's todowrite emission and the
// board's `requiresVerification` / `preferredRole` columns — a drift
// breaks Playwright grounding and role-differentiated routing silently.
//
// Run with: npx tsx scripts/_parser_smoke.mjs
// Exits 0 on pass, 1 on any assertion failure with a diff printed.
//
// Imports the TS module directly via file URL (same pattern as
// _blackboard_smoke.mjs) so no build step is needed.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const plannerPath = pathToFileURL(
  path.resolve('lib/server/blackboard/planner.ts'),
).href;

const { stripVerifyTag, stripRoleTag, stripFilesTag, stripCriterionTag } = await import(plannerPath);

let failed = 0;
let passed = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAIL [${label}]\n  expected: ${e}\n  actual:   ${a}`);
}

// ── stripVerifyTag cases ──────────────────────────────────────────────

eq(
  stripVerifyTag('[verify] Dashboard renders'),
  { content: 'Dashboard renders', requiresVerification: true },
  'verify: simple prefix',
);

eq(
  stripVerifyTag('[VERIFY] Dashboard renders'),
  { content: 'Dashboard renders', requiresVerification: true },
  'verify: uppercase prefix',
);

eq(
  stripVerifyTag('  [Verify]   Dashboard renders'),
  { content: 'Dashboard renders', requiresVerification: true },
  'verify: extra whitespace',
);

eq(
  stripVerifyTag('Untagged content'),
  { content: 'Untagged content', requiresVerification: false },
  'verify: pass-through untagged',
);

eq(
  stripVerifyTag(''),
  { content: '', requiresVerification: false },
  'verify: empty input',
);

eq(
  stripVerifyTag('[verify]'),
  { content: '', requiresVerification: true },
  'verify: prefix only (no content)',
);

// ── stripRoleTag cases ────────────────────────────────────────────────

eq(
  stripRoleTag('[role:tester] Add unit tests'),
  { content: 'Add unit tests', preferredRole: 'tester' },
  'role: simple prefix',
);

eq(
  stripRoleTag('[ROLE:Tester] Add unit tests'),
  { content: 'Add unit tests', preferredRole: 'tester' },
  'role: uppercase name lowercased',
);

eq(
  stripRoleTag('[role: Security Reviewer ] Audit auth'),
  { content: 'Audit auth', preferredRole: 'security-reviewer' },
  'role: spaces in name become hyphens',
);

eq(
  // Role name is 31 chars — fits the regex's {0,31} capture ceiling,
  // so the match succeeds. Normalized + sliced to the 24-char cap
  // after capture.
  stripRoleTag('[role:averylongrolenameovertwenty] X'),
  { content: 'X', preferredRole: 'averylongrolenameovertwe' },
  'role: name within regex cap, sliced to 24',
);

eq(
  // Role name exceeds the regex's 32-char cap so the prefix doesn't
  // match at all — content passes through untouched.
  stripRoleTag('[role:overlyverboserolethatexceedsthecap] X'),
  { content: '[role:overlyverboserolethatexceedsthecap] X', preferredRole: undefined },
  'role: name over regex cap → no match, pass-through',
);

eq(
  stripRoleTag('Untagged content'),
  { content: 'Untagged content', preferredRole: undefined },
  'role: pass-through untagged',
);

eq(
  stripRoleTag('[role:] Empty role'),
  { content: '[role:] Empty role', preferredRole: undefined },
  'role: empty role name ignored',
);

eq(
  stripRoleTag('[role:with_underscore] Work'),
  { content: 'Work', preferredRole: 'with-underscore' },
  'role: underscore normalized to hyphen',
);

// ── stripFilesTag cases ───────────────────────────────────────────────

eq(
  stripFilesTag('[files:lib/foo.ts] Refactor X'),
  { content: 'Refactor X', expectedFiles: ['lib/foo.ts'] },
  'files: single path',
);

eq(
  stripFilesTag('[files:lib/foo.ts,src/bar.tsx] Refactor X'),
  { content: 'Refactor X', expectedFiles: ['lib/foo.ts', 'src/bar.tsx'] },
  'files: two paths',
);

eq(
  stripFilesTag('[files: a.ts , b.ts , c.ts , d.ts ] Do stuff'),
  { content: 'Do stuff', expectedFiles: ['a.ts', 'b.ts'] },
  'files: capped at 2 paths, whitespace trimmed',
);

eq(
  stripFilesTag('[FILES:lib/X.ts] Refactor'),
  { content: 'Refactor', expectedFiles: ['lib/X.ts'] },
  'files: case-insensitive tag',
);

eq(
  stripFilesTag('[files:] Nothing'),
  { content: 'Nothing', expectedFiles: undefined },
  'files: empty list after tag → undefined',
);

eq(
  stripFilesTag('[files:,,,] Still nothing'),
  { content: 'Still nothing', expectedFiles: undefined },
  'files: all-empty entries → undefined',
);

eq(
  stripFilesTag('Untagged content'),
  { content: 'Untagged content', expectedFiles: undefined },
  'files: pass-through untagged',
);

// ── stripCriterionTag cases ───────────────────────────────────────────

eq(
  stripCriterionTag('[criterion] Dashboard renders live data'),
  { content: 'Dashboard renders live data', isCriterion: true },
  'criterion: simple prefix',
);

eq(
  stripCriterionTag('[CRITERION] Uppercase tag'),
  { content: 'Uppercase tag', isCriterion: true },
  'criterion: case-insensitive',
);

eq(
  stripCriterionTag('  [Criterion]   Whitespace tolerated'),
  { content: 'Whitespace tolerated', isCriterion: true },
  'criterion: whitespace trimmed',
);

eq(
  stripCriterionTag('A regular todo'),
  { content: 'A regular todo', isCriterion: false },
  'criterion: pass-through untagged',
);

eq(
  stripCriterionTag(''),
  { content: '', isCriterion: false },
  'criterion: empty input',
);

// ── Composition cases ─────────────────────────────────────────────────

{
  const first = stripVerifyTag('[verify] [role:tester] Browser-test the form');
  const second = stripRoleTag(first.content);
  eq(
    { content: second.content, verify: first.requiresVerification, role: second.preferredRole },
    { content: 'Browser-test the form', verify: true, role: 'tester' },
    'compose: [verify] [role:X]',
  );
}

{
  const first = stripVerifyTag('[role:tester] Test X');
  // stripVerifyTag didn't match; content unchanged.
  const second = stripRoleTag(first.content);
  eq(
    { content: second.content, verify: first.requiresVerification, role: second.preferredRole },
    { content: 'Test X', verify: false, role: 'tester' },
    'compose: only role (no verify)',
  );
}

{
  // All three tags in spec order: verify → role → files.
  const a = stripVerifyTag('[verify] [role:tester] [files:a.ts,b.ts] Write tests');
  const b = stripRoleTag(a.content);
  const c = stripFilesTag(b.content);
  eq(
    {
      content: c.content,
      verify: a.requiresVerification,
      role: b.preferredRole,
      files: c.expectedFiles,
    },
    {
      content: 'Write tests',
      verify: true,
      role: 'tester',
      files: ['a.ts', 'b.ts'],
    },
    'compose: verify + role + files, spec order',
  );
}

{
  // Files only, no other tags.
  const a = stripVerifyTag('[files:lib/x.ts] Fix typo');
  const b = stripRoleTag(a.content);
  const c = stripFilesTag(b.content);
  eq(
    {
      content: c.content,
      verify: a.requiresVerification,
      role: b.preferredRole,
      files: c.expectedFiles,
    },
    {
      content: 'Fix typo',
      verify: false,
      role: undefined,
      files: ['lib/x.ts'],
    },
    'compose: files only',
  );
}

// ── Report ────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
