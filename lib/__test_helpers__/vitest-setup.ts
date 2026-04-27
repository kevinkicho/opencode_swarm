// Vitest setup — runs before every test file.
//
// 1. Extends `expect` with `toHaveNoViolations` so component a11y tests
//    can read like `expect(await axe(html)).toHaveNoViolations()`.
// 2. Auto-cleanup of mounted React trees between tests in jsdom-env files
//    (testing-library handles this when the env is `jsdom`; in `node`
//    files the import is a no-op).
//
// This file is loaded for the unit/component layer only — see
// vitest.config.ts. Integration tests skip it.

import { expect, afterEach } from 'vitest';
// vitest-axe ships matchers as a sub-export; the named import keeps the
// matcher object available without polluting global types.
import * as matchers from 'vitest-axe/matchers';
import 'vitest-axe/extend-expect';

expect.extend(matchers);

// `cleanup` is only meaningful in jsdom files. Importing it in node
// files is harmless — it just no-ops because no roots were mounted.
afterEach(async () => {
  if (typeof document !== 'undefined') {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  }
});
