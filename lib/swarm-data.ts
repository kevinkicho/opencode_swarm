// Honest mock session built from real opencode Parts and Tools.
// Cross-lane events = task-tool delegations and subtask/text returns.
// In-lane events  = reasoning, tool calls, patches, step markers, compaction.

import type {
  Agent,
  AgentMessage,
  RunMeta,
  ProviderSummary,
  TodoItem,
} from './swarm-types';

export const runMeta: RunMeta = {
  id: 'run_a19c',
  title: 'audit + remediate stripe webhook drift',
  status: 'active',
  started: '14:22 Apr 19',
  elapsed: '3m 42s',
  totalTokens: 68_420,
  totalCost: 0.87,
  budgetCap: 5.0,
  goTier: { window: '5h', used: 2.41, cap: 12.0 },
  cwd: '~/projects/aperture-web',
};

export const agents: Agent[] = [
  {
    id: 'ag_orch',
    name: 'primary',
    role: 'orchestrator',
    model: {
      id: 'opencode/claude-opus-4-7',
      label: 'claude-opus-4-7',
      provider: 'zen',
      family: 'claude',
      pricing: { input: 5, output: 25 },
    },
    status: 'thinking',
    currentTask: 'coordinating sub-agents via task tool',
    tokensUsed: 18_140,
    tokensBudget: 80_000,
    costUsed: 0.48,
    messagesSent: 5,
    messagesRecv: 4,
    accent: 'molten',
    glyph: 'P',
    tools: ['task', 'read', 'todowrite', 'todoread'],
  },
  {
    id: 'ag_arch',
    name: 'architect',
    role: 'architect',
    model: {
      id: 'opencode/claude-sonnet-4-6',
      label: 'claude-sonnet-4-6',
      provider: 'zen',
      family: 'claude',
      pricing: { input: 3, output: 15 },
    },
    status: 'done',
    currentTask: 'mapped webhook handler surface',
    tokensUsed: 14_900,
    tokensBudget: 60_000,
    costUsed: 0.21,
    messagesSent: 1,
    messagesRecv: 1,
    accent: 'iris',
    glyph: 'A',
    tools: ['read', 'grep', 'glob', 'list'],
  },
  {
    id: 'ag_coder',
    name: 'coder',
    role: 'coder',
    model: {
      id: 'opencode/qwen3.6-plus',
      label: 'qwen3.6-plus',
      provider: 'go',
      family: 'qwen',
      pricing: { input: 0.5, output: 3 },
      limitTag: 'go 5h $12',
    },
    status: 'working',
    currentTask: 'patching idempotency guard',
    tokensUsed: 28_220,
    tokensBudget: 120_000,
    costUsed: 0.12,
    messagesSent: 2,
    messagesRecv: 2,
    accent: 'mint',
    glyph: 'C',
    tools: ['read', 'edit', 'write', 'bash', 'grep'],
  },
  {
    id: 'ag_review',
    name: 'reviewer',
    role: 'reviewer',
    model: {
      id: 'opencode/claude-haiku-4-5',
      label: 'claude-haiku-4-5',
      provider: 'zen',
      family: 'claude',
      pricing: { input: 1, output: 5 },
    },
    status: 'idle',
    currentTask: 'standing by for diff review',
    tokensUsed: 7_160,
    tokensBudget: 40_000,
    costUsed: 0.06,
    messagesSent: 1,
    messagesRecv: 1,
    accent: 'fog',
    glyph: 'R',
    tools: ['read', 'grep'],
  },
];

export const agentOrder = ['ag_orch', 'ag_arch', 'ag_coder', 'ag_review'];

// Run plan — swarm's shared todo list, app-layer bound to task delegations.
// See DESIGN.md §8. todoID is app-minted; taskMessageId points into `messages`.
export const runPlan: TodoItem[] = [
  {
    id: 'tdo_01',
    content: 'map webhook handler surface',
    status: 'completed',
    ownerAgentId: 'ag_arch',
    taskMessageId: 'm03',
  },
  {
    id: 'tdo_02',
    content: 'identify dedupe key drift root cause',
    status: 'completed',
    ownerAgentId: 'ag_arch',
    note: 'v2024-08-01 contract change missed',
  },
  {
    id: 'tdo_03',
    content: 'patch idempotency key fallback',
    status: 'in_progress',
    ownerAgentId: 'ag_coder',
    taskMessageId: 'm07',
  },
  {
    id: 'tdo_04',
    content: 'add regression test for drift detection',
    status: 'pending',
    ownerAgentId: 'ag_coder',
  },
  {
    id: 'tdo_05',
    content: 'review diff + sign off',
    status: 'completed',
    ownerAgentId: 'ag_review',
    taskMessageId: 'm17',
  },
  {
    id: 'tdo_06',
    content: 'update runbook + changelog',
    status: 'pending',
  },
];

export const providerSummary: ProviderSummary[] = [
  { provider: 'zen', agents: 3, tokens: 40_200, cost: 0.75, hint: 'premium routing' },
  { provider: 'go', agents: 1, tokens: 28_220, cost: 0.12, hint: '5h tier $11.88 left' },
  { provider: 'byok', agents: 0, tokens: 0, cost: 0, hint: 'bring-your-own disabled' },
];

export const messages: AgentMessage[] = [
  // 1. human prompt -> orchestrator (text part, cross-lane)
  {
    id: 'm01',
    fromAgentId: 'human',
    toAgentIds: ['ag_orch'],
    part: 'text',
    title: 'run brief',
    body:
      'webhook deliveries from stripe are being double-processed after our retry upgrade. audit the handler path, find the drift, patch + verify. budget $5, ship under 10 minutes.',
    timestamp: '00:00',
    status: 'complete',
  },

  // 2. orchestrator reasoning (in-lane chip)
  {
    id: 'm02',
    fromAgentId: 'ag_orch',
    toAgentIds: ['ag_orch'],
    part: 'reasoning',
    title: 'plan the dispatch',
    body:
      'two phases: map the handler (architect) then patch + test (coder). review gates before ship.',
    timestamp: '00:03',
    tokens: 820,
    duration: '1.1s',
    status: 'complete',
  },

  // 3. orchestrator calls task tool -> spawns architect (cross-lane)
  {
    id: 'm03',
    fromAgentId: 'ag_orch',
    toAgentIds: ['ag_arch'],
    part: 'tool',
    toolName: 'task',
    toolState: 'completed',
    title: 'delegate: map webhook handler',
    toolSubtitle: 'task(subagent=architect, prompt="find the dedupe drift")',
    timestamp: '00:05',
    tokens: 1240,
    cost: 0.02,
    duration: '0.4s',
    status: 'complete',
    threadId: 't_arch',
  },

  // 4. architect grep in-lane
  {
    id: 'm04',
    fromAgentId: 'ag_arch',
    toAgentIds: ['ag_arch'],
    part: 'tool',
    toolName: 'grep',
    toolState: 'completed',
    title: 'grep',
    toolSubtitle: "'stripe.webhook' src/**",
    toolPreview: '6 call sites, 2 dedupe paths',
    timestamp: '00:11',
    tokens: 1120,
    duration: '41ms',
    status: 'complete',
    threadId: 't_arch',
  },

  // 5. architect read in-lane
  {
    id: 'm05',
    fromAgentId: 'ag_arch',
    toAgentIds: ['ag_arch'],
    part: 'tool',
    toolName: 'read',
    toolState: 'completed',
    title: 'read',
    toolSubtitle: 'src/api/webhooks/stripe/route.ts',
    toolPreview: '142 lines. dedupe at L61 keyed by event.id',
    timestamp: '00:18',
    tokens: 3420,
    duration: '9ms',
    status: 'complete',
    threadId: 't_arch',
  },

  // 6. architect returns subtask part (cross-lane back to orchestrator)
  {
    id: 'm06',
    fromAgentId: 'ag_arch',
    toAgentIds: ['ag_orch'],
    part: 'subtask',
    title: 'handler map complete',
    body:
      'single entry at /api/webhooks/stripe. dedupe table keyed by event.id - stripe recommends event.request.idempotency_key for retries. that is the drift.',
    timestamp: '00:51',
    tokens: 4280,
    cost: 0.06,
    duration: '33s',
    status: 'complete',
    threadId: 't_arch',
    relatesTo: 'm03',
  },

  // 7. orchestrator calls task tool -> coder
  {
    id: 'm07',
    fromAgentId: 'ag_orch',
    toAgentIds: ['ag_coder'],
    part: 'tool',
    toolName: 'task',
    toolState: 'running',
    title: 'delegate: patch dedupe key',
    toolSubtitle:
      'task(subagent=coder, prompt="swap to event.request.idempotency_key with event.id fallback")',
    timestamp: '01:04',
    tokens: 1180,
    cost: 0.02,
    duration: '0.3s',
    status: 'running',
    threadId: 't_coder',
    relatesTo: 'm06',
  },

  // 8. coder reads
  {
    id: 'm08',
    fromAgentId: 'ag_coder',
    toAgentIds: ['ag_coder'],
    part: 'tool',
    toolName: 'read',
    toolState: 'completed',
    title: 'read',
    toolSubtitle: 'src/api/webhooks/stripe/route.ts',
    toolPreview: '142 lines dedupe at L61',
    timestamp: '01:14',
    tokens: 3420,
    duration: '9ms',
    status: 'complete',
    threadId: 't_coder',
  },

  // 9. coder edit
  {
    id: 'm09',
    fromAgentId: 'ag_coder',
    toAgentIds: ['ag_coder'],
    part: 'tool',
    toolName: 'edit',
    toolState: 'completed',
    title: 'edit',
    toolSubtitle: 'src/api/webhooks/stripe/route.ts',
    toolPreview: '+6 -3 nullish fallback for idempotency key',
    timestamp: '01:34',
    tokens: 5820,
    duration: '0.7s',
    status: 'complete',
    threadId: 't_coder',
  },

  // 10. patch part (captures the diff)
  {
    id: 'm10',
    fromAgentId: 'ag_coder',
    toAgentIds: ['ag_coder'],
    part: 'patch',
    title: 'patch: route.ts',
    toolPreview: '+6 -3 src/api/webhooks/stripe/route.ts',
    body: 'fallback chain: event.request.idempotency_key ?? event.id',
    timestamp: '01:36',
    status: 'complete',
    threadId: 't_coder',
  },

  // 11. coder bash (fails)
  {
    id: 'm11',
    fromAgentId: 'ag_coder',
    toAgentIds: ['ag_coder'],
    part: 'tool',
    toolName: 'bash',
    toolState: 'error',
    title: 'bash',
    toolSubtitle: 'pnpm test webhooks',
    toolPreview: '1 failed: dedupe test expects event.id',
    timestamp: '02:08',
    tokens: 2100,
    duration: '6.1s',
    status: 'error',
    threadId: 't_coder',
  },

  // 12. permission ask - edit a test file
  {
    id: 'm12',
    fromAgentId: 'ag_coder',
    toAgentIds: ['human'],
    part: 'tool',
    toolName: 'edit',
    toolState: 'pending',
    title: 'permission: edit test file',
    toolSubtitle: 'src/api/webhooks/stripe/route.test.ts',
    body:
      'the test codifies the old key assumption. request approval to rewrite the assertion + add the fallback case.',
    timestamp: '02:18',
    status: 'pending',
    threadId: 't_coder',
    permission: { tool: 'edit', state: 'asked' },
  },

  // 13. permission reply - approved
  {
    id: 'm13',
    fromAgentId: 'human',
    toAgentIds: ['ag_coder'],
    part: 'text',
    title: 'approve edit',
    body: 'approved - update the test.',
    timestamp: '02:24',
    status: 'complete',
    threadId: 't_coder',
    relatesTo: 'm12',
    permission: { tool: 'edit', state: 'approved' },
  },

  // 14. coder edits test
  {
    id: 'm14',
    fromAgentId: 'ag_coder',
    toAgentIds: ['ag_coder'],
    part: 'tool',
    toolName: 'edit',
    toolState: 'completed',
    title: 'edit',
    toolSubtitle: 'src/api/webhooks/stripe/route.test.ts',
    toolPreview: '+18 -4 dual-case dedupe assertion',
    timestamp: '02:41',
    tokens: 4420,
    duration: '0.6s',
    status: 'complete',
    threadId: 't_coder',
  },

  // 15. coder runs tests - green
  {
    id: 'm15',
    fromAgentId: 'ag_coder',
    toAgentIds: ['ag_coder'],
    part: 'tool',
    toolName: 'bash',
    toolState: 'completed',
    title: 'bash',
    toolSubtitle: 'pnpm test webhooks',
    toolPreview: '4 passed, 0 failed',
    timestamp: '03:02',
    tokens: 1980,
    duration: '5.8s',
    status: 'complete',
    threadId: 't_coder',
  },

  // 16. coder returns subtask part
  {
    id: 'm16',
    fromAgentId: 'ag_coder',
    toAgentIds: ['ag_orch'],
    part: 'subtask',
    title: 'patch ready',
    body:
      'diff +24 -7 across route.ts and route.test.ts. green. ready for review.',
    timestamp: '03:08',
    tokens: 2210,
    cost: 0.003,
    duration: '2m 04s',
    status: 'complete',
    threadId: 't_coder',
    relatesTo: 'm07',
  },

  // 17. orchestrator -> reviewer via task tool
  {
    id: 'm17',
    fromAgentId: 'ag_orch',
    toAgentIds: ['ag_review'],
    part: 'tool',
    toolName: 'task',
    toolState: 'completed',
    title: 'delegate: review diff',
    toolSubtitle: 'task(subagent=reviewer, prompt="verify fallback + coverage")',
    timestamp: '03:12',
    tokens: 880,
    cost: 0.02,
    duration: '0.3s',
    status: 'complete',
    threadId: 't_review',
    relatesTo: 'm16',
  },

  // 18. reviewer reads the diff
  {
    id: 'm18',
    fromAgentId: 'ag_review',
    toAgentIds: ['ag_review'],
    part: 'tool',
    toolName: 'read',
    toolState: 'completed',
    title: 'read',
    toolSubtitle: 'diff route.ts + route.test.ts',
    toolPreview: '+24 -7',
    timestamp: '03:16',
    tokens: 4120,
    duration: '14ms',
    status: 'complete',
    threadId: 't_review',
  },

  // 19. reviewer returns subtask
  {
    id: 'm19',
    fromAgentId: 'ag_review',
    toAgentIds: ['ag_orch'],
    part: 'subtask',
    title: 'review: approve (1 non-blocking nit)',
    body:
      'fallback logic correct, tests cover both paths, signature verify untouched. nit: include event.id in fallback log line.',
    timestamp: '03:38',
    tokens: 2840,
    cost: 0.011,
    duration: '26s',
    status: 'complete',
    threadId: 't_review',
    relatesTo: 'm17',
  },

  // 20. step-finish marker on orchestrator
  {
    id: 'm20',
    fromAgentId: 'ag_orch',
    toAgentIds: ['ag_orch'],
    part: 'step-finish',
    title: 'checkpoint: review approved',
    timestamp: '03:39',
    status: 'complete',
  },

  // 21. orchestrator -> human (text, cross-lane)
  {
    id: 'm21',
    fromAgentId: 'ag_orch',
    toAgentIds: ['human'],
    part: 'text',
    title: 'ready to ship',
    body:
      'drift identified (wrong idempotency key), patched (+24 -7), tested (4 green), reviewed (approve). total spend $0.87 of $5 budget. awaiting your merge.',
    timestamp: '03:42',
    tokens: 1640,
    cost: 0.04,
    status: 'running',
    threadId: 't_ship',
  },
];
