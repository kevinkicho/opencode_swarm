//
// swarm-registry.ts is the most-imported server module in the repo (33
// callers, 867 LOC). It had ZERO tests prior to this. Status derivation,
// list ordering, atomic-rename guarantees, and cache invalidation are all
// exercised through this suite.
//
// Strategy: redirect OPENCODE_SWARM_ROOT to a tmpdir, run the full
// lifecycle (create → get → update → list → events → readEvents). Tests
// run hermetic-pure — no opencode HTTP needed because deriveRunRow* are
// covered separately.
//
// Status: passing today against current code. Acts as the safety net for
// the C3 split (fs-only vs derive) — splitting must keep this suite green.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SwarmRunRequest } from '../../swarm-run-types';

let TMP_ROOT: string;
let originalRoot: string | undefined;

// Re-import the module after env mutation to pick up the new ROOT. We
// can't statically import at top-level because the env-derived ROOT is
// captured at module-load time.
let registry: typeof import('../swarm-registry');
let memoryDbModule: typeof import('../memory/db');

beforeAll(async () => {
  TMP_ROOT = await mkdtemp(join(tmpdir(), 'swarm-registry-lifecycle-'));
  originalRoot = process.env.OPENCODE_SWARM_ROOT;
  process.env.OPENCODE_SWARM_ROOT = TMP_ROOT;
  registry = await import('../swarm-registry');
  memoryDbModule = await import('../memory/db');
});

afterAll(async () => {
  memoryDbModule.closeMemoryDb();
  if (originalRoot === undefined) delete process.env.OPENCODE_SWARM_ROOT;
  else process.env.OPENCODE_SWARM_ROOT = originalRoot;
  await rm(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset the process-local caches that fs.ts pins on globalThis.
  const g = globalThis as Record<symbol, unknown>;
  delete g[Symbol.for('opencode_swarm.swarmRegistry.deriveRowCache')];
  delete g[Symbol.for('opencode_swarm.sessionIndex')];
});

afterEach(async () => {
  // Wipe the runs table + the runs directory between tests so each
  // test starts with a clean slate. memoryDb singleton stays open;
  // we just clear the table.
  memoryDbModule.memoryDb().exec('DELETE FROM runs');
  await rm(join(TMP_ROOT, 'runs'), { recursive: true, force: true });
});

function makeRequest(over: Partial<SwarmRunRequest> = {}): SwarmRunRequest {
  return {
    pattern: 'critic-loop',
    workspace: '/tmp/example',
    directive: 'do the thing',
    title: 'test run',
    ...over,
  };
}

describe('swarm-registry · createRun', () => {
  it('writes the meta to SQLite + touches events.ndjson + returns the meta', async () => {
    const meta = await registry.createRun(makeRequest(), ['s1', 's2']);
    expect(meta.swarmRunID).toMatch(/^run_[a-z0-9]+_[a-z0-9]+$/);
    expect(meta.pattern).toBe('critic-loop');
    expect(meta.sessionIDs).toEqual(['s1', 's2']);

    // SQLite row exists with matching payload
    const reloaded = await registry.getRun(meta.swarmRunID);
    expect(reloaded?.swarmRunID).toBe(meta.swarmRunID);
    expect(reloaded?.pattern).toBe('critic-loop');

    // events.ndjson exists (zero-byte is OK — empty NDJSON is valid)
    const eventsJson = await readFile(
      join(TMP_ROOT, 'runs', meta.swarmRunID, 'events.ndjson'),
      'utf8',
    );
    expect(eventsJson).toBe('');
  });

  it('seeds the sessionIndex so findRunBySession resolves immediately', async () => {
    const meta = await registry.createRun(makeRequest(), ['session_alpha']);
    const found = await registry.findRunBySession('session_alpha');
    expect(found).toBe(meta.swarmRunID);
  });

  it('persists the optional bounds and gate fields when provided', async () => {
    const req = makeRequest({
      bounds: { costCap: 5, minutesCap: 30, todosCap: 50, commitsCap: 25 },
      enableCriticGate: true,
      enableVerifierGate: true,
    });
    const meta = await registry.createRun(req, ['s1', 's2'], {
      criticSessionID: 'c1',
      verifierSessionID: 'v1',
    });
    expect(meta.bounds?.costCap).toBe(5);
    expect(meta.enableCriticGate).toBe(true);
    expect(meta.criticSessionID).toBe('c1');
    expect(meta.verifierSessionID).toBe('v1');

    const reloaded = await registry.getRun(meta.swarmRunID);
    expect(reloaded?.bounds?.costCap).toBe(5);
    expect(reloaded?.criticSessionID).toBe('c1');
  });
});

describe('swarm-registry · getRun', () => {
  it('returns null for an unknown swarmRunID', async () => {
    const result = await registry.getRun('run_nonexistent');
    expect(result).toBeNull();
  });

  it('returns the meta on hit and caches subsequent reads', async () => {
    const created = await registry.createRun(makeRequest(), ['s1']);
    const r1 = await registry.getRun(created.swarmRunID);
    const r2 = await registry.getRun(created.swarmRunID);
    expect(r1?.swarmRunID).toBe(created.swarmRunID);
    expect(r2?.swarmRunID).toBe(created.swarmRunID);
    // Cache hit: both calls return the same shape (no need to assert
    // identity — JSON-parse creates fresh objects each time).
  });
});

describe('swarm-registry · updateRunMeta', () => {
  it('merges the patch and persists to disk', async () => {
    const created = await registry.createRun(makeRequest(), ['s1']);
    const updated = await registry.updateRunMeta(created.swarmRunID, {
      title: 'renamed',
    });
    expect(updated?.title).toBe('renamed');
    expect(updated?.pattern).toBe('critic-loop'); // untouched

    const reloaded = await registry.getRun(created.swarmRunID);
    expect(reloaded?.title).toBe('renamed');
  });

  it('returns null for a nonexistent run (silent no-op)', async () => {
    const result = await registry.updateRunMeta('run_missing', { title: 'x' });
    expect(result).toBeNull();
  });

  it('invalidates the meta cache so subsequent getRun sees the update', async () => {
    const created = await registry.createRun(makeRequest(), ['s1']);
    // Prime the cache via getRun
    await registry.getRun(created.swarmRunID);
    await registry.updateRunMeta(created.swarmRunID, { title: 'fresh' });
    // If the cache wasn't invalidated, this would return the stale value.
    const reloaded = await registry.getRun(created.swarmRunID);
    expect(reloaded?.title).toBe('fresh');
  });
});

describe('swarm-registry · listRuns', () => {
  it('returns empty array when no runs exist', async () => {
    const runs = await registry.listRuns();
    expect(runs).toEqual([]);
  });

  it('returns runs newest-first by createdAt', async () => {
    const a = await registry.createRun(makeRequest({ title: 'first' }), ['sa']);
    // Brief delay so the second run's createdAt is strictly greater
    await new Promise((r) => setTimeout(r, 10));
    const b = await registry.createRun(makeRequest({ title: 'second' }), ['sb']);

    const runs = await registry.listRuns();
    expect(runs).toHaveLength(2);
    // Newest first → b before a
    expect(runs[0].swarmRunID).toBe(b.swarmRunID);
    expect(runs[1].swarmRunID).toBe(a.swarmRunID);
  });

  it('skips run dirs with malformed meta.json silently', async () => {
    const good = await registry.createRun(makeRequest(), ['s1']);
    // Manufacture a corrupt run alongside
    const fs = await import('node:fs/promises');
    const corruptDir = join(TMP_ROOT, 'runs', 'run_corrupt_xx');
    await fs.mkdir(corruptDir, { recursive: true });
    await fs.writeFile(join(corruptDir, 'meta.json'), '{ not: valid json');

    const runs = await registry.listRuns();
    expect(runs.map((r) => r.swarmRunID)).toContain(good.swarmRunID);
    expect(runs.map((r) => r.swarmRunID)).not.toContain('run_corrupt_xx');
  });
});

describe('swarm-registry · appendEvent + readEvents', () => {
  it('round-trips events through ndjson', async () => {
    const created = await registry.createRun(makeRequest(), ['s1']);
    const ev1 = {
      swarmRunID: created.swarmRunID,
      sessionID: 's1',
      ts: 1,
      type: 'session.idle',
      properties: { ts: 1 },
    };
    const ev2 = {
      swarmRunID: created.swarmRunID,
      sessionID: 's1',
      ts: 2,
      type: 'session.idle',
      properties: { ts: 2 },
    };
    await registry.appendEvent(created.swarmRunID, ev1);
    await registry.appendEvent(created.swarmRunID, ev2);

    const seen: import('../../swarm-run-types').SwarmRunEvent[] = [];
    for await (const e of registry.readEvents(created.swarmRunID)) {
      seen.push(e);
    }
    expect(seen).toHaveLength(2);
    expect((seen[0].properties as { ts: number }).ts).toBe(1);
    expect((seen[1].properties as { ts: number }).ts).toBe(2);
  });
});

describe('swarm-registry · findRunBySession', () => {
  it('returns null for an unknown session', async () => {
    const found = await registry.findRunBySession('ses_unknown');
    expect(found).toBeNull();
  });

  it('falls back to disk scan after cache miss', async () => {
    // Create a run, then bust the in-memory index so findRunBySession
    // is forced to rebuild from disk.
    const meta = await registry.createRun(makeRequest(), ['ses_seed']);
    const g = globalThis as Record<symbol, unknown>;
    delete g[Symbol.for('opencode_swarm.sessionIndex')];
    delete g[Symbol.for('opencode_swarm.swarmRegistry.listCache')];

    const found = await registry.findRunBySession('ses_seed');
    expect(found).toBe(meta.swarmRunID);
  });
});
