//
// `mintItemId` was originally inside planner.ts. degraded-completion.ts
// imported it; planner.ts in turn imported recordPartialOutcome from
// degraded-completion. Cycle.
//
// Extracted to this leaf module so both planner.ts and
// degraded-completion.ts depend on it instead of each other.

import 'server-only';

import { randomBytes } from 'node:crypto';

// Mint matches the format used by POST /board (t_ + 8 hex chars).
// Collision probability is ~10^-10 per run — adequate for prototype
// scale, matched against a (run_id, id) UNIQUE constraint in SQL so
// conflicts surface. Used by planner.ts when seeding from sweep + by
// other pattern orchestrators (deliberate-execute) when seeding the
// board from their own synthesis paths.
export function mintItemId(): string {
  return 't_' + randomBytes(4).toString('hex');
}
