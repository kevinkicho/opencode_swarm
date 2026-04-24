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
// The devtools panel is rendered inline; its bundle only ships in dev
// because the import is wrapped with a NODE_ENV check below.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let devtoolsComponent: React.ComponentType<any> | null = null;
if (process.env.NODE_ENV !== 'production') {
  // Eager import — this file is 'use client' so it's only bundled for the
  // browser, and the NODE_ENV check tree-shakes the import in prod builds.
  // Static import, not await, so the component is available on first
  // render in dev.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ReactQueryDevtools } = require('@tanstack/react-query-devtools');
  devtoolsComponent = ReactQueryDevtools;
}

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
  const Devtools = devtoolsComponent;
  return (
    <QueryClientProvider client={client}>
      {children}
      {Devtools && <Devtools initialIsOpen={false} buttonPosition="bottom-left" />}
    </QueryClientProvider>
  );
}
