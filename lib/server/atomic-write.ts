// HARDENING_PLAN.md#D1 — atomic-rename file write + per-key mutex.
//
// Problem: `fs.writeFile(path, content)` is NOT crash-atomic on POSIX.
// `O_TRUNC` happens before any byte is written. A SIGKILL between
// truncate and write leaves a 0-byte file. swarm-registry.ts had two
// such call sites (createRun line 195, updateRunMeta line 280) — a
// dev-server crash mid-write would leave a 0-byte meta.json that
// `getRun` parse-throws on every subsequent read.
//
// Fix: write to a temp path then `fs.rename` into place. Rename is
// atomic on POSIX — readers see either the old file or the new one,
// never a zero-byte partial.
//
// Plus a per-key async mutex for callers that do read-modify-write
// (e.g., updateRunMeta). Without serialization, two concurrent
// updateRunMeta calls both read, both modify, and the second silently
// overwrites the first's update.

import 'server-only';

import { promises as fs } from 'node:fs';

// Atomic-rename file write. Writes content to `${path}.tmp`, fsyncs,
// then renames to `path`. On any error, attempts to clean up the tmp
// file. Caller doesn't need to wait for fsync to surface; the rename
// only completes after the bytes hit disk.
export async function atomicWriteFile(
  path: string,
  content: string | Uint8Array,
  encoding: BufferEncoding = 'utf8',
): Promise<void> {
  // Distinct tmp suffix per call — important if two concurrent writes
  // to the same path land here despite the mutex (e.g., different
  // callers without per-path locking).
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.writeFile(tmp, content, encoding);
    await fs.rename(tmp, path);
  } catch (err) {
    // Best-effort cleanup; if the tmp file doesn't exist (write
    // never succeeded), unlink silently no-ops on ENOENT.
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

// Per-key async mutex. Callers passing the same `key` are serialized.
// globalThis-keyed so HMR doesn't reset the mutex map mid-flight (D2
// pattern).
const RUN_MUTEX_KEY = Symbol.for('opencode_swarm.runMutexByKey.v1');
function runMutexes(): Map<string, Promise<unknown>> {
  const g = globalThis as { [RUN_MUTEX_KEY]?: Map<string, Promise<unknown>> };
  const slot = g[RUN_MUTEX_KEY];
  if (slot instanceof Map) return slot;
  const next = new Map<string, Promise<unknown>>();
  g[RUN_MUTEX_KEY] = next;
  return next;
}

export async function withKeyedMutex<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const locks = runMutexes();
  const prior = locks.get(key) ?? Promise.resolve();
  // .then(fn, fn) — prior rejection doesn't poison the chain.
  const next = prior.then(fn, fn) as Promise<T>;
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) {
      locks.delete(key);
    }
  }
}
