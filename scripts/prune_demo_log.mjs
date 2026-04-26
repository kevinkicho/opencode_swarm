#!/usr/bin/env node
// demo-log/ pruner. Disk-only concern — the directory is gitignored
// but accretes ~5-20 MB per real run, so left alone it eats into disk
// over weeks.
//
// Two modes, composable:
//   --compress     gzip every events.ndjson (and board-events.ndjson)
//                  larger than COMPRESS_MIN_BYTES. Keeps everything else
//                  in place. Safe — replay readers accept .ndjson.gz.
//   --delete       delete entire run directories older than --days N
//                  (default 30). Irreversible; dry-run first.
//   --dry-run      print what would happen without doing it. Default on
//                  unless --yes is passed.
//
// Usage:
//   node scripts/prune_demo_log.mjs --compress --dry-run
//   node scripts/prune_demo_log.mjs --compress --yes
//   node scripts/prune_demo_log.mjs --delete --days 14 --dry-run
//   node scripts/prune_demo_log.mjs --delete --days 14 --yes
//   node scripts/prune_demo_log.mjs --compress --delete --days 14 --yes
//
// Non-destructive by default — passing --dry-run is optional; the script
// refuses to actually modify anything unless --yes is also set.

import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync, rmSync, createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'demo-log');
const COMPRESS_CANDIDATES = ['events.ndjson', 'board-events.ndjson'];
const COMPRESS_MIN_BYTES = 64 * 1024; // skip < 64 KB; not worth the syscall

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    compress: false,
    delete: false,
    days: 30,
    yes: false,
    dryRun: true, // default on; flipped off by --yes
    stats: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--compress') opts.compress = true;
    else if (a === '--delete') opts.delete = true;
    else if (a === '--days') opts.days = Number(args[++i]);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--stats') opts.stats = true;
    else if (a === '--yes') {
      opts.yes = true;
      opts.dryRun = false;
    } else if (a === '-h' || a === '--help') {
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n'));
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!opts.compress && !opts.delete) {
    console.error('specify at least one of --compress / --delete');
    process.exit(1);
  }
  if (!Number.isFinite(opts.days) || opts.days <= 0) {
    console.error(`--days must be a positive number (got ${opts.days})`);
    process.exit(1);
  }
  return opts;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function walkRunDirs(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Any directory directly under ROOT is a run-dir candidate.
        // Also recurse once since battle-test logs nest one level deeper.
        out.push(full);
        if (dir === root) stack.push(full);
      }
    }
  }
  return out;
}

async function gzipFile(src) {
  const dst = src + '.gz';
  const srcBefore = statSync(src).size;
  await pipeline(createReadStream(src), createGzip({ level: 9 }), createWriteStream(dst));
  const dstAfter = statSync(dst).size;
  unlinkSync(src);
  return { srcBefore, dstAfter };
}

async function runCompress(opts) {
  let totalBefore = 0;
  let totalAfter = 0;
  let touched = 0;
  const dirs = walkRunDirs(ROOT);
  for (const dir of dirs) {
    for (const name of COMPRESS_CANDIDATES) {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size < COMPRESS_MIN_BYTES) continue;
      touched += 1;
      totalBefore += stat.size;
      if (opts.dryRun) {
        console.log(`  [dry] would gzip ${path.relative(ROOT, full)} (${fmtBytes(stat.size)})`);
      } else {
        const { srcBefore, dstAfter } = await gzipFile(full);
        totalAfter += dstAfter;
        const ratio = Math.round((1 - dstAfter / srcBefore) * 100);
        console.log(
          `  gzip ${path.relative(ROOT, full)} ${fmtBytes(srcBefore)} → ${fmtBytes(dstAfter)} (-${ratio}%)`,
        );
      }
    }
  }
  console.log(
    `compress: ${touched} file(s)${opts.dryRun ? ' (dry)' : ''}, ${fmtBytes(totalBefore)}${
      opts.dryRun ? '' : ` → ${fmtBytes(totalAfter)} (${Math.round((1 - totalAfter / Math.max(totalBefore, 1)) * 100)}% saved)`
    }`,
  );
}

function runDelete(opts) {
  const cutoffMs = Date.now() - opts.days * 24 * 60 * 60 * 1000;
  const dirs = walkRunDirs(ROOT).filter((d) => path.dirname(d) === ROOT);
  let removed = 0;
  let freed = 0;
  for (const dir of dirs) {
    const stat = statSync(dir);
    // Use the most recent mtime between the dir itself and a start-ts.txt
    // if present — dir mtime can drift on the ndjson append but start-ts
    // is the authoritative creation time when the driver writes it.
    let effectiveMs = stat.mtimeMs;
    const startTsPath = path.join(dir, 'start-ts.txt');
    try {
      const text = readFileSync(startTsPath, 'utf8').trim();
      const parsed = Date.parse(text);
      if (Number.isFinite(parsed)) effectiveMs = parsed;
    } catch {
      // no start-ts.txt — fall back to mtime
    }
    if (effectiveMs >= cutoffMs) continue;
    const size = dirSize(dir);
    removed += 1;
    freed += size;
    if (opts.dryRun) {
      console.log(
        `  [dry] would delete ${path.relative(ROOT, dir)} (${fmtBytes(size)}, age ${Math.round((Date.now() - effectiveMs) / 86_400_000)}d)`,
      );
    } else {
      rmSync(dir, { recursive: true, force: true });
      console.log(
        `  del ${path.relative(ROOT, dir)} (${fmtBytes(size)}, age ${Math.round((Date.now() - effectiveMs) / 86_400_000)}d)`,
      );
    }
  }
  console.log(
    `delete: ${removed} dir(s)${opts.dryRun ? ' (dry)' : ''}, ${fmtBytes(freed)} ${
      opts.dryRun ? 'would be' : ''
    } freed`,
  );
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          total += statSync(full).size;
        } catch {
          // ignore
        }
      }
    }
  }
  return total;
}

async function main() {
  const opts = parseArgs();
  try {
    statSync(ROOT);
  } catch {
    console.error(`demo-log/ not found at ${ROOT}`);
    process.exit(0);
  }

  if (opts.stats) {
    console.log(`Current disk usage: ${fmtBytes(dirSize(ROOT))}`);
  }

  console.log(
    `demo-log pruner${opts.dryRun ? ' — DRY RUN (pass --yes to actually modify)' : ''}`,
  );
  console.log(`  root: ${ROOT}`);
  if (opts.compress) await runCompress(opts);
  if (opts.delete) runDelete(opts);

  if (opts.stats && !opts.dryRun) {
    console.log(`Post-prune disk usage: ${fmtBytes(dirSize(ROOT))}`);
  }
}

main().catch((err) => {
  console.error('prune_demo_log crashed:', err);
  process.exit(1);
});
