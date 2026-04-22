#!/usr/bin/env node
// Watches a blackboard run and reports whether work is spread across
// multiple sessions. Parallelism fix validation for SWARM_PATTERNS.md §1
// Open questions → Blackboard parallelism (2026-04-22).
//
// Usage: node scripts/_blackboard_parallelism_watch.mjs <origin> <swarmRunID> [iters]

const origin = process.argv[2];
const runID = process.argv[3];
const maxIters = Number(process.argv[4] ?? 60);
if (!origin || !runID) {
  console.error(
    'usage: node scripts/_blackboard_parallelism_watch.mjs <origin> <swarmRunID> [iters]',
  );
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

// Summarize which sessions are currently working (claimed/in-progress)
// — this is where parallelism is visible in real time. If the count of
// distinct active owners stays at 1 for the whole run, parallelism is
// not firing.
let maxConcurrentOwners = 0;
const everActiveOwners = new Set();

for (let i = 0; i < maxIters; i++) {
  try {
    const r = await fetch(`${origin}/api/swarm/run/${runID}/board`);
    const body = await r.json();
    const items = body.items ?? [];
    const current = new Map();
    for (const it of items) current.set(it.id, it);

    // Concurrency tracking: owners of claimed or in-progress items right now
    const activeOwners = new Set();
    for (const it of items) {
      if ((it.status === 'claimed' || it.status === 'in-progress') && it.ownerAgentId) {
        activeOwners.add(it.ownerAgentId);
        everActiveOwners.add(it.ownerAgentId);
      }
    }
    if (activeOwners.size > maxConcurrentOwners) {
      maxConcurrentOwners = activeOwners.size;
    }

    // Transitions: new items + status changes
    const transitions = [];
    for (const [id, it] of current) {
      const prev = lastKnown.get(id);
      if (!prev) {
        transitions.push(['NEW', id, it.status, it.ownerAgentId, it.content.slice(0, 64)]);
      } else if (prev !== it.status) {
        transitions.push([
          '->',
          id,
          `${prev} → ${it.status}`,
          it.ownerAgentId,
          it.content.slice(0, 64),
        ]);
      }
    }

    if (transitions.length > 0 || i === 0) {
      const counts = {};
      for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1;
      const countStr = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || '(empty)';
      const active =
        activeOwners.size > 0
          ? ` | active=${[...activeOwners].map((o) => o.slice(-8)).join(',')}`
          : '';
      console.log(`[${t()}] ${items.length} items | ${countStr}${active}`);
      for (const [tag, id, statusMsg, owner, content] of transitions) {
        console.log(`   ${tag} ${id}  ${statusMsg.padEnd(22)}  ${shortOwner(owner)}  ${content}`);
      }
    }

    for (const [id, it] of current) lastKnown.set(id, it.status);

    const allTerminal =
      items.length > 0 &&
      items.every(
        (it) => it.status === 'done' || it.status === 'stale' || it.status === 'blocked',
      );
    if (allTerminal) {
      console.log(`[${t()}] all items terminal — exiting`);
      break;
    }
  } catch (err) {
    console.log(`[${t()}] poll error:`, err.message);
  }
  await new Promise((r) => setTimeout(r, 5_000));
}

// Final report — the numbers that decide whether the fix worked.
const r = await fetch(`${origin}/api/swarm/run/${runID}/board`);
const { items = [] } = await r.json();
const doneByOwner = new Map();
for (const it of items) {
  if (it.status !== 'done') continue;
  const owner = it.ownerAgentId ?? '(none)';
  doneByOwner.set(owner, (doneByOwner.get(owner) ?? 0) + 1);
}

console.log(`\n[final] ${items.length} items; distribution of done:`);
for (const [owner, count] of doneByOwner) {
  console.log(`   ${owner.slice(-14).padStart(14)}  done=${count}`);
}
console.log(`\n[parallelism]`);
console.log(`   distinct owners ever active (claimed/in-progress at any poll): ${everActiveOwners.size}`);
console.log(`   max concurrent owners seen:                                   ${maxConcurrentOwners}`);
console.log(`   distinct owners that completed at least one item:             ${doneByOwner.size}`);
if (maxConcurrentOwners >= 2) {
  console.log(`\n   ✓ PARALLELISM OBSERVED — ${maxConcurrentOwners} sessions had work in flight simultaneously`);
} else if (doneByOwner.size >= 2) {
  console.log(
    `\n   ~ interleaved work across ${doneByOwner.size} sessions but never concurrent — poll interval may have missed the overlap`,
  );
} else {
  console.log(`\n   ✗ NO PARALLELISM — only one session did any work`);
}

// Ticker snapshot for context
try {
  const tr = await fetch(`${origin}/api/swarm/run/${runID}/board/ticker`);
  const tbody = await tr.json();
  console.log(`\n[ticker] state=${tbody.state} consecutiveIdle=${tbody.consecutiveIdle ?? '-'} inFlight=${tbody.inFlight ?? '-'}`);
} catch (err) {
  console.log(`\n[ticker] read error:`, err.message);
}
