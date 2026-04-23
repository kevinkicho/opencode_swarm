'use client';

// Global ChunkLoadError catcher. Wraps the app and reloads the page when
// webpack loses a chunk — which happens routinely in dev during file-save
// recompiles, especially on WSL where polling adds latency.
//
// Why not rely only on lazy-with-retry? That wrapper catches import
// failures from our own `dynamic()` loaders. But ChunkLoadError also
// bubbles from webpack's internal `__webpack_require__.e` path (HMR
// chunk re-fetches, parallel route chunks, etc.) which never hits our
// wrapper. This component catches ALL such failures at the window
// level and reloads instead of crashing the tab.
//
// Reload UX: the URL carries all state this app needs (swarmRun,
// inspector open, etc.), so window.location.reload() returns you to
// the exact view after ~1s. Cheaper than crashing.

import { useEffect, useState } from 'react';

function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === 'object') {
    const e = err as { name?: string; message?: string };
    if (e.name === 'ChunkLoadError') return true;
    if (typeof e.message === 'string' && /Loading chunk .* failed/.test(e.message)) return true;
  }
  return false;
}

export function ChunkErrorReload() {
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    // Per-tab dedupe so rapid-fire errors don't schedule N reloads.
    let scheduled = false;

    const scheduleReload = (reason: string) => {
      if (scheduled) return;
      scheduled = true;
      setReloading(true);
      console.warn(`[chunk-error-reload] ${reason} — reloading in 800ms`);
      window.setTimeout(() => {
        window.location.reload();
      }, 800);
    };

    const onError = (event: ErrorEvent) => {
      if (isChunkLoadError(event.error) || isChunkLoadError({ message: event.message })) {
        scheduleReload('ChunkLoadError on window');
        event.preventDefault();
      }
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      if (isChunkLoadError(event.reason)) {
        scheduleReload('ChunkLoadError on unhandledrejection');
        event.preventDefault();
      }
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  if (!reloading) return null;
  // Minimal overlay so the user knows why the tab briefly stalls. Styled
  // inline so it's guaranteed to render even if CSS chunks are what
  // failed to load.
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.6)',
        color: '#e5e7eb',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        letterSpacing: '0.05em',
      }}
    >
      reloading · dev chunk was invalidated mid-compile
    </div>
  );
}
