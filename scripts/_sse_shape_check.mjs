// Validate the SSE shaping transforms against a real captured events.ndjson.
// Runs the same reshapeForForward + dedupeReplay the proxy would apply and
// prints before/after sizes. Used to sanity-check the fix had the intended
// effect before shipping.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = resolve('demo-log/battle-2026-04-22-b/pattern-1-council/events.ndjson');

// Inline copies of the shaping functions so this script can run without
// transpiling the TS module. Kept in sync with lib/server/sse-shaping.ts.
const MESSAGE_UPDATED = 'message.updated';
const MESSAGE_PART_UPDATED = 'message.part.updated';

function reshapeForForward(ev) {
  if (ev.type !== MESSAGE_UPDATED) return ev;
  const diffs = ev.properties?.info?.summary?.diffs;
  if (!Array.isArray(diffs) || diffs.length === 0) return ev;
  return {
    ...ev,
    properties: {
      ...ev.properties,
      info: {
        ...ev.properties.info,
        summary: {
          ...ev.properties.info.summary,
          diffs: diffs.map((d) => ({ file: d.file })),
        },
      },
    },
  };
}

function partIDFor(ev) {
  if (ev.type !== MESSAGE_PART_UPDATED) return null;
  const id = ev.properties?.part?.id;
  return typeof id === 'string' ? id : null;
}

function dedupeReplay(events) {
  const latestMsg = new Map();
  const latestPart = new Map();
  const drop = new Uint8Array(events.length);

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === MESSAGE_UPDATED) {
      const id = ev.properties?.info?.id;
      if (typeof id === 'string') {
        const prev = latestMsg.get(id);
        if (prev !== undefined) drop[prev] = 1;
        latestMsg.set(id, i);
      }
    } else if (ev.type === MESSAGE_PART_UPDATED) {
      const id = partIDFor(ev);
      if (id) {
        const prev = latestPart.get(id);
        if (prev !== undefined) drop[prev] = 1;
        latestPart.set(id, i);
      }
    }
  }

  const out = [];
  for (let i = 0; i < events.length; i++) if (!drop[i]) out.push(events[i]);
  return out;
}

// ── Run ────────────────────────────────────────────────────────────────
const raw = readFileSync(FILE, 'utf8');
const lines = raw.split('\n').filter((l) => l.trim());
const events = [];
for (const line of lines) {
  const payload = line.startsWith('data: ') ? line.slice(6) : line;
  try {
    events.push(JSON.parse(payload));
  } catch {
    // skip malformed
  }
}

const rawBytes = lines.reduce((acc, l) => acc + l.length + 2, 0);
console.log(`[in] events=${events.length}  bytes=${(rawBytes / 1024 / 1024).toFixed(2)} MB`);

// Reshape-only pass
const reshaped = events.map(reshapeForForward);
const reshapedBytes = reshaped.reduce((acc, ev) => acc + JSON.stringify(ev).length + 2, 0);
console.log(
  `[reshape only]     events=${reshaped.length}  bytes=${(reshapedBytes / 1024 / 1024).toFixed(2)} MB  (${((1 - reshapedBytes / rawBytes) * 100).toFixed(1)}% smaller)`,
);

// Reshape + dedupe (replay path)
const deduped = dedupeReplay(reshaped);
const dedupedBytes = deduped.reduce((acc, ev) => acc + JSON.stringify(ev).length + 2, 0);
console.log(
  `[reshape + dedupe] events=${deduped.length}  bytes=${(dedupedBytes / 1024 / 1024).toFixed(2)} MB  (${((1 - dedupedBytes / rawBytes) * 100).toFixed(1)}% smaller)`,
);

// Event-type histogram after dedupe
const histBefore = new Map();
const histAfter = new Map();
for (const ev of events) histBefore.set(ev.type, (histBefore.get(ev.type) || 0) + 1);
for (const ev of deduped) histAfter.set(ev.type, (histAfter.get(ev.type) || 0) + 1);

console.log('\nper-type before → after:');
const allTypes = new Set([...histBefore.keys(), ...histAfter.keys()]);
for (const t of [...allTypes].sort()) {
  console.log(`  ${t.padEnd(30)} ${String(histBefore.get(t) || 0).padStart(5)} → ${String(histAfter.get(t) || 0).padStart(5)}`);
}
