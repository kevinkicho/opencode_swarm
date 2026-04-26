// HARDENING_PLAN.md#R2 — SDK schema-drift firewall.
//
// Tests for `lib/opencode/validate-part.ts`. The validator's contract:
// given an opaque opencode message-part shape, return either
// { ok: true; part } or { ok: false; reason; raw } and emit a one-time
// console.warn so unknown shapes show up in dev logs instead of silently
// passing through.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetValidatePartWarnCache, validatePart } from '../validate-part';

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetValidatePartWarnCache();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

const baseFields = {
  id: 'prt_a1',
  sessionID: 'ses_1',
  messageID: 'msg_1',
};

describe('validatePart · happy path (known shapes pass)', () => {
  it('accepts a well-formed text part', () => {
    const result = validatePart({ ...baseFields, type: 'text', text: 'hello' });
    expect(result.ok).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('accepts a well-formed tool part with state and tool fields', () => {
    const result = validatePart({
      ...baseFields,
      type: 'tool',
      tool: 'read',
      state: { status: 'completed' },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a well-formed reasoning part', () => {
    const result = validatePart({ ...baseFields, type: 'reasoning', text: 'thinking…' });
    expect(result.ok).toBe(true);
  });

  it('accepts a well-formed patch part with files array', () => {
    const result = validatePart({
      ...baseFields,
      type: 'patch',
      hash: 'abc123',
      files: ['lib/x.ts'],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts step-start and step-finish parts', () => {
    const stepStart = validatePart({ ...baseFields, type: 'step-start' });
    expect(stepStart.ok).toBe(true);

    const stepFinish = validatePart({
      ...baseFields,
      type: 'step-finish',
      reason: 'done',
      cost: 0.01,
      tokens: { total: 10, input: 5, output: 5, reasoning: 0, cache: { write: 0, read: 0 } },
    });
    expect(stepFinish.ok).toBe(true);
  });
});

describe('validatePart · drift detection (unknown shapes fail)', () => {
  it('rejects a part with unknown type field', () => {
    const result = validatePart({ ...baseFields, type: 'unknown-future-type' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('unknown part type');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a tool part missing the type field', () => {
    const result = validatePart({ ...baseFields, tool: 'read' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('missing required base field');
  });

  it('rejects a step-finish part missing the reason field', () => {
    const result = validatePart({
      ...baseFields,
      type: 'step-finish',
      cost: 0.01,
      tokens: { total: 10, input: 5, output: 5, reasoning: 0, cache: { write: 0, read: 0 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("missing required field 'reason'");
  });

  it('rejects a patch part missing the hash field', () => {
    const result = validatePart({
      ...baseFields,
      type: 'patch',
      files: ['x.ts'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("missing required field 'hash'");
  });

  it('rejects a part with type=undefined', () => {
    const result = validatePart({ ...baseFields, type: undefined });
    expect(result.ok).toBe(false);
  });

  it('rejects null', () => {
    const result = validatePart(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not an object');
  });

  it('rejects a non-object payload', () => {
    expect(validatePart('a string').ok).toBe(false);
    expect(validatePart(42).ok).toBe(false);
    expect(validatePart(['array']).ok).toBe(false);
  });

  it('rejects a part missing the id field', () => {
    const result = validatePart({ sessionID: 'ses_1', messageID: 'msg_1', type: 'text', text: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("missing required base field 'id'");
  });
});

describe('validatePart · logging contract', () => {
  it('emits console.warn exactly once per unique drift signature', () => {
    // Same drift shape three times → only one warn.
    validatePart({ ...baseFields, type: 'unknown-future-type' });
    validatePart({ ...baseFields, type: 'unknown-future-type', id: 'prt_a2' });
    validatePart({ ...baseFields, type: 'unknown-future-type', id: 'prt_a3' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('emits a separate warn for a different drift signature', () => {
    validatePart({ ...baseFields, type: 'unknown-x' });
    validatePart({ ...baseFields, type: 'unknown-y' });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('reason field describes what was missing or unrecognized', () => {
    const result = validatePart({ ...baseFields, type: 'patch', files: ['x.ts'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('hash');
      expect(result.raw).toMatchObject({ type: 'patch', files: ['x.ts'] });
    }
  });
});

describe('validatePart · Q34/Q42 firewall scenarios', () => {
  it('a tool part missing tool/state is acceptable (transform handles it)', () => {
    // The SDK declares tool/state as optional. We don't reject these —
    // transform.ts already handles undefined tool fields.
    const result = validatePart({ ...baseFields, type: 'tool' });
    expect(result.ok).toBe(true);
  });

  it('rejects a "fake tool" text part that adopts tool fields without type=tool', () => {
    // Q42 reproducer: model emits text content with embedded tool-like
    // structure. The validator only trusts the discriminator — type='text'
    // means text part, no matter what other fields are attached.
    const result = validatePart({
      ...baseFields,
      type: 'text',
      // No `text` field — model produced something pretending to be a tool
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("missing required field 'text'");
  });
});
