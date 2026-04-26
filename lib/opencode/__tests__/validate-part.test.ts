// HARDENING_PLAN.md#R2 — SDK schema-drift firewall.
//
// Tests for `lib/opencode/validate-part.ts` (TO BE WRITTEN as part of R2).
// The validator's contract: given an opaque opencode message-part shape,
// return either { ok: true; part } or { ok: false; reason; raw } and
// emit a one-time console.warn so unknown shapes show up in dev logs
// instead of silently passing through.
//
// Status: scaffold. Un-skip the describe block once `validate-part.ts`
// exists. The test names below are the contract.

import { describe } from 'vitest';

describe.skip('opencode · validatePart (R2 — to be implemented)', () => {
  // Recipe (paste once validate-part.ts ships):
  //
  //   import { validatePart } from '../validate-part';
  //   import { describe, it, expect, vi, beforeEach } from 'vitest';

  // === Happy-path: known shapes pass ===
  //
  // it('accepts a well-formed text part');
  // it('accepts a well-formed tool part with state and tool fields');
  // it('accepts a well-formed reasoning part');
  // it('accepts a well-formed patch part with files array');
  // it('accepts step-start and step-finish parts');

  // === Drift detection: unknown shapes fail ===
  //
  // it('rejects a part with unknown type field');
  // it('rejects a tool part missing the tool field');
  // it('rejects a tool part missing the state field');
  // it('rejects a part with type=undefined');
  // it('rejects null');
  // it('rejects a non-object payload');

  // === Logging contract ===
  //
  // it('emits console.warn exactly once per unique drift signature');
  // it('reuses warn cache across parts with the same drift shape');
  // it('reason field describes what was missing or unrecognized');

  // === Q34/Q42 firewall scenarios ===
  //
  // it('rejects a text part whose body looks like a fake tool call');
  // it('rejects a tool part whose tool field is the empty string');
});
