// Smoke tests for the /api/swarm/run route handler.
//
// Closes the structural gap surfaced 2026-04-27: prior to this file,
// 0 of 510 vitest tests sent a real Request to a real /api/* handler.
// The picker depends entirely on this endpoint — a 500 here means
// "no runs visible to the user" — and it had no unit-level guard.
//
// Tests import the GET/POST functions directly and call them with
// synthetic NextRequest objects, mocking the I/O layers (registry,
// opencode HTTP, board store) so the assertions cover the route's
// own logic without spinning a Next.js server.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwarmRunMeta } from '@/lib/swarm-run-types';

// Mock every I/O the route reaches into. Keep these BEFORE the dynamic
// import of the route module so the mocks take effect on first import.
vi.mock('@/lib/server/swarm-registry', () => ({
  listRuns: vi.fn(),
  deriveRunRowCached: vi.fn(),
  createRun: vi.fn(),
}));
vi.mock('@/lib/server/blackboard/store', () => ({
  listBoardItems: vi.fn(() => []),
}));
vi.mock('@/lib/server/stuck-detector', () => ({
  detectStuckDeliberation: vi.fn(() => ({ stuck: false })),
}));
vi.mock('@/lib/server/opencode-server', () => ({
  createSessionServer: vi.fn(),
}));
vi.mock('@/lib/server/run/kickoff-guard', () => ({
  attachLateFailureLog: vi.fn(),
  raceKickoffSync: vi.fn(),
}));
vi.mock('@/lib/server/run/continuation', () => ({
  resolveContinuation: vi.fn(async () => null),
}));
vi.mock('@/lib/server/run/kickoff/dispatcher', () => ({
  invokeKickoff: vi.fn(),
}));
vi.mock('@/lib/server/run/dispatch-intro', () => ({
  dispatchInitialDirective: vi.fn(),
}));
vi.mock('@/lib/server/run/spawn-gates', () => ({
  spawnGateSessions: vi.fn(async () => ({ critic: null, verifier: null, auditor: null, gateFailures: [] })),
}));
vi.mock('@/lib/server/blackboard/model-prewarm', () => ({
  collectOllamaModels: vi.fn(() => []),
  prewarmModels: vi.fn(async () => undefined),
}));
// Mock the opencode HTTP client so the GET handler's reachability probe
// always reports "up" — without this, every test would short-circuit
// to status='unknown' rows. The slow-load fix (2026-04-27) added the
// probe to /api/swarm/run; tests that assert real status values need
// the probe to pass for the derive path to run.
vi.mock('@/lib/opencode/client', () => ({
  opencodeFetch: vi.fn(async () => new Response('[]', { status: 200 })),
}));

const { listRuns, deriveRunRowCached } = await import('@/lib/server/swarm-registry');
const { GET, POST } = await import('@/app/api/swarm/run/route');

const mockListRuns = vi.mocked(listRuns);
const mockDerive = vi.mocked(deriveRunRowCached);

function makeMeta(id: string, pattern: SwarmRunMeta['pattern'] = 'none'): SwarmRunMeta {
  return {
    swarmRunID: id,
    pattern,
    createdAt: 1_700_000_000_000,
    workspace: '/tmp/test-ws',
    sessionIDs: [`ses_${id}`],
  };
}

beforeEach(() => {
  mockListRuns.mockReset();
  mockDerive.mockReset();
  mockDerive.mockResolvedValue({
    status: 'stale',
    lastActivityTs: null,
    costTotal: 0,
    tokensTotal: 0,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/swarm/run', () => {
  it('returns { runs: [] } with 200 when registry is empty', async () => {
    mockListRuns.mockResolvedValue([]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ runs: [] });
  });

  it('returns rows when registry has runs', async () => {
    mockListRuns.mockResolvedValue([makeMeta('alpha'), makeMeta('beta')]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0].meta.swarmRunID).toBe('alpha');
    expect(body.runs[0].status).toBe('stale');
  });

  it('returns 500 with detail when listRuns throws', async () => {
    // The user-reported 2026-04-27 cold-start 500 looked like one of
    // these. The handler must surface a structured 500 (not a raw
    // crash) so the picker shows "offline" instead of going blank.
    mockListRuns.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('run list failed');
    expect(body.detail).toContain('SQLITE_BUSY');
  });

  it('returns 500 with detail when deriveRunRowCached rejects', async () => {
    // deriveRunRowCached is supposed to be non-throwing (collapses
    // probe failures to status='unknown'), but if it does reject,
    // Promise.all rejects, and the outer catch must 500 cleanly.
    mockListRuns.mockResolvedValue([makeMeta('rejecter')]);
    mockDerive.mockRejectedValue(new Error('opencode unreachable'));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('run list failed');
  });

  it('short-circuits to unknown rows when opencode probe fails', async () => {
    // The slow-load fix probes /project once and skips the per-session
    // derive fan-out when opencode is down. Verifies derive is NOT
    // called and rows come back with zeroed metrics.
    const opencodeMod = await import('@/lib/opencode/client');
    const opencodeFetchMock = vi.mocked(opencodeMod.opencodeFetch);
    opencodeFetchMock.mockRejectedValueOnce(new Error('connection refused'));
    mockListRuns.mockResolvedValue([makeMeta('alpha'), makeMeta('beta')]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0].status).toBe('unknown');
    expect(body.runs[0].lastActivityTs).toBeNull();
    expect(body.runs[0].costTotal).toBe(0);
    // The derive fan-out must NOT have been invoked — that's the whole
    // point of the short-circuit.
    expect(mockDerive).not.toHaveBeenCalled();
  });

  it('inherits row order from listRuns (no server-side resorting)', async () => {
    // Sort order is documented as listRuns()'s contract; the route
    // doesn't re-sort. If a refactor adds sort logic here, the
    // picker's client-side sort would conflict.
    mockListRuns.mockResolvedValue([
      makeMeta('z-newest'),
      makeMeta('a-oldest'),
      makeMeta('m-middle'),
    ]);
    const res = await GET();
    const body = await res.json();
    expect(body.runs.map((r: { meta: SwarmRunMeta }) => r.meta.swarmRunID)).toEqual([
      'z-newest',
      'a-oldest',
      'm-middle',
    ]);
  });
});

describe('POST /api/swarm/run', () => {
  it('returns 400 when body is not valid JSON', async () => {
    const req = new Request('http://localhost/api/swarm/run', {
      method: 'POST',
      body: 'not json at all{',
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid JSON body');
  });

  it('returns 400 when required fields missing', async () => {
    const req = new Request('http://localhost/api/swarm/run', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });

  it('returns 501 for an unsupported pattern', async () => {
    const req = new Request('http://localhost/api/swarm/run', {
      method: 'POST',
      body: JSON.stringify({
        pattern: 'unknown-pattern',
        workspace: '/tmp/x',
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    // Either 400 (parseRequest rejects unknown pattern) or 501 (parses
    // but pattern not in SUPPORTED_PATTERNS). Both are acceptable
    // failure modes for an unimplemented pattern; the gate is "not 200".
    expect([400, 501]).toContain(res.status);
  });
});
