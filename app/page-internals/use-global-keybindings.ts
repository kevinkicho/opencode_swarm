'use client';

// Global keybindings for the main page (#7.Q26 decomposition wave 2).
//
// Today: Cmd/Ctrl-K opens (or toggles) the command palette; Cmd/Ctrl-N
// opens the new-run modal. Bindings sit at the document level so they
// fire regardless of what's focused. Adding more shortcuts later
// belongs here — keeps the binding table in one place instead of
// scattered across PageBody.
//
// Bindings depend on the modals hub's `togglePalette` + `newRun`
// openers. The hook captures those by closure; consumers don't need
// to wire keys themselves.

import { useEffect } from 'react';
import type { PageModalState } from './use-modal-state';

export function useGlobalKeybindings(modals: PageModalState): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        modals.openers.togglePalette();
      } else if (k === 'n') {
        e.preventDefault();
        modals.openers.newRun();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // openers are referentially stable (useCallback with no deps), so
    // depending on `modals` is safe — it won't re-arm on every render.
  }, [modals]);
}
