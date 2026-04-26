// HARDENING_PLAN.md#D1 — meta.json atomic-rename writes.
//
// Tests for `lib/server/atomic-write.ts` (TO BE WRITTEN as part of D1).
// `fs.writeFile` is NOT crash-atomic — O_TRUNC happens before the first
// byte is written. SIGKILL between truncate and write leaves a 0-byte
// file. A wrapper that writes to a tmp file then renames into place is
// crash-safe on POSIX.
//
// Status: scaffold. Un-skip once atomic-write.ts ships.

import { describe } from 'vitest';

describe.skip('server · atomicWriteFile (D1 — to be implemented)', () => {
  // Recipe:
  //
  //   import { atomicWriteFile } from '../atomic-write';
  //   import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
  //   import { tmpdir } from 'node:os';
  //   import { join } from 'node:path';

  // === Happy-path ===
  //
  // it('writes content and the result is readable');
  // it('overwrites an existing file with the new content');
  // it('cleans up the .tmp file on success');

  // === Crash safety ===
  //
  // it('a SIGKILL during write leaves either the old or the new file (never 0-byte)');
  //   - We can simulate by writing to a tmp path that doesn't get renamed,
  //     then asserting the destination still has the previous content.
  // it('a write failure leaves the destination file untouched');
  // it('the .tmp file is removed even when rename fails');

  // === Concurrency ===
  //
  // it('two concurrent atomicWriteFile calls each produce a complete file');
  //   - Last writer wins (no merge). The point is no torn files.

  // === Per-key mutex helper ===
  //
  // it('withRunMutex serializes concurrent updates to the same swarmRunID');
  // it('withRunMutex does not block updates to a different swarmRunID');
});
