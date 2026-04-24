'use client';

// Global TanStack Query client provider. Mounted at the root layout so
// every component can `useQuery()` without re-instantiating a client.
//
// Defaults picked for this app's shape:
//   - staleTime 4000ms: the old polling cadence; components get instant
//     cache hits within 4s of a fetch, and the fetcher re-validates in
//     the background after that.
//   - refetchOnWindowFocus: true — matches the "live status when user
//     returns to the tab" UX users expect; cheap because cached data
//     renders instantly while the revalidation flies.
//   - refetchOnReconnect: true — same reasoning for network recovery.
//   - retry: 1 — a flaky connection once is normal, twice is a real
//     problem and we want the error to surface quickly so the caller
//     can fall back.
//
// Devtools loaded via `next/dynamic({ ssr: false })` — earlier we used
// a top-level `require()` guarded on NODE_ENV, but `require` in a
// 'use client' module still evaluates at server-side bundle time,
// which pulled in a second copy of @tanstack/react-query and split
// the React context (the SSR-rendered useQuery couldn't see the
// provider's QueryClient → "No QueryClient set" internal errors on
// every page load 2026-04-24). Dynamic with ssr:false defers the
// devtools entirely to client-side post-hydration.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';

const Devtools =
  process.env.NODE_ENV !== 'production'
    ? dynamic(
        () =>
          import('@tanstack/react-query-devtools').then(
            (m) => m.ReactQueryDevtools,
          ),
        { ssr: false },
      )
    : null;

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 4_000,
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
            retry: 1,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      {children}
      {Devtools && <Devtools initialIsOpen={false} buttonPosition="bottom-left" />}
    </QueryClientProvider>
  );
}
