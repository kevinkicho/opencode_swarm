#!/usr/bin/env node
// Team-model wiring smoke. Locks in the two load-bearing invariants of
// the team-picker → dispatch plumbing (2026-04-24):
//
//   1. Flatten: teamCounts → teamModels[] via catalog-order iteration
//      produces a deterministic per-slot list that matches length
//      teamSize.
//   2. Survivor remap: after partial spawn failures, teamModels in
//      meta is index-aligned with sessionIDs — session `sessions[j]`
//      (which came from original slot `sessions[j].idx`) uses
//      teamModels[j], which is the original teamModels[sessions[j].idx].
//
// Neither requires a live opencode. End-to-end dispatch validation
// lives in docs/VALIDATION.md §7.
//
// Run with: npx tsx scripts/_team_models_smoke.mjs

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const zenCatalogPath = pathToFileURL(
  path.resolve('lib/zen-catalog.ts'),
).href;
const { zenModels } = await import(zenCatalogPath);

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

// ── Flatten logic mirror (from new-run-modal.tsx::handleLaunch) ───────

function flatten(teamCounts) {
  const out = [];
  for (const model of zenModels) {
    const count = teamCounts[model.id] ?? 0;
    for (let i = 0; i < count; i += 1) out.push(model.id);
  }
  return out;
}

// ── Survivor remap mirror (from app/api/swarm/run/route.ts) ───────────

function survivorRemap(originalTeamModels, survivingSessionsWithIdx) {
  if (!originalTeamModels) return undefined;
  return survivingSessionsWithIdx.map((s) => originalTeamModels[s.idx]);
}

// ── Flatten cases ─────────────────────────────────────────────────────

{
  // Single ollama pick → single-element team.
  const picked = flatten({ 'ollama/glm-5.1:cloud': 1 });
  eq(picked, ['ollama/glm-5.1:cloud'], 'flatten: single ollama model, count 1');
}

{
  // Three of the same model → 3-session team, all same.
  const picked = flatten({ 'ollama/mistral-large-3:675b-cloud': 3 });
  eq(
    picked,
    [
      'ollama/mistral-large-3:675b-cloud',
      'ollama/mistral-large-3:675b-cloud',
      'ollama/mistral-large-3:675b-cloud',
    ],
    'flatten: 3x same ollama model',
  );
}

{
  // Mixed tiers — verifies the cross-tier team picker shape a user
  // might actually submit. Catalog order is preserved so ordering is
  // deterministic: zen models land first (anthropic family at the top
  // of zenModels), then ollama family at the bottom.
  const picked = flatten({
    'claude-sonnet-4.6': 1,
    'ollama/glm-5.1:cloud': 2,
  });
  eq(
    picked,
    ['claude-sonnet-4.6', 'ollama/glm-5.1:cloud', 'ollama/glm-5.1:cloud'],
    'flatten: mixed zen+ollama, catalog-order deterministic',
  );
}

{
  // Empty → empty array (caller gates on totalAgents > 0 before using).
  eq(flatten({}), [], 'flatten: empty counts → empty array');
}

// ── Survivor-remap cases ──────────────────────────────────────────────

{
  // All 3 sessions survive, no remap needed.
  const original = [
    'ollama/glm-5.1:cloud',
    'claude-sonnet-4.6',
    'ollama/mistral-large-3:675b-cloud',
  ];
  const survivors = [
    { id: 'sess_A', idx: 0 },
    { id: 'sess_B', idx: 1 },
    { id: 'sess_C', idx: 2 },
  ];
  eq(survivorRemap(original, survivors), original, 'remap: all survived, identity');
}

{
  // Middle session failed → survivors are slots 0 and 2.
  const original = [
    'ollama/glm-5.1:cloud',
    'claude-sonnet-4.6',
    'ollama/mistral-large-3:675b-cloud',
  ];
  const survivors = [
    { id: 'sess_A', idx: 0 },
    { id: 'sess_C', idx: 2 },
  ];
  eq(
    survivorRemap(original, survivors),
    ['ollama/glm-5.1:cloud', 'ollama/mistral-large-3:675b-cloud'],
    'remap: middle failed, meta.teamModels index-aligns with meta.sessionIDs',
  );
}

{
  // First session failed; survivors slot from idx=1.
  const original = ['a', 'b', 'c'];
  const survivors = [
    { id: 'sess_B', idx: 1 },
    { id: 'sess_C', idx: 2 },
  ];
  eq(survivorRemap(original, survivors), ['b', 'c'], 'remap: first failed, offset by 1');
}

{
  // No teamModels set at all → undefined propagates.
  eq(survivorRemap(undefined, []), undefined, 'remap: undefined teamModels → undefined');
}

// ── Catalog roundtrip: the picker's IDs are actually in zenModels ─────

{
  // Every ID the flatten produces must be resolvable in zenModels.
  // Guards against typos in new-run-modal's picker when it emits IDs
  // that don't exist in the catalog the server also uses.
  const teamCounts = {
    'claude-opus-4.7': 1,
    'ollama/nemotron-3-super:cloud': 1,
    'ollama/glm-5.1:cloud': 1,
  };
  const ids = flatten(teamCounts);
  for (const id of ids) {
    const entry = zenModels.find((m) => m.id === id);
    if (!entry) {
      failed += 1;
      failures.push(`FAIL [catalog-roundtrip ${id}]: not in zenModels`);
    } else {
      passed += 1;
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(failures.join('\n'));
  console.error('');
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
