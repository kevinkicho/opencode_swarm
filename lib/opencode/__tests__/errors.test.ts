//
// Tests for `lib/opencode/errors.ts`. Verifies that:
//   1. Each subclass exposes its kind discriminator + payload fields
//   2. instanceof works for both the concrete class and base Error
//   3. Type guards (isOpencode*Error) narrow correctly
//   4. The .name property matches the class name (helpful for logs)

import { describe, it, expect } from 'vitest';
import {
  OpencodeHttpError,
  OpencodeTimeoutError,
  OpencodeUnreachableError,
  isOpencodeHttpError,
  isOpencodeTimeoutError,
  isOpencodeUnreachableError,
} from '../errors';

describe('OpencodeHttpError', () => {
  it('exposes status, path, and kind', () => {
    const err = new OpencodeHttpError('/session', 502, 'opencode unreachable');
    expect(err.kind).toBe('http');
    expect(err.path).toBe('/session');
    expect(err.status).toBe(502);
    expect(err.detail).toBe('opencode unreachable');
  });

  it('formats the message with status and optional detail', () => {
    const withDetail = new OpencodeHttpError('/x', 502, 'bad gateway');
    expect(withDetail.message).toContain('opencode /x');
    expect(withDetail.message).toContain('HTTP 502');
    expect(withDetail.message).toContain('bad gateway');

    const withoutDetail = new OpencodeHttpError('/y', 404);
    expect(withoutDetail.message).toContain('HTTP 404');
    expect(withoutDetail.message).not.toContain(': ');
  });

  it('is catchable as Error and instanceof OpencodeHttpError', () => {
    try {
      throw new OpencodeHttpError('/z', 500);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(OpencodeHttpError);
      expect(e).not.toBeInstanceOf(OpencodeTimeoutError);
    }
  });

  it('isOpencodeHttpError narrows correctly', () => {
    const err: unknown = new OpencodeHttpError('/a', 502);
    if (isOpencodeHttpError(err)) {
      // type-narrowed to OpencodeHttpError
      expect(err.status).toBe(502);
    } else {
      throw new Error('isOpencodeHttpError failed to narrow');
    }
    expect(isOpencodeHttpError(new Error('x'))).toBe(false);
    expect(isOpencodeHttpError(null)).toBe(false);
  });

  it('has a name property matching the class', () => {
    expect(new OpencodeHttpError('/x', 500).name).toBe('OpencodeHttpError');
  });
});

describe('OpencodeTimeoutError', () => {
  it('exposes path, elapsedMs, kind', () => {
    const err = new OpencodeTimeoutError('/slow', 30_000);
    expect(err.kind).toBe('timeout');
    expect(err.path).toBe('/slow');
    expect(err.elapsedMs).toBe(30_000);
  });

  it('formats the message with elapsed time', () => {
    expect(new OpencodeTimeoutError('/x', 5000).message).toContain('5000ms');
  });

  it('does NOT match instanceof OpencodeHttpError', () => {
    const err = new OpencodeTimeoutError('/x', 100);
    expect(err).not.toBeInstanceOf(OpencodeHttpError);
    expect(err).toBeInstanceOf(OpencodeTimeoutError);
  });

  it('isOpencodeTimeoutError narrows correctly', () => {
    expect(isOpencodeTimeoutError(new OpencodeTimeoutError('/x', 1))).toBe(true);
    expect(isOpencodeTimeoutError(new OpencodeHttpError('/x', 502))).toBe(false);
  });
});

describe('OpencodeUnreachableError', () => {
  it('exposes path and reason', () => {
    const err = new OpencodeUnreachableError('/x', 'ECONNREFUSED');
    expect(err.kind).toBe('unreachable');
    expect(err.reason).toBe('ECONNREFUSED');
  });

  it('formats the message', () => {
    expect(new OpencodeUnreachableError('/x', 'ECONNREFUSED').message).toContain(
      'ECONNREFUSED',
    );
  });

  it('is the right class for fetch-throw cases', () => {
    const err = new OpencodeUnreachableError('/x', 'ENOTFOUND');
    expect(isOpencodeUnreachableError(err)).toBe(true);
    expect(isOpencodeHttpError(err)).toBe(false);
    expect(isOpencodeTimeoutError(err)).toBe(false);
  });
});

describe('cross-class invariants', () => {
  it('all three subclasses are catchable via single Error catch', () => {
    const errors: unknown[] = [
      new OpencodeHttpError('/x', 502),
      new OpencodeTimeoutError('/x', 5000),
      new OpencodeUnreachableError('/x', 'ECONNREFUSED'),
    ];
    for (const err of errors) {
      try {
        throw err;
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });

  it('kind discriminator is mutually exclusive', () => {
    const http = new OpencodeHttpError('/x', 502);
    const timeout = new OpencodeTimeoutError('/x', 5000);
    const unreach = new OpencodeUnreachableError('/x', 'ECONNREFUSED');
    expect(http.kind).toBe('http');
    expect(timeout.kind).toBe('timeout');
    expect(unreach.kind).toBe('unreachable');
  });
});
