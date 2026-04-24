'use client';

// react-scan — runtime visualizer that outlines every rendering component
// with timing info. Perfect for chasing "why does this tab render slowly?"
// questions: switch to the suspect tab, watch which elements flash red
// (slow) or rerender excessively.
//
// Dev-only. In production NODE_ENV !== 'development' → the effect is a
// no-op so no scan code ships to real users.
//
// Why mount here via useEffect rather than import scan() at module scope:
// react-scan wants to attach after React's reconciler exists, and mounting
// in an effect gives us that guarantee without SSR surprises. Also keeps
// the import dynamic so the package is eliminated from the client bundle
// in production builds.

import { useEffect } from 'react';

export function ReactScanProbe() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    // Dynamic import so the package isn't bundled in production builds
    // (even with the env guard, static imports pull the code into the
    // graph). Call scan() once on mount.
    void import('react-scan').then(({ scan }) => {
      scan({
        enabled: true,
        // Default overlay config. Tune later if the visuals get noisy —
        // the package exposes per-component filtering and slowdown thresholds.
      });
    });
  }, []);

  return null;
}
