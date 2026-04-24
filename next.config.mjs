import bundleAnalyzer from '@next/bundle-analyzer';

// Bundle analyzer: opt-in via env flag so the default build stays fast.
// `npm run perf:bundle` sets ANALYZE=true, which opens an interactive
// treemap showing what's in each route's initial JS. Use this to chase
// "why is the first page load huge?" questions.
const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Dev-phase cache kill-switch. HMR is fine but raw hard-refreshes can
  // still deliver a stale page because some browsers cache the initial
  // HTML aggressively. no-store on every path during dev eliminates that
  // class of "is this a cache problem?" debugging. Guarded on NODE_ENV
  // so production builds emit clean, cacheable headers.
  async headers() {
    if (process.env.NODE_ENV !== 'development') return [];
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, proxy-revalidate' },
          { key: 'Pragma', value: 'no-cache' },
          { key: 'Expires', value: '0' },
        ],
      },
    ];
  },
};

export default withBundleAnalyzer(nextConfig);
