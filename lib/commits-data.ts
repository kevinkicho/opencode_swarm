export type CommitFileChange = {
  path: string;
  added: number;
  removed: number;
  kind: 'added' | 'modified' | 'deleted' | 'renamed';
};

export type CommitActionKind =
  | 'directive'
  | 'thought'
  | 'delegate'
  | 'tool'
  | 'response'
  | 'commit'
  | 'review';

export type CommitAction = {
  id: string;
  timestamp: string;
  kind: CommitActionKind;
  agent: string;
  title: string;
  body?: string;
  toolKind?: 'read' | 'edit' | 'write' | 'bash' | 'grep' | 'glob' | 'webfetch';
  toolTarget?: string;
  tokens?: number;
  cost?: number;
};

// The decomposed facts. Real backend: one row per opencode session that
// touched the commit's window, joined via file.edited + command.executed.
export type TokenBreakdown = {
  in: number;
  out: number;
  cacheRead: number;
  cacheCreation: number;
};

export type CommitSession = {
  id: string;
  agent: string;
  // Structural role. `lead` = orchestrator that spawned others via `task` tool.
  role: 'lead' | 'subagent';
  tokens: TokenBreakdown;
  cost: number;
  // Whether this session's file edits survived into the final commit. False
  // = work was explored then abandoned (rolled back, superseded, dropped).
  shipped: boolean;
};

export type CommitRecord = {
  id: string;
  sha: string;
  title: string;
  summary: string;
  timestamp: string;
  relative: string;
  status: 'success' | 'failure' | 'in_progress';
  duration: string;
  sessions: CommitSession[];
  files: CommitFileChange[];
  actions: CommitAction[];
};

// ---------- derived views ----------

export function tokensTotal(t: TokenBreakdown): number {
  return t.in + t.out + t.cacheRead + t.cacheCreation;
}

export function leadAgent(c: CommitRecord): string {
  return (
    c.sessions.find((s) => s.role === 'lead')?.agent ??
    c.sessions[0]?.agent ??
    'unknown'
  );
}

export function agentCount(c: CommitRecord): number {
  return new Set(c.sessions.map((s) => s.agent)).size;
}

export function aggregateTokens(c: CommitRecord): TokenBreakdown {
  return c.sessions.reduce<TokenBreakdown>(
    (acc, s) => ({
      in: acc.in + s.tokens.in,
      out: acc.out + s.tokens.out,
      cacheRead: acc.cacheRead + s.tokens.cacheRead,
      cacheCreation: acc.cacheCreation + s.tokens.cacheCreation,
    }),
    { in: 0, out: 0, cacheRead: 0, cacheCreation: 0 }
  );
}

export function totalCost(c: CommitRecord): number {
  return c.sessions.reduce((s, x) => s + x.cost, 0);
}

export function shippedTokens(c: CommitRecord): number {
  return c.sessions
    .filter((s) => s.shipped)
    .reduce((t, s) => t + tokensTotal(s.tokens), 0);
}

export function exploredTokens(c: CommitRecord): number {
  return c.sessions
    .filter((s) => !s.shipped)
    .reduce((t, s) => t + tokensTotal(s.tokens), 0);
}

// Rough 30/20/42/8 split — used only for mock data below.
function split(n: number): TokenBreakdown {
  return {
    in: Math.round(n * 0.3),
    out: Math.round(n * 0.2),
    cacheRead: Math.round(n * 0.42),
    cacheCreation: Math.round(n * 0.08),
  };
}

export const commits: CommitRecord[] = [
  {
    id: 'c-2026-04-19-01',
    sha: '8f2a1d4',
    title: 'dedupe Stripe webhook drift under PaymentIntent replays',
    summary:
      'Swarm isolated a replay window where PaymentIntent succeeded fires twice for retried webhooks. Added an idempotency ledger keyed by event.id + payment_intent and re-ran the ingestion test suite.',
    timestamp: '2026-04-19 14:32:04',
    relative: 'in progress',
    status: 'in_progress',
    duration: '12m 14s',
    sessions: [
      { id: 's1a', agent: 'Conductor', role: 'lead', tokens: split(52000), cost: 0.53, shipped: true },
      { id: 's1b', agent: 'Coder α', role: 'subagent', tokens: split(46000), cost: 0.5, shipped: true },
      { id: 's1c', agent: 'Architect', role: 'subagent', tokens: split(32000), cost: 0.32, shipped: true },
      { id: 's1d', agent: 'Warden', role: 'subagent', tokens: split(20000), cost: 0.22, shipped: true },
      { id: 's1e', agent: 'Scout', role: 'subagent', tokens: split(12300), cost: 0.15, shipped: true },
      { id: 's1f', agent: 'Scout', role: 'subagent', tokens: split(22000), cost: 0.15, shipped: false },
    ],
    files: [
      { path: 'services/payments/stripe_webhook.py', added: 38, removed: 12, kind: 'modified' },
      { path: 'services/payments/idempotency_ledger.py', added: 94, removed: 0, kind: 'added' },
      { path: 'services/payments/tests/test_webhook_replay.py', added: 62, removed: 8, kind: 'modified' },
      { path: 'migrations/0142_idempotency_ledger.sql', added: 28, removed: 0, kind: 'added' },
      { path: 'docs/payments/replay-safety.md', added: 14, removed: 2, kind: 'modified' },
    ],
    actions: [
      {
        id: 'a1',
        timestamp: '14:32:04',
        kind: 'directive',
        agent: 'human',
        title: 'investigate duplicate charge reports from support',
        body: 'Three support tickets today - same customers being charged twice. Check Stripe logs, trace the replay path, and patch.',
      },
      {
        id: 'a2',
        timestamp: '14:32:18',
        kind: 'thought',
        agent: 'Conductor',
        title: 'scoping: webhook, DB write path, idempotency',
        body: 'Likely culprit: retry on 5xx response causing the worker to double-insert. Dispatch Scout for log triage, Architect for handler review.',
      },
      {
        id: 'a3',
        timestamp: '14:32:40',
        kind: 'delegate',
        agent: 'Conductor',
        title: 'dispatch Scout pull last 24h of webhook logs',
      },
      {
        id: 'a4',
        timestamp: '14:33:12',
        kind: 'tool',
        agent: 'Scout',
        title: 'fetch Stripe dashboard event list',
        toolKind: 'webfetch',
        toolTarget: 'https://dashboard.stripe.com/events?since=24h',
        tokens: 1840,
        cost: 0.011,
      },
      {
        id: 'a5',
        timestamp: '14:34:02',
        kind: 'response',
        agent: 'Scout',
        title: '22 replayed events in window 3 double-fired',
        body: 'Events evt_3O7...x2 were marked delivered but our endpoint returned 502 once; Stripe retried. Our worker processed both.',
      },
      {
        id: 'a6',
        timestamp: '14:34:20',
        kind: 'delegate',
        agent: 'Conductor',
        title: 'dispatch Architect audit webhook handler',
      },
      {
        id: 'a7',
        timestamp: '14:35:01',
        kind: 'tool',
        agent: 'Architect',
        title: 'read stripe_webhook.py',
        toolKind: 'read',
        toolTarget: 'services/payments/stripe_webhook.py',
      },
      {
        id: 'a8',
        timestamp: '14:35:44',
        kind: 'response',
        agent: 'Architect',
        title: 'handler has no idempotency guard',
        body: 'No check against event.id before insert. Propose adding an idempotency_ledger table keyed by (event_id, payment_intent_id) with a UNIQUE constraint.',
      },
      {
        id: 'a9',
        timestamp: '14:36:10',
        kind: 'delegate',
        agent: 'Conductor',
        title: 'dispatch Coder α implement ledger + guard',
      },
      {
        id: 'a10',
        timestamp: '14:37:30',
        kind: 'tool',
        agent: 'Coder α',
        title: 'write idempotency_ledger.py',
        toolKind: 'write',
        toolTarget: 'services/payments/idempotency_ledger.py',
        tokens: 6240,
        cost: 0.014,
      },
      {
        id: 'a11',
        timestamp: '14:38:12',
        kind: 'tool',
        agent: 'Coder α',
        title: 'write migration 0142',
        toolKind: 'write',
        toolTarget: 'migrations/0142_idempotency_ledger.sql',
      },
      {
        id: 'a12',
        timestamp: '14:38:58',
        kind: 'tool',
        agent: 'Coder α',
        title: 'patch stripe_webhook.py',
        toolKind: 'edit',
        toolTarget: 'services/payments/stripe_webhook.py',
      },
      {
        id: 'a13',
        timestamp: '14:40:14',
        kind: 'tool',
        agent: 'Coder α',
        title: 'run pytest suite',
        toolKind: 'bash',
        toolTarget: 'pytest services/payments/tests/test_webhook_replay.py -x',
      },
      {
        id: 'a14',
        timestamp: '14:41:02',
        kind: 'review',
        agent: 'Warden',
        title: 'verify schema, rollback path, replay test coverage',
        body: 'Migration includes down-path. Replay test now asserts single insert on duplicate event. Handler path looks clean.',
      },
    ],
  },
  {
    id: 'c-2026-04-18-03',
    sha: 'd19c72a',
    title: 'migrate auth middleware to Clerk - remove home-rolled session store',
    summary:
      'Legal flagged the custom session table for not meeting SOC2 token-at-rest requirements. Ripped out the old middleware, routed all session checks through Clerk, updated 14 route handlers.',
    timestamp: '2026-04-18 11:07:22',
    relative: '1 day ago',
    status: 'success',
    duration: '1h 38m',
    sessions: [
      { id: 's2a', agent: 'Conductor', role: 'lead', tokens: split(130000), cost: 1.05, shipped: true },
      { id: 's2b', agent: 'Coder α', role: 'subagent', tokens: split(210000), cost: 1.8, shipped: true },
      { id: 's2c', agent: 'Architect', role: 'subagent', tokens: split(112000), cost: 0.92, shipped: true },
      { id: 's2d', agent: 'Warden', role: 'subagent', tokens: split(60400), cost: 0.45, shipped: true },
    ],
    files: [
      { path: 'middleware/auth.ts', added: 18, removed: 212, kind: 'modified' },
      { path: 'middleware/clerk_adapter.ts', added: 142, removed: 0, kind: 'added' },
      { path: 'middleware/session_store.ts', added: 0, removed: 186, kind: 'deleted' },
      { path: 'routes/api/me.ts', added: 4, removed: 12, kind: 'modified' },
      { path: 'routes/api/teams.ts', added: 6, removed: 14, kind: 'modified' },
      { path: 'routes/api/billing.ts', added: 4, removed: 10, kind: 'modified' },
      { path: 'migrations/0141_drop_sessions.sql', added: 12, removed: 0, kind: 'added' },
      { path: 'docs/auth/clerk-migration.md', added: 48, removed: 0, kind: 'added' },
    ],
    actions: [
      {
        id: 'b1',
        timestamp: '11:07:22',
        kind: 'directive',
        agent: 'human',
        title: 'rip out custom sessions, route everything through Clerk',
      },
      {
        id: 'b2',
        timestamp: '11:07:38',
        kind: 'thought',
        agent: 'Conductor',
        title: 'map all session call sites before ripping',
      },
      {
        id: 'b3',
        timestamp: '11:08:10',
        kind: 'tool',
        agent: 'Architect',
        title: 'grep for session_store import',
        toolKind: 'grep',
        toolTarget: 'session_store',
      },
      {
        id: 'b4',
        timestamp: '11:08:40',
        kind: 'response',
        agent: 'Architect',
        title: '14 call sites across routes/ and middleware/',
      },
      {
        id: 'b5',
        timestamp: '11:10:18',
        kind: 'delegate',
        agent: 'Conductor',
        title: 'dispatch Coder α write Clerk adapter',
      },
      {
        id: 'b6',
        timestamp: '11:18:44',
        kind: 'tool',
        agent: 'Coder α',
        title: 'write clerk_adapter.ts',
        toolKind: 'write',
        toolTarget: 'middleware/clerk_adapter.ts',
      },
      {
        id: 'b7',
        timestamp: '11:32:01',
        kind: 'tool',
        agent: 'Coder α',
        title: 'patch 14 route handlers',
        toolKind: 'edit',
        toolTarget: 'routes/api/*.ts',
      },
      {
        id: 'b8',
        timestamp: '12:01:12',
        kind: 'review',
        agent: 'Warden',
        title: 'verify no session_store references remain',
      },
      {
        id: 'b9',
        timestamp: '12:42:30',
        kind: 'commit',
        agent: 'Conductor',
        title: 'commit d19c72a',
        body: 'migrate auth middleware to Clerk',
      },
    ],
  },
  {
    id: 'c-2026-04-17-02',
    sha: '3b81e0c',
    title: 'wire Grafana latency board for request path',
    summary:
      'Added Prom histogram for middleware latency, dashboard JSON committed, oncall runbook updated. Scout validated the p99 alert fires against synthetic load.',
    timestamp: '2026-04-17 16:45:02',
    relative: '2 days ago',
    status: 'success',
    duration: '42m',
    sessions: [
      { id: 's3a', agent: 'Architect', role: 'lead', tokens: split(52000), cost: 0.38, shipped: true },
      { id: 's3b', agent: 'Coder α', role: 'subagent', tokens: split(68000), cost: 0.46, shipped: true },
      { id: 's3c', agent: 'Scout', role: 'subagent', tokens: split(28200), cost: 0.2, shipped: true },
    ],
    files: [
      { path: 'middleware/metrics.ts', added: 52, removed: 4, kind: 'modified' },
      { path: 'ops/grafana/api-latency.json', added: 284, removed: 0, kind: 'added' },
      { path: 'ops/runbooks/latency-p99.md', added: 36, removed: 8, kind: 'modified' },
    ],
    actions: [
      {
        id: 'd1',
        timestamp: '16:45:02',
        kind: 'directive',
        agent: 'human',
        title: 'wire up the grafana board we sketched last week',
      },
      {
        id: 'd2',
        timestamp: '16:46:11',
        kind: 'tool',
        agent: 'Architect',
        title: 'read existing metrics module',
        toolKind: 'read',
        toolTarget: 'middleware/metrics.ts',
      },
      {
        id: 'd3',
        timestamp: '16:58:20',
        kind: 'tool',
        agent: 'Coder α',
        title: 'add Prom histogram',
        toolKind: 'edit',
        toolTarget: 'middleware/metrics.ts',
      },
      {
        id: 'd4',
        timestamp: '17:04:12',
        kind: 'tool',
        agent: 'Coder α',
        title: 'write Grafana board JSON',
        toolKind: 'write',
        toolTarget: 'ops/grafana/api-latency.json',
      },
      {
        id: 'd5',
        timestamp: '17:18:40',
        kind: 'review',
        agent: 'Scout',
        title: 'synthetic load run alert fired at p99 expected',
      },
      {
        id: 'd6',
        timestamp: '17:27:00',
        kind: 'commit',
        agent: 'Architect',
        title: 'commit 3b81e0c',
      },
    ],
  },
  {
    id: 'c-2026-04-16-04',
    sha: '7ac29f1',
    title: 'dedupe receipt ingestion pipeline - OCR double-run',
    summary:
      'Receipt queue was re-OCRing attachments when the worker restarted mid-batch. Added a checkpoint table and staged the recovery path.',
    timestamp: '2026-04-16 09:22:12',
    relative: '3 days ago',
    status: 'success',
    duration: '2h 14m',
    sessions: [
      { id: 's4a', agent: 'Conductor', role: 'lead', tokens: split(98000), cost: 0.8, shipped: true },
      { id: 's4b', agent: 'Coder α', role: 'subagent', tokens: split(162000), cost: 1.24, shipped: true },
      { id: 's4c', agent: 'Scout', role: 'subagent', tokens: split(62000), cost: 0.52, shipped: true },
      { id: 's4d', agent: 'Warden', role: 'subagent', tokens: split(56400), cost: 0.5, shipped: true },
    ],
    files: [
      { path: 'workers/receipts/ingest.py', added: 88, removed: 34, kind: 'modified' },
      { path: 'workers/receipts/checkpoint.py', added: 112, removed: 0, kind: 'added' },
      { path: 'migrations/0140_ingest_checkpoints.sql', added: 22, removed: 0, kind: 'added' },
    ],
    actions: [
      {
        id: 'e1',
        timestamp: '09:22:12',
        kind: 'directive',
        agent: 'human',
        title: 'OCR cost doubled last week - fix the re-run bug',
      },
      {
        id: 'e2',
        timestamp: '09:23:04',
        kind: 'tool',
        agent: 'Scout',
        title: 'pull last worker restart event',
        toolKind: 'webfetch',
        toolTarget: 'https://grafana.internal/d/workers/restarts',
      },
      {
        id: 'e3',
        timestamp: '09:34:50',
        kind: 'tool',
        agent: 'Coder α',
        title: 'write checkpoint.py',
        toolKind: 'write',
        toolTarget: 'workers/receipts/checkpoint.py',
      },
      {
        id: 'e4',
        timestamp: '10:48:22',
        kind: 'review',
        agent: 'Warden',
        title: 'verify checkpoint survives SIGTERM',
      },
      {
        id: 'e5',
        timestamp: '11:36:08',
        kind: 'commit',
        agent: 'Conductor',
        title: 'commit 7ac29f1',
      },
    ],
  },
  {
    id: 'c-2026-04-15-01',
    sha: 'f04a8b9',
    title: 'rollback: partial index on events table caused planner flip',
    summary:
      'Attempted to add a partial index to speed up dashboard queries. PG15 planner chose a worse path for the hot write query. Rolled back before shipping.',
    timestamp: '2026-04-15 21:11:03',
    relative: '4 days ago',
    status: 'failure',
    duration: '38m',
    sessions: [
      { id: 's5a', agent: 'Architect', role: 'lead', tokens: split(40000), cost: 0.28, shipped: true },
      { id: 's5b', agent: 'Coder α', role: 'subagent', tokens: split(16000), cost: 0.14, shipped: true },
      { id: 's5c', agent: 'Coder α', role: 'subagent', tokens: split(40200), cost: 0.3, shipped: false },
    ],
    files: [
      { path: 'migrations/0139_events_partial_idx.sql', added: 14, removed: 0, kind: 'added' },
      { path: 'migrations/0139_events_partial_idx_rollback.sql', added: 6, removed: 0, kind: 'added' },
    ],
    actions: [
      {
        id: 'f1',
        timestamp: '21:11:03',
        kind: 'directive',
        agent: 'human',
        title: 'dashboard query is hot - try partial index',
      },
      {
        id: 'f2',
        timestamp: '21:22:40',
        kind: 'tool',
        agent: 'Coder α',
        title: 'write migration 0139',
        toolKind: 'write',
        toolTarget: 'migrations/0139_events_partial_idx.sql',
      },
      {
        id: 'f3',
        timestamp: '21:34:11',
        kind: 'review',
        agent: 'Warden',
        title: 'explain analyze shows hot-write regressed 3.4x',
      },
      {
        id: 'f4',
        timestamp: '21:41:58',
        kind: 'response',
        agent: 'Architect',
        title: 'rollback: planner chose seq scan on INSERT path',
      },
      {
        id: 'f5',
        timestamp: '21:49:20',
        kind: 'commit',
        agent: 'Architect',
        title: 'commit f04a8b9 rollback landed',
      },
    ],
  },
];
