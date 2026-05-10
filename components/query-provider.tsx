'use client';

// Global TanStack Query client provider. Mounted at the root layout so
// every component can `useQuery()` without re-instantiating a client.
//
// Defaults picked for this app's shape:
//   - staleTime 30000ms: generous window so SSE-driven invalidation is
//     the primary freshness signal; queries only go to the network if
//     explicitly invalidated or the 30s window expires with no SSE
//     activity.
//   - refetchOnWindowFocus: true — matches the "live status when user
//     returns to the tab" UX users expect; cheap because cached data
//     renders instantly while the revalidation flies.
//   - refetchOnReconnect: true — same reasoning for network recovery.
//   - retry: 1 — a flaky connection once is normal, twice is a real
//     problem and we want the error to surface quickly so the caller
//     can fall back.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
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
    </QueryClientProvider>
  );
}
