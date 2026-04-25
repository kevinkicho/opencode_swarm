import { describe, expect, it } from 'vitest';
import {
  hasFields,
  isArrayOf,
  parseOpencodeJSON,
} from '../runtime-shape';
import {
  isOpencodeMessageArray,
  isOpencodeSession,
  isOpencodeSessionArray,
} from '../validators';

interface Foo {
  id: string;
  name: string;
}
const isFoo = hasFields<Foo>('id', 'name');

describe('hasFields', () => {
  it('passes when all required fields are present', () => {
    expect(isFoo({ id: 'a', name: 'b' })).toBe(true);
    expect(isFoo({ id: 'a', name: 'b', extra: 'ok' })).toBe(true);
  });

  it('rejects missing fields', () => {
    expect(isFoo({ id: 'a' })).toBe(false);
    expect(isFoo({ name: 'b' })).toBe(false);
    expect(isFoo({})).toBe(false);
  });

  it('rejects null / non-object / array', () => {
    expect(isFoo(null)).toBe(false);
    expect(isFoo(undefined)).toBe(false);
    expect(isFoo('string')).toBe(false);
    expect(isFoo(42)).toBe(false);
    expect(isFoo([])).toBe(false);
    expect(isFoo([{ id: 'a', name: 'b' }])).toBe(false);
  });

  it('accepts present-but-nullish field values (shape-only)', () => {
    // Validator checks PRESENCE not NULLABILITY — runtime callers
    // still need to handle null fields. This is intentional: opencode
    // sometimes returns nullable fields for unfinished state.
    expect(isFoo({ id: null, name: undefined })).toBe(true);
  });
});

describe('isArrayOf', () => {
  const isFooArray = isArrayOf(isFoo);

  it('passes empty arrays trivially', () => {
    expect(isFooArray([])).toBe(true);
  });

  it('passes when every item matches', () => {
    expect(isFooArray([{ id: 'a', name: 'b' }, { id: 'c', name: 'd' }])).toBe(true);
  });

  it('rejects when ANY item fails', () => {
    expect(
      isFooArray([
        { id: 'a', name: 'b' },
        { id: 'c' /* missing name */ },
      ]),
    ).toBe(false);
  });

  it('rejects non-arrays', () => {
    expect(isFooArray({ 0: { id: 'a', name: 'b' } })).toBe(false);
    expect(isFooArray('not an array')).toBe(false);
    expect(isFooArray(null)).toBe(false);
  });
});

describe('parseOpencodeJSON', () => {
  function fakeRes(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('returns the body when validator passes', async () => {
    const res = fakeRes({ id: 'a', name: 'b' });
    const out = await parseOpencodeJSON(res, isFoo, 'test');
    expect(out).toEqual({ id: 'a', name: 'b' });
  });

  it('throws on shape mismatch with context', async () => {
    const res = fakeRes({ id: 'a' /* missing name */ });
    await expect(parseOpencodeJSON(res, isFoo, 'GET /test')).rejects.toThrow(
      /opencode shape mismatch at GET \/test/,
    );
  });

  it('includes a body sample in the error', async () => {
    const res = fakeRes({ unexpected: 'shape' });
    await expect(parseOpencodeJSON(res, isFoo, 'GET /test')).rejects.toThrow(
      /unexpected.*shape/,
    );
  });

  it('truncates long bodies in the error to 200 chars', async () => {
    const huge = { unexpected: 'x'.repeat(500) };
    try {
      await parseOpencodeJSON(fakeRes(huge), isFoo, 'GET /huge');
      throw new Error('expected throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The 200-char-trimmed sample lives between "first 200 chars):" and end.
      const sampleStart = msg.indexOf('first 200 chars):');
      expect(sampleStart).toBeGreaterThan(-1);
      const sample = msg.slice(sampleStart + 'first 200 chars):'.length).trim();
      expect(sample.length).toBeLessThanOrEqual(200);
    }
  });
});

describe('endpoint-specific validators (smoke)', () => {
  it('isOpencodeSession accepts a realistic record', () => {
    expect(
      isOpencodeSession({
        id: 'ses_abc',
        slug: 'foo',
        projectID: 'p1',
        directory: '/x',
        title: 't',
        version: '1',
        time: { created: 1, updated: 2 },
      }),
    ).toBe(true);
  });

  it('isOpencodeSessionArray rejects when one row is malformed', () => {
    expect(
      isOpencodeSessionArray([
        { id: 'a', time: {} },
        { /* missing required fields */ },
      ]),
    ).toBe(false);
  });

  it('isOpencodeMessageArray accepts the {info,parts} shape', () => {
    expect(
      isOpencodeMessageArray([
        { info: { id: 'm1', role: 'assistant', time: { created: 1 } }, parts: [] },
      ]),
    ).toBe(true);
  });

  it('isOpencodeMessageArray rejects bare info objects (no parts)', () => {
    expect(
      isOpencodeMessageArray([
        { info: { id: 'm1', role: 'assistant', time: { created: 1 } } },
      ]),
    ).toBe(false);
  });
});
