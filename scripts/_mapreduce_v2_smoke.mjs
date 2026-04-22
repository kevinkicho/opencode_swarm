#!/usr/bin/env node
// Poll a map-reduce run's board and watch the v2 synthesize-claim flow.
//
// v2 routes the reduce phase through a blackboard item (kind='synthesize',
// id='synth_<swarmRunID>') instead of a pinned sessionIDs[0] post. This
// script confirms the migration end-to-end:
//   1. The synth item appears on the board once the map phase drains.
//   2. It transitions open → claimed → in-progress → done under one
//      ownerAgentId (the session that won the claim).
//   3. Transition to done is the signal that the synthesizer's turn
//      completed and the unified output is in that session's transcript.
//
// Auto-stops when the synth item lands in 'done' / 'stale', or when the
// 15-minute cap fires. The cap is loose on purpose — a genuine synthesis
// on a real repo typically lands within 3-6 min on an idle machine, but
// a session that had to rehydrate its map-phase context can take longer.
// The 5-min dispatch deadline in runMapReduceSynthesis is stricter; if
// the dispatch deadline fires first we still observe the 'open' item
// sitting on the board for forensics.
//
// Usage:
//   node scripts/_mapreduce_v2_smoke.mjs <origin> <swarmRunID> [capMinutes]
//
// Example:
//   node scripts/_mapreduce_v2_smoke.mjs http://localhost:49187 run_xxx_yyy 15

const origin = process.argv[2];
const runID = process.argv[3];
const capMinutes = Number(process.argv[4] ?? 15);
if (!origin || !runID) {
  console.error(
    'usage: node scripts/_mapreduce_v2_smoke.mjs <origin> <swarmRunID> [capMinutes]',
  );
  process.exit(1);
}

const SYNTH_ID = `synth_${runID}`;
const POLL_INTERVAL_MS = 10_000;
const startMs = Date.now();
const deadlineMs = startMs + capMinutes * 60 * 1000;

function t() {
  const s = Math.round((Date.now() - startMs) / 1000);
  return `t+${s}s`.padStart(8);
}

function shortOwner(o) {
  if (!o) return '-';
  return o.length > 14 ? o.slice(-14) : o;
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

// Starting metadata — confirms we're pointing at a map-reduce run.
try {
  const meta = await getJson(`${origin}/api/swarm/run/${runID}`);
  console.log(
    `[${t()}] run ${runID} | pattern=${meta.pattern} | sessions=${meta.sessionIDs?.length ?? 0}`,
  );
  if (meta.pattern !== 'map-reduce') {
    console.warn(
      `[${t()}] warning: run pattern is '${meta.pattern}', not 'map-reduce' — synth item may never appear`,
    );
  }
} catch (err) {
  console.error(`[${t()}] could not fetch run meta: ${err.message}`);
  process.exit(1);
}

const lastKnown = new Map();
let synthSeen = false;
let terminated = false;

while (Date.now() < deadlineMs) {
  try {
    const body = await getJson(`${origin}/api/swarm/run/${runID}/board`);
    const items = body.items ?? [];
    const current = new Map();
    for (const it of items) current.set(it.id, it);

    const transitions = [];
    for (const [id, it] of current) {
      const prev = lastKnown.get(id);
      if (!prev) {
        transitions.push([
          'NEW',
          id,
          it.status,
          it.ownerAgentId,
          it.kind,
          it.content?.slice(0, 80) ?? '',
        ]);
      } else if (prev !== it.status) {
        transitions.push([
          '->',
          id,
          `${prev} → ${it.status}`,
          it.ownerAgentId,
          it.kind,
          it.content?.slice(0, 80) ?? '',
        ]);
      }
    }

    if (transitions.length > 0) {
      const counts = {};
      for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1;
      const countStr =
        Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || '(empty)';
      console.log(`[${t()}] ${items.length} items | ${countStr}`);
      for (const [tag, id, statusMsg, owner, kind, content] of transitions) {
        console.log(
          `   ${tag.padEnd(3)} ${id.padEnd(40)}  ${kind.padEnd(11)}  ${statusMsg.padEnd(24)}  ${shortOwner(owner).padStart(14)}  ${content}`,
        );
      }
    }

    for (const [id, it] of current) lastKnown.set(id, it.status);

    const synth = current.get(SYNTH_ID);
    if (synth && !synthSeen) {
      synthSeen = true;
      console.log(
        `[${t()}] synth item landed on board (status=${synth.status})`,
      );
    }
    if (synth && (synth.status === 'done' || synth.status === 'stale')) {
      console.log(
        `[${t()}] synth item reached terminal status '${synth.status}' — exiting`,
      );
      terminated = true;
      break;
    }
  } catch (err) {
    console.log(`[${t()}] poll error: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}

if (!terminated) {
  console.log(`[${t()}] ${capMinutes}-minute cap exceeded — exiting without a terminal synth transition`);
}

// Final dump focused on the synth item and any siblings (siblings would
// indicate the run is dual-mode blackboard+map-reduce, not today's case).
try {
  const { items = [] } = await getJson(`${origin}/api/swarm/run/${runID}/board`);
  console.log(`\n[final] board = ${items.length} items`);
  for (const it of items) {
    const hashes = it.fileHashes ? it.fileHashes.length : 0;
    const completedAge = it.completedAtMs
      ? Math.round((Date.now() - it.completedAtMs) / 1000) + 's ago'
      : '-';
    console.log(
      `   ${it.id.padEnd(40)}  ${it.kind.padEnd(11)}  ${it.status.padEnd(12)}  owner=${shortOwner(it.ownerAgentId).padStart(14)}  hashes=${hashes}  completed=${completedAge}`,
    );
  }
  const synth = items.find((it) => it.id === SYNTH_ID);
  if (synth && synth.content) {
    console.log(`\n[final] synth content first 400 chars:\n${synth.content.slice(0, 400)}`);
  }
} catch (err) {
  console.log(`[final] dump failed: ${err.message}`);
}
