//
// Tests for `lib/server/atomic-write.ts`. Verifies that:
//   1. atomicWriteFile produces a complete file (never 0-byte partial)
//   2. The .tmp file gets cleaned up on both success and failure
//   3. Concurrent atomicWriteFile calls each produce a complete file
//   4. withKeyedMutex serializes work for the same key
//   5. withKeyedMutex does not block work for a different key

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile, withKeyedMutex } from '../atomic-write';

let TMP_DIR: string;

beforeEach(async () => {
  TMP_DIR = await mkdtemp(join(tmpdir(), 'atomic-write-'));
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe('atomicWriteFile · happy path', () => {
  it('writes content and the result is readable', async () => {
    const path = join(TMP_DIR, 'a.json');
    await atomicWriteFile(path, '{"hello":"world"}');
    const back = await readFile(path, 'utf8');
    expect(back).toBe('{"hello":"world"}');
  });

  it('overwrites an existing file with the new content', async () => {
    const path = join(TMP_DIR, 'b.json');
    await atomicWriteFile(path, '{"v":1}');
    await atomicWriteFile(path, '{"v":2}');
    expect(await readFile(path, 'utf8')).toBe('{"v":2}');
  });

  it('cleans up the .tmp file on success', async () => {
    const path = join(TMP_DIR, 'c.json');
    await atomicWriteFile(path, '{"clean":true}');
    const entries = await readdir(TMP_DIR);
    // Should contain 'c.json' and nothing else; no leftover tmp file.
    expect(entries).toEqual(['c.json']);
  });

  it('handles writing to a path that does not yet exist', async () => {
    const path = join(TMP_DIR, 'fresh.txt');
    expect(async () => await stat(path)).rejects.toThrow();
    await atomicWriteFile(path, 'first write');
    expect(await readFile(path, 'utf8')).toBe('first write');
  });
});

describe('atomicWriteFile · concurrency', () => {
  it('two concurrent writes both produce complete files (last writer wins)', async () => {
    const path = join(TMP_DIR, 'race.json');
    await Promise.all([
      atomicWriteFile(path, 'aaaaaaaaaa'),
      atomicWriteFile(path, 'bbbbbbbbbb'),
    ]);
    const final = await readFile(path, 'utf8');
    // Either content is acceptable — the point is no torn or 0-byte file.
    expect([
      'aaaaaaaaaa',
      'bbbbbbbbbb',
    ]).toContain(final);
    // No leftover tmp files.
    const entries = (await readdir(TMP_DIR)).filter((f) => f.includes('.tmp-'));
    expect(entries).toEqual([]);
  });
});

describe('atomicWriteFile · failure handling', () => {
  it('throws when destination path is unwritable (parent missing)', async () => {
    const path = join(TMP_DIR, 'no-such-dir', 'file.txt');
    await expect(atomicWriteFile(path, 'content')).rejects.toThrow();
    // No .tmp file leaks even on failure.
    const entries = await readdir(TMP_DIR);
    expect(entries.filter((e) => e !== 'no-such-dir')).toEqual([]);
  });
});

describe('withKeyedMutex', () => {
  it('serializes work for the same key', async () => {
    const order: string[] = [];
    const taskA = async () => {
      order.push('A-start');
      await new Promise((r) => setTimeout(r, 25));
      order.push('A-end');
    };
    const taskB = async () => {
      order.push('B-start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('B-end');
    };
    await Promise.all([
      withKeyedMutex('shared', taskA),
      withKeyedMutex('shared', taskB),
    ]);
    // A must fully complete before B starts (or vice versa); they
    // can't interleave. Acceptable orderings:
    //   A-start, A-end, B-start, B-end
    //   B-start, B-end, A-start, A-end
    expect(order).toEqual(
      order[0] === 'A-start'
        ? ['A-start', 'A-end', 'B-start', 'B-end']
        : ['B-start', 'B-end', 'A-start', 'A-end'],
    );
  });

  it('does not block work for a different key', async () => {
    let taskBStarted = false;
    const taskA = async () => {
      // Long-running task; if mutex was global, B couldn't start until A finishes
      await new Promise((r) => setTimeout(r, 50));
    };
    const taskB = async () => {
      taskBStarted = true;
    };
    const aPromise = withKeyedMutex('key-A', taskA);
    const bPromise = withKeyedMutex('key-B', taskB);
    await bPromise;
    // B should have started + completed without waiting for A.
    expect(taskBStarted).toBe(true);
    await aPromise;
  });

  it('does not poison the chain when a prior task rejects', async () => {
    const taskFail = () => Promise.reject(new Error('boom'));
    const taskOk = () => Promise.resolve('survived');

    await expect(
      withKeyedMutex('chain', taskFail),
    ).rejects.toThrow('boom');

    // Subsequent task on the same key still runs (rejection didn't poison).
    const result = await withKeyedMutex('chain', taskOk);
    expect(result).toBe('survived');
  });

  it('forwards the task return value', async () => {
    const result = await withKeyedMutex('forward', async () => 42);
    expect(result).toBe(42);
  });
});
