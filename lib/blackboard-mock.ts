// Mock data for the /board-preview standalone route. The types themselves now
// live in lib/blackboard/types.ts — re-exported here so the existing import
// path (`@/lib/blackboard-mock`) keeps working while the preview is still the
// sole consumer. Delete this file when the preview is replaced by the live
// view over the real store at lib/server/blackboard/*.

export type {
  BoardItemKind,
  BoardItemStatus,
  BoardAgent,
  BoardItem,
} from './blackboard/types';

import type { BoardAgent, BoardItem } from './blackboard/types';

export const MOCK_AGENTS: BoardAgent[] = [
  { id: 'ag_zed',    name: 'zed',    accent: 'molten', glyph: 'Z' },
  { id: 'ag_qo',     name: 'qo',     accent: 'mint',   glyph: 'Q' },
  { id: 'ag_rhea',   name: 'rhea',   accent: 'iris',   glyph: 'R' },
  { id: 'ag_lyra',   name: 'lyra',   accent: 'amber',  glyph: 'L' },
];

const now = 1776822500000;
const mins = (n: number) => now - n * 60_000;

export const MOCK_BOARD: BoardItem[] = [
  // Open todos — nobody claimed yet. In a real run these would have arrived
  // from the initial planner sweep; any idle agent can pick them up.
  {
    id: 't_001',
    kind: 'todo',
    content: 'extract JSON parser into lib/json/parse.ts',
    status: 'open',
    createdAtMs: mins(14),
  },
  {
    id: 't_002',
    kind: 'todo',
    content: 'replace manual retry loop in workers/queue.ts with withRetry()',
    status: 'open',
    createdAtMs: mins(14),
  },
  {
    id: 't_003',
    kind: 'question',
    content: 'does the new ingest schema allow null source_ref, or do we default?',
    status: 'open',
    createdAtMs: mins(9),
    ownerAgentId: 'ag_rhea', // whoever asked
    note: 'posted from t_006',
  },

  // Claimed — owner declared intent, recorded SHAs, hasn't produced output yet.
  {
    id: 't_004',
    kind: 'claim',
    content: 'reshape Session.time into {created, updated, completed?} triple',
    status: 'claimed',
    ownerAgentId: 'ag_qo',
    fileHashes: [
      { path: 'lib/opencode/types.ts',  sha: 'a3f88d1' },
      { path: 'lib/opencode/live.ts',   sha: '77b0c2e' },
    ],
    createdAtMs: mins(8),
  },

  // In-progress — active work. Each shows the touching hashes.
  {
    id: 't_005',
    kind: 'todo',
    content: 'add staleness threshold to useLiveSession zombie check',
    status: 'in-progress',
    ownerAgentId: 'ag_zed',
    fileHashes: [
      { path: 'lib/opencode/live.ts', sha: '77b0c2e' },
    ],
    createdAtMs: mins(11),
  },
  {
    id: 't_006',
    kind: 'todo',
    content: 'normalize ingest payload from source_ref / source_id variants',
    status: 'blocked',
    ownerAgentId: 'ag_rhea',
    fileHashes: [
      { path: 'workers/ingest.ts',    sha: '5c41aa9' },
    ],
    note: 'blocked on t_003 (schema question)',
    createdAtMs: mins(10),
  },

  // Stale — CAS rejection. The lib/opencode/live.ts SHA the original claim
  // snapshotted has drifted because t_005 committed first; t_007 goes back on
  // the board with staleSinceSha tagged.
  {
    id: 't_007',
    kind: 'todo',
    content: 'wire swarm-run directive retry onto useLiveSession reconnect',
    status: 'stale',
    ownerAgentId: 'ag_lyra',
    fileHashes: [
      { path: 'lib/opencode/live.ts', sha: '77b0c2e' },
    ],
    staleSinceSha: 'd8e10c4',
    createdAtMs: mins(12),
    note: 'live.ts moved under claim — replan before reclaim',
  },

  // Done — completed findings + completed todos.
  {
    id: 't_008',
    kind: 'finding',
    content: 'retry tool call body is idempotent — drop the guard in queue.ts:88',
    status: 'done',
    ownerAgentId: 'ag_zed',
    createdAtMs: mins(22),
    completedAtMs: mins(19),
  },
  {
    id: 't_009',
    kind: 'todo',
    content: 'strip trailing whitespace from swarm-run title before persist',
    status: 'done',
    ownerAgentId: 'ag_qo',
    fileHashes: [
      { path: 'app/api/swarm/run/route.ts', sha: '2e71103' },
    ],
    createdAtMs: mins(30),
    completedAtMs: mins(18),
  },
  {
    id: 't_010',
    kind: 'finding',
    content: 'agentIdFor now sessionID-keyed — no more council name collisions',
    status: 'done',
    ownerAgentId: 'ag_lyra',
    createdAtMs: mins(25),
    completedAtMs: mins(16),
  },
];
