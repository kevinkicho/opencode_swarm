#!/usr/bin/env node
// Pattern defaults smoke (2026-04-24). One assertion per pattern's
// default-team composition so drift from the user-approved model-
// mapping table fails the build loudly. The mapping is:
//
//   blackboard           planner=glm · workers=gemma ×(N-1) · critic=glm · verifier=gemma · auditor=nemo
//   council              all N = nemo
//   map-reduce           session[0]=nemo (synth) · rest=gemma (mappers)
//   orchestrator-worker  session[0]=nemo (orchestrator) · rest=gemma (workers)
//   role-differentiated  role-indexed, cycling through 8 roles
//   debate-judge         session[0]=nemo (judge) · generators rotate nemo/gemma/glm
//   critic-loop          [worker=gemma, critic=glm]
//   deliberate-execute   all N = nemo
//
// Run: npx tsx scripts/_pattern_defaults_smoke.mjs

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const patternsPath = pathToFileURL(
  path.resolve('lib/swarm-patterns.ts'),
).href;
const { patternDefaults } = await import(patternsPath);

const GLM = 'ollama/glm-5.1:cloud';
const GEMMA = 'ollama/gemma4:31b-cloud';
const NEMO = 'ollama/nemotron-3-super:cloud';

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

// ── blackboard ────────────────────────────────────────────────────────
eq(
  patternDefaults.blackboard.teamModels(5),
  [GLM, GEMMA, GEMMA, GEMMA, GEMMA],
  'blackboard: planner glm + 4 gemma workers',
);
eq(patternDefaults.blackboard.criticModel, GLM, 'blackboard: critic glm');
eq(patternDefaults.blackboard.verifierModel, GEMMA, 'blackboard: verifier gemma');
eq(patternDefaults.blackboard.auditorModel, NEMO, 'blackboard: auditor nemo');

// ── council ───────────────────────────────────────────────────────────
eq(
  patternDefaults.council.teamModels(3),
  [NEMO, NEMO, NEMO],
  'council: all drafters nemo',
);
eq(
  patternDefaults.council.teamModels(5),
  [NEMO, NEMO, NEMO, NEMO, NEMO],
  'council: scales with teamSize',
);

// ── map-reduce ────────────────────────────────────────────────────────
eq(
  patternDefaults['map-reduce'].teamModels(4),
  [NEMO, GEMMA, GEMMA, GEMMA],
  'map-reduce: synth nemo + 3 mappers gemma',
);

// ── orchestrator-worker ───────────────────────────────────────────────
eq(
  patternDefaults['orchestrator-worker'].teamModels(4),
  [NEMO, GEMMA, GEMMA, GEMMA],
  'orchestrator-worker: orchestrator nemo + 3 workers gemma',
);

// ── role-differentiated ───────────────────────────────────────────────
// Roles cycle: architect, builder, tester, reviewer, security, docs, ux, data
eq(
  patternDefaults['role-differentiated'].teamModels(8),
  [NEMO, GEMMA, GEMMA, NEMO, NEMO, GLM, GEMMA, GEMMA],
  'role-differentiated: 8-role cycle landed correctly',
);
eq(
  patternDefaults['role-differentiated'].teamModels(4),
  [NEMO, GEMMA, GEMMA, NEMO],
  'role-differentiated: 4 roles = architect+builder+tester+reviewer',
);
eq(
  patternDefaults['role-differentiated'].teamRoles,
  ['architect', 'builder', 'tester', 'reviewer', 'security', 'docs', 'ux', 'data'],
  'role-differentiated: default teamRoles list',
);

// ── debate-judge ──────────────────────────────────────────────────────
// session[0]=judge, generators rotate through [nemo, gemma, glm]
eq(
  patternDefaults['debate-judge'].teamModels(4),
  [NEMO, NEMO, GEMMA, GLM],
  'debate-judge: judge + 3 generators (nemo, gemma, glm)',
);
eq(
  patternDefaults['debate-judge'].teamModels(5),
  [NEMO, NEMO, GEMMA, GLM, NEMO],
  'debate-judge: rotation cycles at 3',
);

// ── critic-loop ───────────────────────────────────────────────────────
eq(
  patternDefaults['critic-loop'].teamModels(2),
  [GEMMA, GLM],
  'critic-loop: worker gemma + critic glm',
);

// ── deliberate-execute ────────────────────────────────────────────────
eq(
  patternDefaults['deliberate-execute'].teamModels(3),
  [NEMO, NEMO, NEMO],
  'deliberate-execute: all nemo',
);

// ── none ──────────────────────────────────────────────────────────────
// `none` defaults to GLM so the baseline run also uses ollama (2026-04-24
// ollama-only testing mandate — prior stance "no defaults" had none falling
// back to opencode.json's root model, which routes to go-tier).
eq(
  patternDefaults.none.teamModels(1),
  [GLM],
  'none: single session defaults to ollama glm',
);

// ── Report ────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(failures.join('\n'));
  console.error('');
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
