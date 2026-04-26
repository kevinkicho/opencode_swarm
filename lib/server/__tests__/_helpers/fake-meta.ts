// fakeMeta — sensible-default SwarmRunMeta builder for tests.
//
// Centralized in _helpers/ as part of #111 so tests don't redeclare
// the shape every time. The defaults are deliberately minimal — just
// enough fields to satisfy the type system; tests override what they
// care about.

import type { SwarmRunMeta } from '../../../swarm-run-types';

export function fakeMeta(overrides: Partial<SwarmRunMeta> = {}): SwarmRunMeta {
  return {
    swarmRunID: 'run_test_x',
    pattern: 'critic-loop',
    workspace: '/tmp/x',
    sessionIDs: ['s1', 's2'],
    createdAt: 0,
    title: 't',
    teamModels: [],
    ...overrides,
  } as SwarmRunMeta;
}
