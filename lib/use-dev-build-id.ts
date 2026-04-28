'use client';

// Dev-server staleness detector — auto-reloads the page when the
// dev server has restarted with new code.
//
// Why this exists (5+ days of pain): Ctrl+Shift+R was failing to
// reload the user's tab for reasons we couldn't pin down — a Windows
// browser focus quirk, a keyboard-intercept extension, an HMR
// glitch, take your pick. Net effect: fixes shipped on the server
// but the user's browser kept running pre-fix JS forever, with no
// in-app signal that the tab was stale.
//
// Mechanism (dev only):
//   1. On first mount, GET /api/_dev/build-id → save id locally
//   2. On every visibilitychange (tab regains focus) AND every 30s,
//      GET it again
//   3. If the new id differs from the captured one, hard-reload via
//      `window.location.reload()` — the dev server has restarted
//      with new code and we're stale
//
// Production no-op: the build-id route returns 'production' which
// never changes, so the comparison always equals.

import { useEffect } from 'react';

async function fetchBuildId(): Promise<string | null> {
  try {
    const res = await fetch('/api/dev/build-id', { cache: 'no-store' });
    if (!res.ok) return null;
    const json = (await res.json()) as { id?: string };
    return typeof json.id === 'string' ? json.id : null;
  } catch {
    // Server unreachable — don't reload, the user will see the
    // backend-stale chip from useBackendStale instead.
    return null;
  }
}

export function useDevBuildId(): void {
  useEffect(() => {
    let captured: string | null = null;
    let cancelled = false;

    const reloadIfStale = async () => {
      if (cancelled) return;
      const current = await fetchBuildId();
      if (cancelled) return;
      if (!current) return;
      if (captured === null) {
        captured = current;
        return;
      }
      if (current !== captured) {
        // Server restarted — drop the stale tab. `location.reload()`
        // bypasses any cached JS because the dev server already
        // sends `Cache-Control: no-store`.
        // eslint-disable-next-line no-console
        console.info(
          `[dev] build id changed (${captured} → ${current}) — reloading stale tab`,
        );
        window.location.reload();
      }
    };

    // Initial capture.
    reloadIfStale();

    // Re-check whenever the tab regains focus — the most common case
    // is the user dev-restarts and switches back to the browser tab.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reloadIfStale();
    };
    document.addEventListener('visibilitychange', onVisible);

    // Periodic safety net for tabs left in the foreground (no
    // visibilitychange fires while the user keeps the tab open).
    const interval = window.setInterval(() => {
      void reloadIfStale();
    }, 30_000);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(interval);
    };
  }, []);
}
