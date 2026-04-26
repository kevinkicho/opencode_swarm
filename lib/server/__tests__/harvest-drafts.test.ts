import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMeta } from './_helpers/fake-meta';
import { makeAssistant } from './_helpers/fake-message';
import type { OpencodeServerMocks } from './_helpers/mock-opencode';

// harvestDrafts (#110) is the shared fan-out helper used by map-reduce
// phase 1, council per-round, and (transitively via council)
// deliberate-execute phase 1. Drift in this helper changes how every
// non-ticker pattern collects member drafts — pin the contract.

const opencodeMocks: OpencodeServerMocks = vi.hoisted(() => ({
  getSessionMessagesServer: vi.fn().mockResolvedValue([]),
  abortSessionServer: vi.fn().mockResolvedValue(undefined),
  postSessionMessageServer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../opencode-server', () => opencodeMocks);
// Mock the coordinator's waitForSessionIdle so the test runs in
// milliseconds, not real-time POLL_INTERVAL_MS.
vi.mock('../blackboard/coordinator', () => ({
  waitForSessionIdle: vi.fn(),
}));

const { harvestDrafts, snapshotKnownIDs } = await import('../harvest-drafts');
const { waitForSessionIdle } = await import('../blackboard/coordinator');
const mockWait = vi.mocked(waitForSessionIdle);
const mockGet = opencodeMocks.getSessionMessagesServer;

beforeEach(() => {
  mockWait.mockReset();
  mockGet.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('harvestDrafts', () => {
  it('returns one row per session with text + ok + newKnownIDs', async () => {
    mockWait.mockResolvedValue({
      ok: true,
      messages: [],
      newIDs: new Set<string>(),
    });
    mockGet.mockImplementation(async (sid: string) => [
      makeAssistant({
        id: `m-${sid}`,
        completed: 1,
      }),
    ]);
    // makeAssistant defaults to a 1-part text='streaming…' part — the
    // helper's extractLatestAssistantText reads .parts[].text from
    // completed turns, so it picks that up.

    const meta = fakeMeta({
      sessionIDs: ['s1', 's2', 's3'],
      pattern: 'map-reduce',
    });

    const out = await harvestDrafts(meta, {
      deadline: Date.now() + 60_000,
      contextLabel: '[test]',
    });

    expect(out).toHaveLength(3);
    expect(out.map((r) => r.sessionID)).toEqual(['s1', 's2', 's3']);
    for (const row of out) {
      expect(row.ok).toBe(true);
      expect(row.text).toBe('streaming…');
      expect(row.newKnownIDs.has(`m-${row.sessionID}`)).toBe(true);
    }
  });

  it('returns text=null when wait fails AND fetch returns no completed text', async () => {
    mockWait.mockResolvedValue({ ok: false, reason: 'timeout' });
    mockGet.mockResolvedValue([
      makeAssistant({ id: 'incomplete', completed: null, parts: 2 }),
    ]);

    const meta = fakeMeta({ sessionIDs: ['s1'], pattern: 'council' });
    const out = await harvestDrafts(meta, {
      deadline: Date.now() + 60_000,
      contextLabel: '[test]',
    });

    expect(out[0].ok).toBe(false);
    expect(out[0].reason).toBe('timeout');
    expect(out[0].text).toBeNull();
  });

  it('still extracts text on timeout when a completed assistant turn exists', async () => {
    mockWait.mockResolvedValue({ ok: false, reason: 'timeout' });
    mockGet.mockResolvedValue([
      makeAssistant({ id: 'old', completed: 1 }),
      // A fresh in-progress turn would normally make text=null, but
      // we want the LATEST completed; verify the fall-back semantics.
    ]);

    const meta = fakeMeta({ sessionIDs: ['s1'], pattern: 'council' });
    const out = await harvestDrafts(meta, {
      deadline: Date.now() + 60_000,
      contextLabel: '[test]',
    });

    expect(out[0].ok).toBe(false);
    expect(out[0].text).toBe('streaming…');
  });

  it('honors knownIDsBySession when provided (multi-round case)', async () => {
    // Pre-existing message — should be in `known` and NOT block the
    // wait. Helper passes a Set(known) to waitForSessionIdle.
    const known = new Map([['s1', new Set(['old-msg'])]]);
    mockWait.mockResolvedValue({
      ok: true,
      messages: [],
      newIDs: new Set<string>(),
    });
    mockGet.mockResolvedValue([
      makeAssistant({ id: 'old-msg', completed: 1 }),
      makeAssistant({ id: 'new-msg', completed: 2 }),
    ]);

    const meta = fakeMeta({ sessionIDs: ['s1'], pattern: 'council' });
    const out = await harvestDrafts(meta, {
      knownIDsBySession: known,
      deadline: Date.now() + 60_000,
      contextLabel: '[test]',
    });

    // newKnownIDs should now include both messages.
    expect(out[0].newKnownIDs.has('old-msg')).toBe(true);
    expect(out[0].newKnownIDs.has('new-msg')).toBe(true);

    // waitForSessionIdle was called with the original `known` snapshot
    // as its starting point.
    const callArgs = mockWait.mock.calls[0];
    const knownArg = callArgs[2] as Set<string>;
    expect(knownArg.has('old-msg')).toBe(true);
    expect(knownArg.has('new-msg')).toBe(false);
  });

  it('absorbs message-fetch errors as text=null + empty newKnownIDs', async () => {
    mockWait.mockResolvedValue({
      ok: true,
      messages: [],
      newIDs: new Set<string>(),
    });
    mockGet.mockRejectedValue(new Error('opencode 502'));

    const meta = fakeMeta({ sessionIDs: ['s1'], pattern: 'council' });
    const out = await harvestDrafts(meta, {
      deadline: Date.now() + 60_000,
      contextLabel: '[test]',
    });

    expect(out[0].ok).toBe(true); // wait succeeded
    expect(out[0].text).toBeNull(); // but fetch failed
    expect(out[0].newKnownIDs.size).toBe(0);
  });
});

describe('snapshotKnownIDs', () => {
  it('returns empty sets when fetch fails', async () => {
    mockGet.mockRejectedValue(new Error('opencode unreachable'));
    const meta = fakeMeta({ sessionIDs: ['s1', 's2'], pattern: 'council' });
    const out = await snapshotKnownIDs(meta, '[test]');
    expect(out.get('s1')?.size).toBe(0);
    expect(out.get('s2')?.size).toBe(0);
  });

  it('returns the message IDs visible right now', async () => {
    mockGet.mockImplementation(async (sid: string) => [
      makeAssistant({ id: `m1-${sid}`, completed: 1 }),
      makeAssistant({ id: `m2-${sid}`, completed: 2 }),
    ]);
    const meta = fakeMeta({ sessionIDs: ['s1'], pattern: 'council' });
    const out = await snapshotKnownIDs(meta, '[test]');
    expect(out.get('s1')).toEqual(new Set(['m1-s1', 'm2-s1']));
  });
});
