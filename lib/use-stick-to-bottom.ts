'use client';

// Shared at-bottom state machine for scroll containers across the
// app. Extracted from swarm-timeline.tsx 2026-04-24 after the user
// surfaced that auto-stick-to-bottom only worked in the timeline,
// while every other panel (board-rail, plan-rail, contracts-rail,
// iterations-rail, debate-rail, roles-rail, map-rail, council-rail,
// phases-rail, strategy-rail, heat-rail, etc.) rendered top-anchored.
//
// Model: track whether the user IS at bottom. Initially true (we
// always land at bottom). Stays true until the user manually scrolls
// up past `disengagePx`; goes back to true when they come within
// `reengagePx` of the bottom. While true, every content change auto-
// snaps. Hysteresis between the two thresholds prevents flicker at
// the boundary.
//
// First-render path does a multi-pass snap (synchronous, rAF, +120 ms,
// +400 ms) to handle late-resolving row heights / lazy panels / SSE
// chunks streaming in over the first second after first paint. This
// pattern was proven via Playwright probe in `swarm-timeline.tsx`:
// scrollTop=34 646 / scrollHeight=35 464 (gap 16 px) at every time-
// sample t+8s through t+25s.

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

interface Options {
  // Distance from bottom (px) past which the user is considered
  // to have scrolled away. Stick disengages.
  disengagePx?: number;
  // Distance from bottom (px) within which the user is considered
  // back at bottom. Stick re-engages.
  reengagePx?: number;
  // Default at-bottom state on first mount. true means "snap to
  // bottom on first content"; false means "leave the user at top
  // until they scroll down themselves." Defaults to true since
  // the swarm-style live-update views are the dominant use case.
  initiallyAtBottom?: boolean;
}

const DEFAULT_DISENGAGE_PX = 80;
const DEFAULT_REENGAGE_PX = 24;

export function useStickToBottom<T extends HTMLElement>(
  scrollRef: RefObject<T>,
  // Signal that says "content may have changed." Typically the
  // length of a list, or the messages array reference. The effect
  // re-runs on this changing.
  contentSignal: unknown,
  options: Options = {},
): void {
  const disengage = options.disengagePx ?? DEFAULT_DISENGAGE_PX;
  const reengage = options.reengagePx ?? DEFAULT_REENGAGE_PX;
  const initial = options.initiallyAtBottom ?? true;

  const stickRef = useRef<boolean>(initial);
  // Sentinel for "have we done the multi-pass snap on first non-empty
  // content yet?" Avoids re-running it on every content change.
  const firstSnapDoneRef = useRef<boolean>(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (!firstSnapDoneRef.current) {
      // Wait for non-trivial content before we declare the first-snap
      // done. `contentSignal` going from undefined/empty to populated
      // is the trigger. We can't observe contentSignal directly here —
      // just check the container's scrollHeight as a proxy.
      if (el.scrollHeight <= el.clientHeight + 1) return;
      firstSnapDoneRef.current = true;
      stickRef.current = true;
      const snap = () => {
        const cur = scrollRef.current;
        if (cur) cur.scrollTop = cur.scrollHeight;
      };
      snap();
      requestAnimationFrame(snap);
      const t1 = window.setTimeout(snap, 120);
      const t2 = window.setTimeout(snap, 400);
      return () => {
        window.clearTimeout(t1);
        window.clearTimeout(t2);
      };
    }

    // Subsequent updates: snap only when at-bottom state is true.
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [contentSignal, scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (stickRef.current && distance > disengage) {
        stickRef.current = false;
      } else if (!stickRef.current && distance <= reengage) {
        stickRef.current = true;
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef, disengage, reengage]);
}
