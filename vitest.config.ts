import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Vitest config — minimal, matches the project's tsconfig conventions.
//
// Test layout:
//   - Co-located: `lib/**/__tests__/*.test.ts` for module-scoped unit tests
//     (parsers, transforms, helpers — no opencode/network dependency).
//   - Top-level: `tests/integration/*.test.ts` for tests that hit the live
//     stack (dev server + opencode). Gated on env so CI runs only the unit
//     layer by default; integration tests opt-in via VITEST_INTEGRATION=1.
//
// Why vitest: native ESM (matches our `module: esnext` tsconfig), fast,
// Vite-style config, identical assertion API to jest. Not adding jest
// because vitest covers everything we need with less ceremony.
export default defineConfig({
  test: {
    // Resolve `@/*` paths the same way Next.js does (matches tsconfig.json
    // `paths`). Without this, imports like `@/lib/server/...` would fail
    // in tests.
    alias: {
      '@/': path.resolve(__dirname, './') + '/',
    },
    // Default: only the unit layer. Integration tests are heavyweight and
    // require a running dev server + opencode + network — opt-in via
    // env var so CI doesn't try to spawn real swarm runs on every push.
    include: process.env.VITEST_INTEGRATION
      ? ['tests/integration/**/*.test.ts']
      : ['lib/**/__tests__/**/*.test.ts'],
    // Reasonable defaults for our use case.
    environment: 'node',
    globals: false, // explicit imports — no surprise globals
    // Integration tests can take a couple minutes if they spawn a real
    // run; bump from the 5s default. Unit tests should land well under.
    testTimeout: process.env.VITEST_INTEGRATION ? 180_000 : 10_000,
    // Skip node_modules and build outputs.
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**'],
  },
});
