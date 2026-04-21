#!/usr/bin/env node
// CLI: reindex the L1 part index from events.ndjson files.
//
// Usage:
//   node scripts/reindex.mjs                   # reindex every run in the ledger
//   node scripts/reindex.mjs <swarmRunID>      # reindex just that run
//
// Emits one line per run: "<swarmRunID>  inserted=<n>  lastSeq=<n>"
// so the output is easy to grep in a crontab log.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

// We import through a tsx-style require because the ingest module lives in
// TypeScript. When run under `npm exec` or `next dev` we rely on the Next
// build graph — but a standalone CLI needs a runtime loader. Easiest path:
// run this script via `npx tsx scripts/reindex.mjs …` so TS resolves.
const modPath = pathToFileURL(
  path.resolve('lib/server/memory/ingest.ts')
).href;

const { reindexAllRuns, reindexRunById } = await import(modPath);

const [, , arg] = process.argv;

try {
  if (arg) {
    const result = await reindexRunById(arg);
    if (!result) {
      console.error(`run not found: ${arg}`);
      process.exit(1);
    }
    console.log(`${arg}  inserted=${result.inserted}  lastSeq=${result.lastSeq}`);
  } else {
    const results = await reindexAllRuns();
    for (const r of results) {
      console.log(`${r.swarmRunID}  inserted=${r.inserted}  lastSeq=${r.lastSeq}`);
    }
    console.log(`\nreindexed ${results.length} run(s)`);
  }
} catch (err) {
  console.error('reindex failed:', err);
  process.exit(1);
}
