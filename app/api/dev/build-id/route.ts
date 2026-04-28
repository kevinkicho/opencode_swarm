// GET /api/dev/build-id — returns the dev server's instance id.
//
// Used by the client-side staleness detector (lib/use-dev-build-id.ts):
// every dev-server restart gets a fresh module-load timestamp; the
// client compares the value it captured at page load vs the current
// value, and forces a reload on mismatch. Without this, a developer
// (or the user) can sit on a tab with stale JS for hours after a
// hot-reload glitch leaves the page running pre-fix code, and there's
// no in-app signal that the running tab is no longer current.
//
// 5+ days of recurring "fixes don't take effect" reports from the user
// that root-caused to exactly this — Ctrl+Shift+R wasn't firing for
// reasons we couldn't diagnose, the page kept running stale code, and
// there was no automatic detection. This route + its client hook
// closes that gap.
//
// Production behavior: in production builds (NODE_ENV !== 'development'),
// the route returns a stable `production` id so client-side staleness
// detection becomes a no-op.

import 'server-only';
import { NextResponse } from 'next/server';

// Captured once per module load. Next.js dev creates a fresh module
// graph on every restart, so this gets a new value every `npm run dev`.
const SERVER_INSTANCE_ID =
  process.env.NODE_ENV === 'development'
    ? `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : 'production';

export async function GET(): Promise<Response> {
  return NextResponse.json(
    { id: SERVER_INSTANCE_ID },
    { headers: { 'cache-control': 'no-store' } },
  );
}
