'use client';

// Core Web Vitals reporter. Uses Next 14's built-in useReportWebVitals hook
// (no separate `web-vitals` package needed — Next bundles it). Logs each
// metric to console with a stable prefix so dev-stdout greps can isolate
// them:
//
//   grep '^\[web-vitals\]' <dev-output>
//
// Metrics we capture:
//   - LCP  (Largest Contentful Paint) — when the main content first shows
//   - INP  (Interaction to Next Paint) — how laggy clicks/keypresses feel
//   - CLS  (Cumulative Layout Shift)   — how jumpy the layout is
//   - FCP  (First Contentful Paint)    — when any content first shows
//   - TTFB (Time to First Byte)        — server + network pre-content
//
// Thresholds (from web.dev/vitals):
//   LCP  : good ≤ 2500ms, poor > 4000ms
//   INP  : good ≤ 200ms,  poor > 500ms
//   CLS  : good ≤ 0.1,    poor > 0.25
//
// These numbers are mostly meaningful against a prod build (`next start`).
// Against dev, LCP/FCP will be inflated by on-demand compile. Use them
// anyway for relative comparison across navigations.

import { useReportWebVitals } from 'next/web-vitals';

type Severity = 'good' | 'needs-improvement' | 'poor';

function severity(name: string, value: number): Severity {
  switch (name) {
    case 'LCP':
      return value <= 2500 ? 'good' : value <= 4000 ? 'needs-improvement' : 'poor';
    case 'INP':
      return value <= 200 ? 'good' : value <= 500 ? 'needs-improvement' : 'poor';
    case 'CLS':
      return value <= 0.1 ? 'good' : value <= 0.25 ? 'needs-improvement' : 'poor';
    case 'FCP':
      return value <= 1800 ? 'good' : value <= 3000 ? 'needs-improvement' : 'poor';
    case 'TTFB':
      return value <= 800 ? 'good' : value <= 1800 ? 'needs-improvement' : 'poor';
    default:
      return 'needs-improvement';
  }
}

export function WebVitalsReporter() {
  useReportWebVitals((metric) => {
    if (process.env.NODE_ENV === 'production') {
      // Production shape reserved for a later /api/perf/web-vitals POST
      // when we have a backend bucket for it. For now, no-op in prod so
      // we don't leak log noise to end users.
      return;
    }
    const sev = severity(metric.name, metric.value);
    // Millisecond metrics (LCP/INP/FCP/TTFB) get rounded for readability;
    // CLS is a unitless ratio so keep its full precision.
    const display =
      metric.name === 'CLS'
        ? metric.value.toFixed(3)
        : `${Math.round(metric.value)}ms`;
    // eslint-disable-next-line no-console
    console.log(
      `[web-vitals] ${metric.name}=${display} (${sev}) id=${metric.id}`,
    );
  });

  return null;
}
