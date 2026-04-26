// HARDENING_PLAN.md#D6 — vitest shim for the `server-only` directive.
//
// Every file under lib/server/ declares `import 'server-only';` so the
// Next.js bundler refuses to ship them into the client. Vitest's Vite
// resolver doesn't know about that convention and fails to find the
// package. Aliasing 'server-only' → this file in vitest.config.ts gives
// it a no-op module to load. Production builds never hit this shim —
// Next.js resolves the real package.
export {};
