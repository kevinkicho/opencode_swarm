#!/usr/bin/env node
// CLI: gzip-sweep events.ndjson for idle swarm runs.
//
// Usage:
//   node scripts/compress.mjs                 # sweep every run
//   node scripts/compress.mjs <swarmRunID>    # sweep one specific run
//   node scripts/compress.mjs --dry           # report what *would* be swept
//
// Rule (see memory project_retention_policy):
//   If events.ndjson hasn't been written in >24h, compress it in-place.
//   The .gz is written atomically (.gz.tmp → rename), verified by
//   re-reading the input size, then the original .ndjson is unlinked.
//
// We intentionally use mtime as the idle signal rather than hitting
// opencode — the sweep needs to work offline (cron, `npm run` from a
// server without internet) and the multiplexer already writes on every
// event, so an old mtime and an idle status converge.
//
// Safe to run concurrently with the web process: readEvents() already
// falls back to the .gz sibling once the rename lands, and the rename
// itself is atomic. A concurrent SSE append could race a concurrent
// compression; at prototype scale (single-user, manual sweep cadence)
// that hasn't come up — if it does, gate this behind an advisory lock
// (meta.json.lock) rather than adding transaction semantics.

import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const IDLE_MS = 24 * 60 * 60 * 1000;  // 24h per retention policy

const ROOT =
  process.env.OPENCODE_SWARM_ROOT ??
  path.join(process.cwd(), '.opencode_swarm');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const targetRunID = args.find((a) => !a.startsWith('--'));

async function sweep(runID) {
  const dir = path.join(ROOT, 'runs', runID);
  const plain = path.join(dir, 'events.ndjson');
  const gz = path.join(dir, 'events.ndjson.gz');
  const tmp = gz + '.tmp';

  const plainStat = await fs.stat(plain).catch(() => null);
  if (!plainStat) {
    return { runID, action: 'skip', reason: 'events.ndjson missing (already compressed or empty run)' };
  }

  const ageMs = Date.now() - plainStat.mtimeMs;
  if (ageMs < IDLE_MS) {
    const hours = (ageMs / 3_600_000).toFixed(1);
    return { runID, action: 'skip', reason: `still active (${hours}h since last event)` };
  }

  // If a previous sweep crashed between gzip and unlink, both files may
  // coexist — trust the .gz (content is identical) and remove the plain.
  const gzStat = await fs.stat(gz).catch(() => null);
  if (gzStat) {
    if (dryRun) return { runID, action: 'would-cleanup', reason: 'both .ndjson and .gz exist (leftover from interrupted sweep)' };
    await fs.unlink(plain);
    return { runID, action: 'cleanup', bytes: plainStat.size, reason: 'removed plain (gz already present)' };
  }

  if (dryRun) {
    return { runID, action: 'would-compress', bytes: plainStat.size };
  }

  // gzip to .tmp first, then atomic rename. Crash between write and
  // rename leaves a .tmp the next sweep can clear; crash between rename
  // and unlink leaves the state we hit above (.gz + .ndjson coexist).
  await pipeline(createReadStream(plain), createGzip(), createWriteStream(tmp));
  const tmpStat = await fs.stat(tmp);
  if (tmpStat.size === 0 && plainStat.size > 0) {
    await fs.unlink(tmp).catch(() => undefined);
    throw new Error(`gzip produced 0-byte output for ${plain}`);
  }
  await fs.rename(tmp, gz);
  await fs.unlink(plain);
  const ratio = (tmpStat.size / plainStat.size).toFixed(3);
  return { runID, action: 'compressed', bytes: plainStat.size, gzBytes: tmpStat.size, ratio };
}

async function listRunIDs() {
  const runsRoot = path.join(ROOT, 'runs');
  try {
    return await fs.readdir(runsRoot);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function report(result) {
  const { runID, action } = result;
  const tail = Object.entries(result)
    .filter(([k]) => k !== 'runID' && k !== 'action')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`${runID}  ${action}${tail ? '  ' + tail : ''}`);
}

async function main() {
  const ids = targetRunID ? [targetRunID] : await listRunIDs();
  let compressed = 0;
  let bytesSaved = 0;
  for (const id of ids) {
    try {
      const r = await sweep(id);
      report(r);
      if (r.action === 'compressed') {
        compressed += 1;
        bytesSaved += r.bytes - r.gzBytes;
      }
    } catch (err) {
      console.error(`${id}  error  ${err.message}`);
    }
  }
  if (!targetRunID) {
    const saved = (bytesSaved / 1024 / 1024).toFixed(2);
    console.log(`\nswept ${ids.length} run(s); compressed ${compressed}; ${saved} MiB reclaimed`);
  }
}

main().catch((err) => {
  console.error('compress failed:', err);
  process.exit(1);
});
