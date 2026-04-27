import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Vitest config — minimal, matches the project's tsconfig conventions.
//
// Test layout:
//   - Co-located: `lib/**/__tests__/*.test.ts` for module-scoped unit tests
//     (parsers, transforms, helpers — no opencode/network dependency).
//   - Co-located component/hook tests: `**/__tests__/*.test.tsx` opt into
//     jsdom via the `// @vitest-environment jsdom` file directive. The
//     default env stays `node` so unit tests don't pay the jsdom tax.
//   - Top-level: `tests/integration/*.test.ts` for tests that hit the live
//     stack (dev server + opencode). Gated on env so CI runs only the unit
//     layer by default; integration tests opt-in via VITEST_INTEGRATION=1.
//
// Why vitest: native ESM (matches our `module: esnext` tsconfig), fast,
// Vite-style config, identical assertion API to jest. Not adding jest
// because vitest covers everything we need with less ceremony.
export default defineConfig({
  // JSX is handled by Next.js (`jsx: preserve` in tsconfig), so we have to
  // tell esbuild to emit the React 17+ automatic runtime here. Without
  // this, .test.tsx files fail with `React is not defined`.
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    // Resolve `@/*` paths the same way Next.js does (matches tsconfig.json
    // `paths`). Without this, imports like `@/lib/server/...` would fail
    // in tests.
    alias: {
      '@/': path.resolve(__dirname, './') + '/',
      // `import 'server-only';`. Next.js bundler resolves this to the
      // real package (a no-op on the server, throw on the client). In
      // vitest we run server-side only, so alias to an empty shim.
      'server-only': path.resolve(__dirname, 'lib/__test_helpers__/server-only-shim.ts'),
    },
    // Default: only the unit layer. Integration tests are heavyweight and
    // require a running dev server + opencode + network — opt-in via
    // env var so CI doesn't try to spawn real swarm runs on every push.
    include: process.env.VITEST_INTEGRATION
      ? ['tests/integration/**/*.test.ts']
      : [
          'lib/**/__tests__/**/*.test.ts',
          'components/**/__tests__/**/*.test.tsx',
          'app/**/__tests__/**/*.test.tsx',
        ],
    setupFiles: process.env.VITEST_INTEGRATION
      ? []
      : ['./lib/__test_helpers__/vitest-setup.ts'],
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
