'use client';

// Thin wrapper around React.Profiler. Logs one line per render that exceeds
// SLOW_RENDER_THRESHOLD_MS, so normal operation stays quiet but slow
// re-renders get surfaced in dev stdout with a stable prefix:
//
//   grep '^\[profiler\]' <dev-output>
//
// Dev-only. In production, renders the children directly without wrapping
// — React.Profiler has a small-but-real cost (each render triggers the
// callback) that we don't need to pay in prod.
//
// Usage:
//   <ProfileBoundary id="page-inner">
//     <PageInner />
//   </ProfileBoundary>
//
// `id` should be a short human-readable label so log lines are greppable
// ("page-inner", "board-rail", etc. — not "uuid-abc123").

import { Profiler, type ReactNode } from 'react';

// Render durations below this threshold aren't worth logging. 16ms is the
// frame budget at 60Hz — anything under it is by definition smooth. We pick
// 50ms so only genuinely painful renders surface, not incidental ones.
const SLOW_RENDER_THRESHOLD_MS = 50;

interface Props {
  id: string;
  children: ReactNode;
}

export function ProfileBoundary({ id, children }: Props) {
  if (process.env.NODE_ENV === 'production') {
    return <>{children}</>;
  }
  return (
    <Profiler
      id={id}
      onRender={(profilerId, phase, actualDuration) => {
        if (actualDuration < SLOW_RENDER_THRESHOLD_MS) return;
        // eslint-disable-next-line no-console
        console.log(
          `[profiler] ${profilerId} ${phase} ${actualDuration.toFixed(1)}ms`,
        );
      }}
    >
      {children}
    </Profiler>
  );
}
