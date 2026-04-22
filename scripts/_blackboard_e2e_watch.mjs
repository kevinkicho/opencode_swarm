#!/usr/bin/env node
// Polls /board for a run and prints state transitions. Used to observe
// the step 3d auto-ticker end-to-end.
//
// Usage: node scripts/_blackboard_e2e_watch.mjs <origin> <swarmRunID> [iters]

const origin = process.argv[2];
const runID = process.argv[3];
const maxIters = Number(process.argv[4] ?? 60);
if (!origin || !runID) {
  console.error('usage: node scripts/_blackboard_e2e_watch.mjs <origin> <swarmRunID> [iters]');
  process.exit(1);
}

const startMs = Date.now();
const lastKnown = new Map(); // id -> status

function t() {
  return `t+${Math.round((Date.now() - startMs) / 1000)}s`.padStart(7);
}

function shortOwner(o) {
  if (!o) return '-'.padStart(14);
  return (o.length > 14 ? o.slice(-14) : o).padStart(14);
}

for (let i = 0; i < maxIters; i++) {
  try {
    const r = await fetch(`${origin}/api/swarm/run/${runID}/board`);
    const body = await r.json();
    const items = body.items ?? [];
    const current = new Map();
    for (const it of items) current.set(it.id, it);

    // transitions: new items + status changes
    const transitions = [];
    for (const [id, it] of current) {
      const prev = lastKnown.get(id);
      if (!prev) {
        transitions.push(['NEW', id, it.status, it.ownerAgentId, it.content.slice(0, 70)]);
      } else if (prev !== it.status) {
        transitions.push(['->', id, `${prev} → ${it.status}`, it.ownerAgentId, it.content.slice(0, 70)]);
      }
    }

    if (transitions.length > 0 || i === 0) {
      const counts = {};
      for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1;
      const countStr = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || '(empty)';
      console.log(`[${t()}] ${items.length} items | ${countStr}`);
      for (const [tag, id, statusMsg, owner, content] of transitions) {
        console.log(`   ${tag} ${id}  ${statusMsg.padEnd(22)}  ${shortOwner(owner)}  ${content}`);
      }
    }

    for (const [id, it] of current) lastKnown.set(id, it.status);

    // exit early if all items are terminal (done/stale/blocked)
    const allTerminal = items.length > 0 && items.every(
      (it) => it.status === 'done' || it.status === 'stale' || it.status === 'blocked',
    );
    if (allTerminal) {
      console.log(`[${t()}] all items terminal — exiting`);
      break;
    }
  } catch (err) {
    console.log(`[${t()}] poll error:`, err.message);
  }
  await new Promise((r) => setTimeout(r, 10_000));
}

// Final dump
const r = await fetch(`${origin}/api/swarm/run/${runID}/board`);
const { items = [] } = await r.json();
console.log(`\n[final] ${items.length} items:`);
for (const it of items) {
  const owner = shortOwner(it.ownerAgentId);
  const hashes = it.fileHashes ? it.fileHashes.length : 0;
  console.log(`   ${it.id}  ${it.status.padEnd(12)}  ${owner}  hashes=${hashes}  ${it.content.slice(0, 60)}`);
}
