'use client';

// Throttled version of a React value. Updates the output at most every `ms`
// milliseconds during rapid streaming. The first change after a quiet period
// lands immediately (leading edge); subsequent changes within the window are
// coalesced into a single trailing update.
//
// Why: SSE events update `slots` ~24×/s during active streaming (6 workers
// × ~4 events/s each). Each update triggers toMessages + 7 more transform
// passes + buildTurns + render — a full pipeline recomputation on every
// tick. Throttling at 200ms cuts recomputation by ~4–5× with no perceptible
// lag (users see streaming text at ~5Hz instead of ~24Hz, well above the
// ~3Hz threshold where text feels "live").

import { useEffect, useRef, useState } from 'react';

export function useThrottledValue<T>(value: T, ms: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastFire = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Always track the latest value so the trailing timer fires with the
  // most recent input, not the one from the effect closure that scheduled it.
  const latestRef = useRef(value);
  latestRef.current = value;

  useEffect(() => {
    const now = performance.now();
    const remaining = ms - (now - lastFire.current);

    if (remaining <= 0) {
      lastFire.current = now;
      setThrottled(value);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    } else if (timerRef.current === null) {
      // Schedule a trailing update that reads the *latest* value.
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        lastFire.current = performance.now();
        setThrottled(latestRef.current);
      }, remaining);
    }
    // else: trailing timer already scheduled — it will pick up the latest
    // value via latestRef when it fires.

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [value, ms]);

  return throttled;
}