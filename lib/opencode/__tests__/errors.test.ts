// HARDENING_PLAN.md#R4 — typed Opencode errors.
//
// Tests for `lib/opencode/errors.ts` (TO BE WRITTEN as part of R4). The
// existing pattern (`throw new Error('opencode ... -> HTTP ${status}')`)
// forces consumers to substring-match the message to decide retry vs
// abort (`coordinator/wait.ts`, `critic-loop.ts:526-530`). Typed errors
// replace the string-match with `instanceof` checks.
//
// Status: scaffold. Un-skip once errors.ts ships.

import { describe } from 'vitest';

describe.skip('opencode · typed errors (R4 — to be implemented)', () => {
  // Recipe:
  //
  //   import {
  //     OpencodeUnreachableError,
  //     OpencodeHttpError,
  //     OpencodeTimeoutError,
  //   } from '../errors';

  // === OpencodeHttpError ===
  //
  // it('exposes status, path, body on the instance');
  // it('extends Error and is catch-able as Error');
  // it('instanceof OpencodeHttpError matches');
  // it('toString includes status and path');

  // === OpencodeTimeoutError ===
  //
  // it('exposes deadline and elapsed-ms on the instance');
  // it('does NOT match instanceof OpencodeHttpError');

  // === OpencodeUnreachableError ===
  //
  // it('exposes the URL and underlying network reason');
  // it('used when the fetch throws (ECONNREFUSED / ENOTFOUND)');

  // === Consumer migration sanity ===
  //
  // it('coordinator/wait.ts retry decision uses instanceof, not includes()');
  //   - this is a lint-style check that grep'ing for "includes('timed out')"
  //     in lib/server/blackboard/coordinator/ returns zero hits.
});
