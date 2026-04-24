// Next.js boot hook. Runs once on server startup (and on each
// HMR reload of this file). Use it to wire server-side observability
// that doesn't fit into a Route Handler — log tails, watchdog
// heartbeats, etc.
//
// Boundary: Edge runtime gets a separate `register` invocation;
// nothing here is Edge-compatible (Node fs APIs in the log tail), so
// gate on NEXT_RUNTIME at top.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // F2 — tail opencode's log file into dev stdout. POSTMORTEMS/
  // 2026-04-24. Start always (prod + dev) but keep the import
  // dynamic so an Edge build never tries to resolve it.
  const { startOpencodeLogTail } = await import('./lib/server/opencode-log-tail');
  startOpencodeLogTail();
}
