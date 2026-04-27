//
// Pre-fix: swarm-registry.ts:251 cast `JSON.parse(raw) as SwarmRunMeta`
// directly. A truncated or hand-edited meta.json passes the cast and
// propagates undefined fields. The validators reject corrupt shapes
// at the read boundary so downstream code never sees them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetSwarmRegistryValidateWarnCache,
  validateMemoryKindDiscriminator,
  validateSwarmRunEvent,
  validateSwarmRunMeta,
} from '../swarm-registry-validate';

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetSwarmRegistryValidateWarnCache();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

const validMetaCore = {
  swarmRunID: 'run_test_1',
  pattern: 'blackboard',
  workspace: '/tmp/x',
  sessionIDs: ['s1', 's2'],
  createdAt: 1700000000000,
};

describe('validateSwarmRunMeta · happy path', () => {
  it('accepts a fully-populated meta', () => {
    const result = validateSwarmRunMeta({
      ...validMetaCore,
      directive: 'do the thing',
      title: 'test',
    });
    expect(result).not.toBeNull();
    expect(result?.swarmRunID).toBe('run_test_1');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('accepts a meta with optional fields omitted', () => {
    const result = validateSwarmRunMeta(validMetaCore);
    expect(result).not.toBeNull();
  });

  it('accepts every known pattern value', () => {
    const patterns = [
      'none',
      'blackboard',
      'orchestrator-worker',
      'role-differentiated',
      'council',
      'critic-loop',
      'debate-judge',
      'map-reduce',
    ];
    for (const pattern of patterns) {
      const result = validateSwarmRunMeta({ ...validMetaCore, pattern });
      expect(result, `pattern=${pattern}`).not.toBeNull();
    }
  });
});

describe('validateSwarmRunMeta · required-field checks', () => {
  it('rejects null', () => {
    expect(validateSwarmRunMeta(null)).toBeNull();
  });

  it('rejects a primitive', () => {
    expect(validateSwarmRunMeta('a string')).toBeNull();
    expect(validateSwarmRunMeta(42)).toBeNull();
  });

  it('rejects meta missing swarmRunID', () => {
    const { swarmRunID, ...rest } = validMetaCore;
    void swarmRunID;
    expect(validateSwarmRunMeta(rest)).toBeNull();
  });

  it('rejects meta with empty swarmRunID', () => {
    expect(validateSwarmRunMeta({ ...validMetaCore, swarmRunID: '' })).toBeNull();
  });

  it('rejects meta missing pattern', () => {
    const { pattern, ...rest } = validMetaCore;
    void pattern;
    expect(validateSwarmRunMeta(rest)).toBeNull();
  });

  it('rejects meta with unknown pattern', () => {
    expect(
      validateSwarmRunMeta({ ...validMetaCore, pattern: 'gallant-future-pattern' }),
    ).toBeNull();
  });

  it('rejects meta missing workspace', () => {
    const { workspace, ...rest } = validMetaCore;
    void workspace;
    expect(validateSwarmRunMeta(rest)).toBeNull();
  });

  it('rejects meta with sessionIDs not an array', () => {
    expect(
      validateSwarmRunMeta({ ...validMetaCore, sessionIDs: 'not-an-array' }),
    ).toBeNull();
  });

  it('rejects meta with non-string sessionIDs', () => {
    expect(
      validateSwarmRunMeta({ ...validMetaCore, sessionIDs: ['s1', 42] }),
    ).toBeNull();
  });

  it('rejects meta with createdAt not a number', () => {
    expect(
      validateSwarmRunMeta({ ...validMetaCore, createdAt: 'yesterday' }),
    ).toBeNull();
  });
});

describe('validateSwarmRunEvent', () => {
  const validEvent = {
    swarmRunID: 'run_test_1',
    sessionID: 'ses_1',
    ts: 1700000000000,
    type: 'session.idle',
    properties: { foo: 'bar' },
  };

  it('accepts a well-formed event', () => {
    expect(validateSwarmRunEvent(validEvent)).not.toBeNull();
  });

  it('accepts properties of any shape', () => {
    expect(validateSwarmRunEvent({ ...validEvent, properties: null })).not.toBeNull();
    expect(validateSwarmRunEvent({ ...validEvent, properties: 'string' })).not.toBeNull();
    expect(validateSwarmRunEvent({ ...validEvent, properties: 42 })).not.toBeNull();
  });

  it('rejects event missing swarmRunID', () => {
    const { swarmRunID, ...rest } = validEvent;
    void swarmRunID;
    expect(validateSwarmRunEvent(rest)).toBeNull();
  });

  it('rejects event missing sessionID', () => {
    const { sessionID, ...rest } = validEvent;
    void sessionID;
    expect(validateSwarmRunEvent(rest)).toBeNull();
  });

  it('rejects event with non-number ts', () => {
    expect(validateSwarmRunEvent({ ...validEvent, ts: 'now' })).toBeNull();
  });

  it('rejects event missing properties field', () => {
    const { properties, ...rest } = validEvent;
    void properties;
    expect(validateSwarmRunEvent(rest)).toBeNull();
  });
});

describe('validateMemoryKindDiscriminator', () => {
  it('accepts a payload with kind discriminator', () => {
    const result = validateMemoryKindDiscriminator({ kind: 'agent-rollup', data: {} });
    expect(result?.kind).toBe('agent-rollup');
  });

  it('rejects a payload missing kind', () => {
    expect(validateMemoryKindDiscriminator({ data: {} })).toBeNull();
  });

  it('rejects a payload with non-string kind', () => {
    expect(validateMemoryKindDiscriminator({ kind: 42 })).toBeNull();
  });

  it('rejects null/primitives', () => {
    expect(validateMemoryKindDiscriminator(null)).toBeNull();
    expect(validateMemoryKindDiscriminator('string')).toBeNull();
  });
});

describe('logging contract', () => {
  it('warns once per unique drift signature', () => {
    validateSwarmRunMeta({ ...validMetaCore, pattern: 'unknown-x' });
    validateSwarmRunMeta({ ...validMetaCore, pattern: 'unknown-x' });
    validateSwarmRunMeta({ ...validMetaCore, pattern: 'unknown-x' });
    // Only one warn for this signature.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns separately for each distinct signature', () => {
    validateSwarmRunMeta(null); // signature: meta::not-object
    validateSwarmRunMeta({ ...validMetaCore, swarmRunID: '' }); // meta::missing-swarmRunID
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
