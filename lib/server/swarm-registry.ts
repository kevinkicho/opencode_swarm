// HARDENING_PLAN.md#W5.1 — fs/derive split.
//
// Backward-compat barrel. The implementation lives in:
//   - ./swarm-registry/fs.ts     — persistence (createRun / getRun /
//     listRuns / updateRunMeta / appendEvent / readEvents /
//     findRunBySession). Heavy node:fs deps; touches the disk layout
//     under .opencode_swarm/runs/.
//   - ./swarm-registry/derive.ts — opencode-bound liveness + tokens
//     derivation (deriveRunRow / deriveRunTokens / deriveRunRowCached).
//     Imports opencode-server lazily so routes that only need fs ops
//     don't drag the ~1100-module opencode chain into their compile.
//
// Pre-W5.1 the two halves lived together in a 996-LOC file that was
// hard to navigate. The split keeps the import-graph clean (fs.ts ←
// derive.ts is one-way; derive never depends on fs) and lets future
// readers find what they need without scrolling past unrelated code.
//
// Callers should import from this barrel — it preserves the existing
// `from '@/lib/server/swarm-registry'` path for ~33 import sites
// across routes, server modules, and tests.

import 'server-only';

export {
  createRun,
  getRun,
  listRuns,
  updateRunMeta,
  appendEvent,
  readEvents,
  findRunBySession,
} from './swarm-registry/fs';

export {
  deriveRunRow,
  deriveRunRowCached,
  deriveRunTokens,
  invalidateDerivedRow,
} from './swarm-registry/derive';

export type {
  DerivedRow,
  RunTokensBreakdown,
} from './swarm-registry/derive';
