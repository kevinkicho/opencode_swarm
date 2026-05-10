// Tests for POST /api/webhook/run — PR webhook trigger.
//
// Exercises HMAC validation, run creation on PR open, run stop on PR close,
// and the not-found path for PRs with no matching webhook record.
//
// Strategy: mock every I/O boundary (swarm-registry, opencode-server,
// blackboard), control WEBHOOK_SECRET and OPENCODE_SWARM_ROOT, and call
// the route handler directly with synthetic NextRequest objects.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Mock server-only guard
vi.mock('server-only', () => ({}));

// Mock all I/O modules the webhook route reaches into
vi.mock('@/lib/server/swarm-registry', () => ({
  createRun: vi.fn(),
}));
vi.mock('@/lib/server/opencode-server', () => ({
  createSessionServer: vi.fn(),
}));
vi.mock('@/lib/server/blackboard/auto-ticker', () => ({
  startAutoTicker: vi.fn(),
  stopAutoTicker: vi.fn(),
}));
vi.mock('@/lib/server/blackboard/planner', () => ({
  runPlannerSweep: vi.fn(),
}));
vi.mock('@/lib/server/blackboard/store', () => ({
  listBoardItems: vi.fn(() => []),
}));

let tmpRoot: string;

function webhooksDir(): string {
  return path.join(tmpRoot, 'webhooks');
}

function webhookRecordPath(id: string): string {
  return path.join(webhooksDir(), `${id}.json`);
}

// Mock @/lib/config so OPENCODE_SWARM_ROOT points at our temp dir.
// Must use a getter so it reads tmpRoot (which is set in beforeEach).
vi.mock('@/lib/config', () => ({
  get OPENCODE_SWARM_ROOT() {
    return tmpRoot;
  },
}));

function hmac(raw: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

describe('POST /api/webhook/run', () => {
  let POST: Awaited<typeof import('@/app/api/webhook/run/route')>['POST'];
  let mocks: {
    createRun: ReturnType<typeof vi.fn>;
    createSessionServer: ReturnType<typeof vi.fn>;
    startAutoTicker: ReturnType<typeof vi.fn>;
    stopAutoTicker: ReturnType<typeof vi.fn>;
    runPlannerSweep: ReturnType<typeof vi.fn>;
  };

  beforeAll(async () => {
    const [
      { createRun },
      { createSessionServer },
      { startAutoTicker, stopAutoTicker },
      { runPlannerSweep },
    ] = await Promise.all([
      import('@/lib/server/swarm-registry'),
      import('@/lib/server/opencode-server'),
      import('@/lib/server/blackboard/auto-ticker'),
      import('@/lib/server/blackboard/planner'),
    ]);
    mocks = {
      createRun: createRun as unknown as ReturnType<typeof vi.fn>,
      createSessionServer: createSessionServer as unknown as ReturnType<typeof vi.fn>,
      startAutoTicker: startAutoTicker as unknown as ReturnType<typeof vi.fn>,
      stopAutoTicker: stopAutoTicker as unknown as ReturnType<typeof vi.fn>,
      runPlannerSweep: runPlannerSweep as unknown as ReturnType<typeof vi.fn>,
    };
  });

  beforeEach(async () => {
    tmpRoot = path.join(os.tmpdir(), `webhook-test-${crypto.randomUUID()}`);
    await fs.mkdir(tmpRoot, { recursive: true });

    // Reset process.env for each test
    delete process.env.WEBHOOK_SECRET;

    mocks.createRun.mockReset();
    mocks.createSessionServer.mockReset();
    mocks.startAutoTicker.mockReset();
    mocks.stopAutoTicker.mockReset();
    mocks.runPlannerSweep.mockReset();

    // Route handler is a fresh dynamic import each time so env mutation
    // picks up the current tmpRoot
    vi.resetModules();
    const mod = await import('@/app/api/webhook/run/route');
    POST = mod.POST;
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  // ── Test 1 ───────────────────────────────────────────────────────────────

  it('rejects invalid signature when WEBHOOK_SECRET is set', async () => {
    process.env.WEBHOOK_SECRET = 'test-secret';

    const req = new Request('http://localhost/api/webhook/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: JSON.stringify({ event: 'pull_request.opened', repo: 'a', branch: 'b', prTitle: 't', prBody: '' }),
    });

    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('invalid signature');
  });

  // ── Test 2 ───────────────────────────────────────────────────────────────

  it('creates a swarm run on PR opened', async () => {
    const secret = 'test-secret';
    process.env.WEBHOOK_SECRET = secret;

    // Setup mocks
    mocks.createSessionServer.mockImplementation(async (_dir: string, _title?: string) => ({
      id: `ses_${crypto.randomUUID().slice(0, 8)}`,
      title: _title ?? 'untitled',
      messages: [],
    }));
    mocks.createRun.mockResolvedValue({
      swarmRunID: 'run_test123',
      pattern: 'blackboard',
    });
    mocks.runPlannerSweep.mockResolvedValue({ items: [{ id: 'todo1', summary: 'do something' }] });

    const payload = {
      event: 'pull_request.opened',
      repo: 'my-org/my-repo',
      branch: 'feature/fix-bug',
      prTitle: 'Fix the login bug',
      prBody: 'This PR fixes the login bug by updating the auth flow. It also adds tests.',
    };

    const rawBody = JSON.stringify(payload);
    const sig = hmac(rawBody, secret);

    const req = new Request('http://localhost/api/webhook/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sig,
      },
      body: rawBody,
    });

    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.swarmRunID).toBe('run_test123');
    expect(json.status).toBe('started');
    expect(mocks.createSessionServer).toHaveBeenCalledTimes(3);
    expect(mocks.createRun).toHaveBeenCalledTimes(1);
    expect(mocks.runPlannerSweep).toHaveBeenCalledWith('run_test123');
    expect(mocks.startAutoTicker).toHaveBeenCalledWith('run_test123', expect.any(Object));

    // Verify webhook record was persisted
    const recordPath = webhookRecordPath('run_test123');
    const raw = await fs.readFile(recordPath, 'utf-8');
    const record = JSON.parse(raw);
    expect(record.swarmRunID).toBe('run_test123');
    expect(record.prNumber).toBe('feature/fix-bug');
    expect(record.repo).toBe('my-org/my-repo');
  });

  // ── Test 3 ───────────────────────────────────────────────────────────────

  it('stops a swarm run on PR closed', async () => {
    const secret = 'test-secret';
    process.env.WEBHOOK_SECRET = secret;

    // Pre-populate a webhook record
    await fs.mkdir(webhooksDir(), { recursive: true });
    await fs.writeFile(
      webhookRecordPath('run_existing1'),
      JSON.stringify({ swarmRunID: 'run_existing1', prNumber: 'feature/closed-pr', repo: 'my-org/my-repo' }),
    );

    const payload = {
      event: 'pull_request.closed',
      repo: 'my-org/my-repo',
      branch: 'feature/closed-pr',
      prTitle: '',
      prBody: '',
    };

    const rawBody = JSON.stringify(payload);
    const sig = hmac(rawBody, secret);

    const req = new Request('http://localhost/api/webhook/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sig,
      },
      body: rawBody,
    });

    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.swarmRunID).toBe('run_existing1');
    expect(json.status).toBe('stopped');
    expect(mocks.stopAutoTicker).toHaveBeenCalledWith('run_existing1', 'manual');
  });

  // ── Test 4 ───────────────────────────────────────────────────────────────

  it('returns not-found when PR has no matching run', async () => {
    const secret = 'test-secret';
    process.env.WEBHOOK_SECRET = secret;

    // Ensure webhooks dir exists but has no matching record
    await fs.mkdir(webhooksDir(), { recursive: true });

    const payload = {
      event: 'pull_request.closed',
      repo: 'unknown/repo',
      branch: 'unknown-branch',
      prTitle: '',
      prBody: '',
    };

    const rawBody = JSON.stringify(payload);
    const sig = hmac(rawBody, secret);

    const req = new Request('http://localhost/api/webhook/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sig,
      },
      body: rawBody,
    });

    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(404);

    const json = await res.json();
    expect(json.status).toBe('not-found');
    expect(mocks.stopAutoTicker).not.toHaveBeenCalled();
  });
});
