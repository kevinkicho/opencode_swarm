#!/usr/bin/env node
// Ad-hoc smoke for the /board + /board/:itemId API routes. Exercises the
// full claim/start/commit lifecycle + the stale path against a running
// dev server. Replaces / complements _blackboard_smoke.mjs which hits the
// store layer directly.
//
// Run with: node scripts/_board_api_smoke.mjs <origin> <swarmRunID>
//   e.g.   node scripts/_board_api_smoke.mjs http://localhost:49187 run_mo9fw8zq_6474tb

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const origin = process.argv[2];
const runID = process.argv[3];
if (!origin || !runID) {
  console.error('usage: node scripts/_board_api_smoke.mjs <origin> <swarmRunID>');
  process.exit(1);
}

async function req(method, pathname, body) {
  const r = await fetch(`${origin}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: r.status, body: json };
}

function sha7(absPath) {
  const buf = readFileSync(absPath);
  return createHash('sha1').update(buf).digest('hex').slice(0, 7);
}

const REAL_FILE = 'package.json';
const realSha = sha7(REAL_FILE);
console.log(`[setup] ${REAL_FILE} current sha7 =`, realSha);

// --- happy path: open → claimed → in-progress → done ---------------------

const create = await req('POST', `/api/swarm/run/${runID}/board`, {
  kind: 'todo',
  content: 'smoke-test: extract parser helper',
});
console.log('[create todo]', create.status, create.body.item?.id, create.body.item?.status);
const todoId = create.body.item.id;

const claim = await req('POST', `/api/swarm/run/${runID}/board/${todoId}`, {
  action: 'claim',
  ownerAgentId: 'ag_smoke',
  fileHashes: [{ path: REAL_FILE, sha: realSha }],
});
console.log('[claim]', claim.status, claim.body.item?.status, claim.body.item?.ownerAgentId);

const start = await req('POST', `/api/swarm/run/${runID}/board/${todoId}`, {
  action: 'start',
});
console.log('[start]', start.status, start.body.item?.status);

const commit = await req('POST', `/api/swarm/run/${runID}/board/${todoId}`, {
  action: 'commit',
});
console.log('[commit ok]', commit.status, commit.body.item?.status, 'completedAtMs=', commit.body.item?.completedAtMs);

// --- CAS loss: commit again should be rejected ---------------------------

const commitAgain = await req('POST', `/api/swarm/run/${runID}/board/${todoId}`, {
  action: 'commit',
});
console.log('[commit already done — expect 409]', commitAgain.status, commitAgain.body.error, commitAgain.body.currentStatus);

// --- drift path: claim with bogus SHA, commit should mark stale ----------

const create2 = await req('POST', `/api/swarm/run/${runID}/board`, {
  kind: 'todo',
  content: 'smoke-test: drift case',
});
const driftId = create2.body.item.id;
console.log('[create drift todo]', create2.status, driftId);

await req('POST', `/api/swarm/run/${runID}/board/${driftId}`, {
  action: 'claim',
  ownerAgentId: 'ag_smoke',
  fileHashes: [{ path: REAL_FILE, sha: 'deadbee' }],
});
const driftCommit = await req('POST', `/api/swarm/run/${runID}/board/${driftId}`, {
  action: 'commit',
});
console.log(
  '[commit drift — expect status=stale, drift array]',
  driftCommit.status,
  driftCommit.body.item?.status,
  'staleSinceSha=', driftCommit.body.item?.staleSinceSha,
  'driftCount=', driftCommit.body.drift?.length,
);

// --- block + unblock -----------------------------------------------------

const create3 = await req('POST', `/api/swarm/run/${runID}/board`, {
  kind: 'todo',
  content: 'smoke-test: block case',
});
const blockId = create3.body.item.id;
await req('POST', `/api/swarm/run/${runID}/board/${blockId}`, {
  action: 'claim',
  ownerAgentId: 'ag_smoke',
  fileHashes: [{ path: REAL_FILE, sha: realSha }],
});
await req('POST', `/api/swarm/run/${runID}/board/${blockId}`, { action: 'start' });
const block = await req('POST', `/api/swarm/run/${runID}/board/${blockId}`, {
  action: 'block',
  note: 'waiting on t_other',
});
console.log('[block]', block.status, block.body.item?.status, 'note=', block.body.item?.note);

const unblock = await req('POST', `/api/swarm/run/${runID}/board/${blockId}`, {
  action: 'unblock',
});
console.log('[unblock]', unblock.status, unblock.body.item?.status);

// --- validation errors ---------------------------------------------------

const badKind = await req('POST', `/api/swarm/run/${runID}/board`, {
  kind: 'garbage',
  content: 'x',
});
console.log('[bad kind — expect 400]', badKind.status, badKind.body.error);

const badAction = await req('POST', `/api/swarm/run/${runID}/board/${todoId}`, {
  action: 'teleport',
});
console.log('[bad action — expect 400]', badAction.status, badAction.body.error);

const claimNoHashes = await req('POST', `/api/swarm/run/${runID}/board`, {
  kind: 'claim',
  content: 'must fail without fileHashes',
  ownerAgentId: 'ag_x',
});
console.log('[claim w/o fileHashes — expect 400]', claimNoHashes.status, claimNoHashes.body.error);

// --- list ----------------------------------------------------------------

const list = await req('GET', `/api/swarm/run/${runID}/board`);
console.log(`[list] ${list.status} — ${list.body.items?.length} items total`);
for (const it of list.body.items ?? []) {
  console.log(`   ${it.id.padEnd(14)} ${it.kind.padEnd(9)} ${it.status.padEnd(12)} ${it.content.slice(0, 60)}`);
}
