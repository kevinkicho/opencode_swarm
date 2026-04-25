'use client';

import clsx from 'clsx';
import { useEffect, useState, type RefObject } from 'react';

// Floating "jump to latest" affordance. Tracks the scroll position of its
// parent container ref and fades in when the user is far enough from the
// bottom that they'd miss new items arriving. Click scrolls to the tail
// smoothly. Parent must be `position: relative` (all our main-view
// sections already are) so this anchors correctly.
//
// Reusable across timeline / cards / any future main-view surface — the
// scroll container is the only axis of variation, so a ref is enough.

// Lowered from 200 → 80 (2026-04-24): users reported the button
// frequently invisible even when there were dozens of rows below the
// viewport but they were "near" the bottom. 80 px (~2 row heights)
// is sensitive enough to surface the affordance whenever there's any
// useful scroll-down to do, without flickering on micro-scrolls.
const THRESHOLD_PX = 80;

export function ScrollToBottomButton({
  scrollRef,
  label = 'latest',
  align = 'right',
}: {
  scrollRef: RefObject<HTMLElement>;
  label?: string;
  // Which side of the container to anchor. Timeline wants right (the
  // search/filter chrome is up top); we keep `left` as an option for
  // views where the right edge already has content.
  align?: 'left' | 'right';
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setVisible(distance > THRESHOLD_PX);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    // Content-size changes (new events stream in) don't fire scroll, so
    // observe size too — otherwise the button stays hidden when the user
    // scrolled up and new rows arrive beneath them.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Children's size changes don't always trigger RO on the element
    // itself; observe the first child so row-level reflow registers.
    if (el.firstElementChild) ro.observe(el.firstElementChild as Element);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [scrollRef]);

  const onClick = () => {
    const el = scrollRef.current;
    if (!el) return;
    // 4-phase snap — synchronous scrollTop, then rAF, then two timed
    // passes. Catches every common case where scrollHeight grows
    // between the snap and full layout settling: incremental SSE
    // arrivals during the animation, lazy row heights resolving after
    // commit, and async fetches that append more rows ~100-400 ms
    // later. Without the late-pass timeouts, "click latest" lands
    // visibly short of bottom on long timelines that are still
    // streaming in. (User report 2026-04-24.)
    const snap = () => {
      const cur = scrollRef.current;
      if (cur) cur.scrollTop = cur.scrollHeight;
    };
    snap();
    requestAnimationFrame(snap);
    window.setTimeout(snap, 120);
    window.setTimeout(snap, 400);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="scroll to latest"
      className={clsx(
        'absolute bottom-3 z-20 h-6 px-2.5 rounded-sm hairline bg-ink-850/90 backdrop-blur',
        'font-mono text-micro uppercase tracking-widest2 text-fog-300 hover:text-molten hover:border-molten/40',
        'transition-all cursor-pointer flex items-center gap-1.5',
        align === 'right' ? 'right-4' : 'left-4',
        visible ? 'opacity-100 translate-y-0 pointer-events-auto' : 'opacity-0 translate-y-1 pointer-events-none',
      )}
    >
      <span>{label}</span>
      <span aria-hidden className="text-[10px] leading-none">↓</span>
    </button>
  );
}
