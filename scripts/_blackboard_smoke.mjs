#!/usr/bin/env node
// Ad-hoc smoke for the blackboard store. Opens the DB, inserts a todo,
// runs a winning + losing CAS transition, commits, and prints the list.
// Run with: npx tsx scripts/_blackboard_smoke.mjs
// Delete once the real API route + integration test supersedes this.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const storePath = pathToFileURL(
  path.resolve('lib/server/blackboard/store.ts'),
).href;

const {
  _dangerouslyClearRun,
  insertBoardItem,
  listBoardItems,
  transitionStatus,
} = await import(storePath);

const RUN = 'run_smoke_xyz';

_dangerouslyClearRun(RUN);

const todo = insertBoardItem(RUN, {
  id: 't_001',
  kind: 'todo',
  content: 'extract parser into lib/json/parse.ts',
  status: 'open',
});
console.log('[insert] open todo:', todo.id, todo.status);

const claim = transitionStatus(RUN, 't_001', {
  from: 'open',
  to: 'claimed',
  ownerAgentId: 'ag_zed',
  fileHashes: [{ path: 'lib/json/parse.ts', sha: 'a3f88d1' }],
});
console.log('[claim] expected ok=true:', JSON.stringify(claim));

const race = transitionStatus(RUN, 't_001', {
  from: 'open',
  to: 'claimed',
  ownerAgentId: 'ag_qo',
});
console.log(
  '[race] expected ok=false currentStatus=claimed:',
  JSON.stringify(race),
);

const commit = transitionStatus(RUN, 't_001', {
  from: ['claimed', 'in-progress'],
  to: 'done',
  setCompletedAt: true,
});
console.log(
  '[commit] expected ok=true status=done:',
  JSON.stringify(commit),
);

const all = listBoardItems(RUN);
console.log('[list]', all.length, 'items:');
for (const it of all) {
  console.log('  ', it);
}

_dangerouslyClearRun(RUN);
console.log('[cleared]');
