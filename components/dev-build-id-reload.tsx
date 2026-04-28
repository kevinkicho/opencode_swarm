'use client';

// Mounts the dev-build-id staleness detector. Sibling to ChunkErrorReload
// — both are tab-level safety nets against running stale dev code.
//
// ChunkErrorReload catches mid-compile webpack chunk losses (sync HMR
// failure mode). useDevBuildId catches the slower / quieter case: a
// full server restart that leaves the tab's JS pre-fix while the
// server is post-fix, with no error fired anywhere.
//
// Together they close the staleness gap that drove 5+ days of
// "fixes don't take effect" reports — the user couldn't reliably
// hard-reload (Ctrl+Shift+R wasn't always firing), so the tab kept
// running pre-fix code with no signal. This component pulls the
// detection responsibility out of the user's hands.

import { useDevBuildId } from '@/lib/use-dev-build-id';

export function DevBuildIdReload() {
  useDevBuildId();
  return null;
}
