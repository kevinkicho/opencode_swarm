'use client';

// @axe-core/react — runtime accessibility auditor that walks the React
// tree on every commit and logs violations to the browser console with
// a stack-trace back to the offending component. Same idea as
// react-scan-probe.tsx but for a11y rather than perf.
//
// Catches things axe-during-Playwright-runs only finds when a probe
// happens to be on the right route at the right time. By contrast, this
// runs continuously as the user clicks through the app — so any new
// violation surfaces the moment it ships, not during the next probe
// cycle.
//
// Dev-only: production NODE_ENV → no-op, dynamic import keeps the bundle
// clean. Mounted alongside ReactScanProbe in app/layout.tsx.

import { useEffect } from 'react';

export function AxeReactProbe() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    // Dynamic import (parallel with react/react-dom which are already
    // loaded). The 1000ms throttle is axe's recommended interval —
    // anything tighter floods the console during state-heavy pages
    // like the rich-run timeline.
    void Promise.all([
      import('react'),
      import('react-dom'),
      import('@axe-core/react'),
    ]).then(([React, ReactDOM, axe]) => {
      axe.default(React.default, ReactDOM.default, 1000);
    });
  }, []);

  return null;
}
