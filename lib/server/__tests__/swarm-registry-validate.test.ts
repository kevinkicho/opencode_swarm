// HARDENING_PLAN.md#R7 — JSON.parse on disk validators.
//
// Tests for `lib/server/swarm-registry-validate.ts` (TO BE WRITTEN as
// part of R7). swarm-registry.ts:249 currently casts
// `JSON.parse(raw) as SwarmRunMeta` with no runtime check. A truncated
// or hand-edited meta.json passes the cast and propagates undefined
// fields into every consumer.
//
// Status: scaffold. Un-skip once the validator module ships.

import { describe } from 'vitest';

describe.skip('swarm-registry · validateSwarmRunMeta (R7 — to be implemented)', () => {
  // Recipe:
  //
  //   import { validateSwarmRunMeta, validateSwarmRunEvent } from '../swarm-registry-validate';

  // === Happy-path ===
  //
  // it('accepts a fully-populated meta');
  // it('accepts a meta with optional fields omitted');

  // === Required-field checks ===
  //
  // it('rejects meta missing swarmRunID');
  // it('rejects meta missing pattern');
  // it('rejects meta missing workspace');
  // it('rejects meta missing sessionIDs');
  // it('rejects meta with sessionIDs not an array');
  // it('rejects meta with createdAt not a number');

  // === Event validation ===
  //
  // it('accepts a well-formed event row');
  // it('rejects an event missing eventType');
  // it('rejects an event with non-string sessionID');

  // === Memory union discriminator ===
  //
  // it('validateMemoryPayload routes AgentRollup vs RunRetro by kind');
  // it('rejects a memory payload missing kind');
});
