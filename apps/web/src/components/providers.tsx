'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';

import { createAppQueryClient, registerQueryClient } from '@/lib/query-client';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(createAppQueryClient);

  // Registered so that ending a session clears authenticated cached data
  // (`clearAuthenticatedQueryCache`, called by the session store).
  useEffect(() => registerQueryClient(client), [client]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
