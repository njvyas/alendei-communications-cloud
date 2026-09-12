'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            // An authorization or validation failure will not succeed on retry;
            // the API tells us which errors are worth retrying via `retryable`.
            retry: (failureCount, error) =>
              failureCount < 2 && (error as { retryable?: boolean }).retryable === true,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
