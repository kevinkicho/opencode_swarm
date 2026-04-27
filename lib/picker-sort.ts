// Sort contract for the swarm-runs picker.
//
// Extracted from components/swarm-runs-picker.tsx so the ordering can be
// pinned by tests. Two rules, in priority order:
//
//   1. Bucket by liveness: live (0) → idle (1) → everything else (2).
//      The "alive" cluster is what the user wants to see first when
//      scanning ("how many runs are still attached to compute?").
//   2. Within bucket: newest first by createdAt — so today's runs sit
//      above yesterday's residue regardless of status.
//
// The createdAt key is immutable across polls (set at run-create time),
// so the order is stable even when the upstream /api/swarm/run endpoint
// returns rows in arbitrary order. That stability matters because
// opencode's session-list endpoint has documented order drift between
// polls (see memory `reference_opencode_session_order`).

import type { SwarmRunListRow } from '@/lib/swarm-run-types';

/**
 * Returns a new array with rows ordered by (alive-bucket, createdAt desc).
 * Does not mutate the input. Pure.
 */
export function sortRunsForPicker(rows: SwarmRunListRow[]): SwarmRunListRow[] {
  return [...rows].sort((a, b) => {
    const aBucket = a.status === 'live' ? 0 : a.status === 'idle' ? 1 : 2;
    const bBucket = b.status === 'live' ? 0 : b.status === 'idle' ? 1 : 2;
    if (aBucket !== bBucket) return aBucket - bBucket;
    return b.meta.createdAt - a.meta.createdAt;
  });
}
