// HMR-resilient module-export registry.
//
// Next.js server-code HMR replaces modules but doesn't update two kinds
// of bindings held before the reload:
//   - setInterval / setTimeout callbacks whose closures captured module-
//     local functions
//   - Cross-module imports (auto-ticker → coordinator.tickCoordinator)
//     held in the consumer's import slot
//
// Symptom observed 2026-04-23: editing coordinator.ts + restarting the
// ticker still ran the OLD coordinator code because the auto-ticker
// module's captured import binding wasn't refreshed by HMR. Zombie-
// abort fix sat idle for 30 min until a forced content change on
// auto-ticker.ts finally triggered its reload too.
//
// Fix: each module publishes its "live" exports to a Symbol.for-keyed
// slot on globalThis at load time. Consumers resolve from globalThis
// at call time. Because Symbol.for returns the same symbol across
// module reloads, the slot persists; each reload overwrites with the
// latest exports; consumers always see the newest.
//
// Pattern:
//   // producer (e.g. coordinator.ts, at end of module)
//   const KEY = Symbol.for('opencode_swarm.coordinator.exports');
//   publishExports<{ tickCoordinator: typeof tickCoordinator }>(KEY, {
//     tickCoordinator,
//   });
//
//   // consumer (e.g. auto-ticker.ts, at call site)
//   const { tickCoordinator } = liveExports(KEY, { tickCoordinator });
//   await tickCoordinator(runID, opts);
//
// The `fallback` arg to liveExports is the direct import — used only
// before the producer module has loaded (shouldn't normally happen in
// practice; belt-and-suspenders).

// `as any` on globalThis indexes with a Symbol — TypeScript's built-in
// GlobalThis type doesn't model symbol-keyed properties, and the narrow
// casts (`Record<symbol, unknown>`) produce more friction than they save
// for a 2-line helper. At runtime, symbol-keyed globalThis access is a
// standard ES pattern.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGlobal = any;

export function publishExports<T>(key: symbol, exports: T): void {
  (globalThis as AnyGlobal)[key] = exports;
}

export function liveExports<T>(key: symbol, fallback: T): T {
  const slot = (globalThis as AnyGlobal)[key] as T | undefined;
  return slot ?? fallback;
}
