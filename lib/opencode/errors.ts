//
// Pre-fix: lib/opencode/{client,live}.ts threw bare
// `new Error(\`opencode ${path} -> HTTP ${res.status}\`)` at 5 sites.
// Consumers wanting to discriminate retry-vs-abort had to substring-
// match the message — fragile against any future error-string edit
// for clarity. Typed errors replace the substring match with
// `instanceof` checks.
//
// Three concrete subclasses cover the failure modes we hit:
//   - OpencodeHttpError: opencode returned a non-2xx response (HTTP shape known)
//   - OpencodeTimeoutError: client-side AbortController fired or fetch hung
//   - OpencodeUnreachableError: fetch itself threw (ECONNREFUSED, ENOTFOUND)
//
// All extend Error so legacy `catch (err) { console.warn(err) }` still
// works. The discriminator is the `kind` field; `instanceof` works the
// same way too.

export type OpencodeErrorKind =
  | 'http'
  | 'timeout'
  | 'unreachable';

abstract class OpencodeError extends Error {
  abstract readonly kind: OpencodeErrorKind;
  constructor(message: string) {
    super(message);
    // Restore the prototype chain — TypeScript's __extends + ES5 target
    // can otherwise leave instanceof broken on subclasses.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

export class OpencodeHttpError extends OpencodeError {
  readonly kind = 'http' as const;
  constructor(
    public readonly path: string,
    public readonly status: number,
    public readonly detail?: string,
  ) {
    super(
      `opencode ${path} -> HTTP ${status}${detail ? `: ${detail}` : ''}`,
    );
  }
}

export class OpencodeTimeoutError extends OpencodeError {
  readonly kind = 'timeout' as const;
  constructor(
    public readonly path: string,
    public readonly elapsedMs: number,
  ) {
    super(`opencode ${path} -> client timeout after ${elapsedMs}ms`);
  }
}

export class OpencodeUnreachableError extends OpencodeError {
  readonly kind = 'unreachable' as const;
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`opencode ${path} -> unreachable: ${reason}`);
  }
}

// Convenience type guards for callers that prefer narrowing over
// instanceof. Both work; instanceof catches subclasses, the kind check
// is one less import for downstream files.
export function isOpencodeHttpError(err: unknown): err is OpencodeHttpError {
  return err instanceof OpencodeHttpError;
}
export function isOpencodeTimeoutError(err: unknown): err is OpencodeTimeoutError {
  return err instanceof OpencodeTimeoutError;
}
export function isOpencodeUnreachableError(err: unknown): err is OpencodeUnreachableError {
  return err instanceof OpencodeUnreachableError;
}
