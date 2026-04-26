// Automatic demo-log directory retention. The script
// `scripts/prune_demo_log.mjs` is the manual/CLI entry point; this
// module is the programmatic equivalent that runs in-process on dev
// boot (via auto-ticker's startup hook).
//
// Two actions, both idempotent:
//   - Compression (always safe, always on): gzip `events.ndjson` and
//     `board-events.ndjson` files ≥ COMPRESS_MIN_BYTES. Replay readers
//     accept the `.gz` variant transparently, so there's no downside.
//   - Deletion (destructive, opt-in): rm -rf run directories older
//     than DEMO_LOG_RETENTION_DAYS. Gated on `DEMO_LOG_AUTO_DELETE=1`
//     env var so the default boot behavior never destroys data the
//     user hasn't asked to lose.
//
// Defaults live here rather than .env so a fresh clone just works;
// override via env when needed.

import 'server-only';

import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'demo-log');
const COMPRESS_MIN_BYTES = 64 * 1024;
const COMPRESS_TARGETS = ['events.ndjson', 'board-events.ndjson'];

function retentionDays(): number {
  const raw = process.env.DEMO_LOG_RETENTION_DAYS;
  if (!raw) return 30;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function autoDeleteEnabled(): boolean {
  return process.env.DEMO_LOG_AUTO_DELETE === '1';
}

async function compressFileIfBig(filePath: string): Promise<boolean> {
  let st: Awaited<ReturnType<typeof fs.stat>>;
  try {
    st = await fs.stat(filePath);
  } catch {
    return false;
  }
  if (!st.isFile() || st.size < COMPRESS_MIN_BYTES) return false;
  const out = filePath + '.gz';
  try {
    await pipeline(createReadStream(filePath), createGzip(), createWriteStream(out));
    await fs.unlink(filePath);
    return true;
  } catch {
    // Best-effort. On failure, remove any partial .gz so next run can retry.
    await fs.unlink(out).catch(() => undefined);
    return false;
  }
}

async function compressRunDir(runDir: string): Promise<number> {
  let compressed = 0;
  for (const name of COMPRESS_TARGETS) {
    if (await compressFileIfBig(path.join(runDir, name))) compressed += 1;
  }
  return compressed;
}

async function isOlderThan(runDir: string, ageMs: number): Promise<boolean> {
  try {
    const st = await fs.stat(runDir);
    return Date.now() - st.mtimeMs > ageMs;
  } catch {
    return false;
  }
}

export interface PruneSummary {
  scanned: number;
  compressed: number;
  deleted: number;
  errors: number;
}

export async function pruneDemoLog(): Promise<PruneSummary> {
  const summary: PruneSummary = { scanned: 0, compressed: 0, deleted: 0, errors: 0 };
  let entries: string[];
  try {
    entries = await fs.readdir(ROOT);
  } catch {
    // demo-log dir missing — nothing to do (fresh clone, empty state).
    return summary;
  }
  const deleteEnabled = autoDeleteEnabled();
  const deleteAgeMs = retentionDays() * 24 * 60 * 60 * 1000;
  for (const name of entries) {
    const runDir = path.join(ROOT, name);
    summary.scanned += 1;
    try {
      const st = await fs.stat(runDir);
      if (!st.isDirectory()) continue;
      summary.compressed += await compressRunDir(runDir);
      if (deleteEnabled && (await isOlderThan(runDir, deleteAgeMs))) {
        await fs.rm(runDir, { recursive: true, force: true });
        summary.deleted += 1;
      }
    } catch (err) {
      summary.errors += 1;
      console.error(`Error pruning demo-log directory ${runDir}:`, err);
    }
  }
  return summary;
}
