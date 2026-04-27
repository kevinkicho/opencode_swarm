// vitest-axe ships a type augmentation that targets the legacy `Vi`
// namespace, which vitest 2.x replaced with module-level declarations.
// This shim re-exports the matchers' types onto the current
// `Assertion<T>` interface so `expect(results).toHaveNoViolations()`
// type-checks under vitest 2.

import 'vitest';
import type { AxeResults } from 'axe-core';

interface ToHaveNoViolations<T = unknown> {
  toHaveNoViolations(): T;
}

declare module 'vitest' {
  interface Assertion<T = AxeResults> extends ToHaveNoViolations<T> {}
  interface AsymmetricMatchersContaining extends ToHaveNoViolations {}
}

export {};
