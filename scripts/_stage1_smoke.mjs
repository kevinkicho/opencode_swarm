#!/usr/bin/env node
// Stage 1 smoke (2026-04-24 declared-roles alignment). Covers the two
// invariants the parser_smoke doesn't:
//
//   1. Blackboard roles are declared but display-only — roleNamesBy-
//      SessionID returns {planner, worker-N} for blackboard while
//      opencodeAgentForSession returns undefined (so user's opencode.json
//      is NOT forced to carry synthetic `planner` / `worker-N` agent
//      entries).
//   2. Commit-time drift check logic — given claim-time anchors,
//      current hashes, and the worker's editedPaths, the drift-decision
//      picks the right "drifted" subset. Anchor not in editedPaths +
//      current hash differs → drifted. Anchor in editedPaths (self-
//      edit) → not drifted regardless of hash change.
//
// Run with: npx tsx scripts/_stage1_smoke.mjs

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const rolesPath = pathToFileURL(
  path.resolve('lib/blackboard/roles.ts'),
).href;

const { roleNamesBySessionID, opencodeAgentForSession } = await import(rolesPath);

let passed = 0;
let failed = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push(`FAIL [${label}]\n  expected: ${e}\n  actual:   ${a}`);
}

// ── Role declaration for blackboard (display-only) ────────────────────

{
  const meta = {
    pattern: 'blackboard',
    sessionIDs: ['ses_abc_1', 'ses_abc_2', 'ses_abc_3'],
  };
  const roles = roleNamesBySessionID(meta);
  eq(roles.get('ses_abc_1'), 'planner', 'blackboard: session[0] = planner');
  eq(roles.get('ses_abc_2'), 'worker-1', 'blackboard: session[1] = worker-1');
  eq(roles.get('ses_abc_3'), 'worker-2', 'blackboard: session[2] = worker-2');
  eq(roles.size, 3, 'blackboard: 3 roles declared for 3 sessions');
}

// ── opencodeAgentForSession: blackboard returns undefined ─────────────
// (display-only; avoids forcing user to define synthetic agents)

{
  const meta = {
    pattern: 'blackboard',
    sessionIDs: ['ses_1', 'ses_2'],
  };
  eq(
    opencodeAgentForSession(meta, 'ses_1'),
    undefined,
    'blackboard: opencodeAgentForSession returns undefined (display-only roles)',
  );
}

// ── opencodeAgentForSession: hierarchical patterns still route ────────

{
  const meta = {
    pattern: 'role-differentiated',
    sessionIDs: ['ses_1', 'ses_2'],
    teamRoles: ['architect', 'tester'],
  };
  eq(
    opencodeAgentForSession(meta, 'ses_1'),
    'architect',
    'role-differentiated: opencodeAgentForSession returns pinned role',
  );
  eq(
    opencodeAgentForSession(meta, 'ses_2'),
    'tester',
    'role-differentiated: opencodeAgentForSession returns tester role',
  );
}

{
  const meta = {
    pattern: 'critic-loop',
    sessionIDs: ['ses_w', 'ses_c'],
  };
  eq(
    opencodeAgentForSession(meta, 'ses_w'),
    'worker',
    'critic-loop: worker role routed for dispatch',
  );
  eq(
    opencodeAgentForSession(meta, 'ses_c'),
    'critic',
    'critic-loop: critic role routed for dispatch',
  );
}

// ── Self-organizing patterns stay empty ───────────────────────────────

{
  const meta = {
    pattern: 'council',
    sessionIDs: ['s1', 's2', 's3'],
  };
  eq(
    roleNamesBySessionID(meta).size,
    0,
    'council: no declared roles (still self-organizing)',
  );
  eq(
    opencodeAgentForSession(meta, 's1'),
    undefined,
    'council: no dispatch routing',
  );
}

{
  const meta = {
    pattern: 'map-reduce',
    sessionIDs: ['m1', 'm2'],
  };
  eq(
    roleNamesBySessionID(meta).size,
    0,
    'map-reduce: no declared roles',
  );
}

// ── Commit-time drift logic ───────────────────────────────────────────
//
// Mirrors the decision in coordinator.ts (if you change that logic,
// update here too). Pure function — given anchors + current hashes +
// edited paths, returns the drifted subset. `editedPaths` skipping is
// the legitimate-self-edit exemption.

function computeDrift(anchors, currentByPath, editedPaths) {
  const editedSet = new Set(editedPaths);
  const drifted = [];
  for (const a of anchors) {
    if (editedSet.has(a.path)) continue; // self-edit, not drift
    const current = currentByPath[a.path] ?? '';
    if (current !== a.sha) drifted.push(a.path);
  }
  return drifted;
}

{
  // No anchors → no drift possible.
  eq(computeDrift([], {}, []), [], 'drift: empty anchors → empty drift');
}

{
  // One file anchor, unchanged, not edited → no drift.
  const anchors = [{ path: 'lib/foo.ts', sha: 'abc1234' }];
  const current = { 'lib/foo.ts': 'abc1234' };
  eq(computeDrift(anchors, current, []), [], 'drift: unchanged + not edited → no drift');
}

{
  // One file anchor, changed by SOMEONE ELSE (not in edited paths) → drift.
  const anchors = [{ path: 'lib/foo.ts', sha: 'abc1234' }];
  const current = { 'lib/foo.ts': 'def5678' };
  eq(
    computeDrift(anchors, current, []),
    ['lib/foo.ts'],
    'drift: changed + not in edited paths → drifted',
  );
}

{
  // One file anchor, changed by THIS WORKER (in edited paths) → no drift.
  const anchors = [{ path: 'lib/foo.ts', sha: 'abc1234' }];
  const current = { 'lib/foo.ts': 'def5678' };
  eq(
    computeDrift(anchors, current, ['lib/foo.ts']),
    [],
    'drift: changed + IS in edited paths → self-edit, not drift',
  );
}

{
  // Two anchors, one self-edited + one drifted-by-other.
  const anchors = [
    { path: 'lib/foo.ts', sha: 'aaa1111' },
    { path: 'lib/bar.ts', sha: 'bbb2222' },
  ];
  const current = {
    'lib/foo.ts': 'newfoohash', // self-edit
    'lib/bar.ts': 'newbarhash', // drift
  };
  eq(
    computeDrift(anchors, current, ['lib/foo.ts']),
    ['lib/bar.ts'],
    'drift: mixed self-edit + other-drift → only other-drift flagged',
  );
}

{
  // Anchor with empty sha (file absent at claim time); if file now
  // exists AND worker didn't create it → drift (another worker
  // created it).
  const anchors = [{ path: 'src/new.tsx', sha: '' }];
  const current = { 'src/new.tsx': 'abc1234' };
  eq(
    computeDrift(anchors, current, []),
    ['src/new.tsx'],
    'drift: absent-at-claim + now-exists + not edited → drifted',
  );
}

{
  // Same, but the worker created it (in editedPaths) → legitimate.
  const anchors = [{ path: 'src/new.tsx', sha: '' }];
  const current = { 'src/new.tsx': 'abc1234' };
  eq(
    computeDrift(anchors, current, ['src/new.tsx']),
    [],
    'drift: absent-at-claim + now-exists + in edited → self-create, not drift',
  );
}

{
  // File existed at claim, was deleted under us, not by this worker → drift.
  const anchors = [{ path: 'lib/old.ts', sha: 'old1234' }];
  const current = { 'lib/old.ts': '' }; // '' = file absent now
  eq(
    computeDrift(anchors, current, []),
    ['lib/old.ts'],
    'drift: existed-at-claim + deleted + not by this worker → drifted',
  );
}

// ── Report ────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(failures.join('\n'));
  console.error('');
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
