import { QueryClient, type Query } from '@tanstack/react-query';

/**
 * The console's React Query configuration, and the one place authenticated
 * cached data is discarded when the identity behind it ends (Gate C
 * remediation M-2).
 *
 * Security invariant: USER A signs out → USER B signs in → USER B never renders
 * USER A's cached tenant data. Query keys are partitioned by selected
 * organization, not by identity, and `staleTime` would otherwise let a cached
 * entry be shown without a refetch — so the cache itself is cleared, rather than
 * relying on keys or staleness.
 */

/**
 * Query-key roots that carry no identity or tenant data and are safe to keep
 * across sign-out. Everything else is treated as authenticated.
 */
const PUBLIC_QUERY_ROOTS: ReadonlySet<string> = new Set(['health']);

export function isAuthenticatedQuery(query: Pick<Query, 'queryKey'>): boolean {
  return !PUBLIC_QUERY_ROOTS.has(String(query.queryKey[0]));
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
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
  });
}

const registered = new Set<QueryClient>();

/**
 * Registers a mounted client so session teardown can reach it. Returns the
 * unregister function. Called from an effect, so only browser clients register —
 * never one created for a server render.
 */
export function registerQueryClient(client: QueryClient): () => void {
  registered.add(client);
  return () => {
    registered.delete(client);
  };
}

/**
 * Discards every authenticated query and every mutation in each registered
 * client. In-flight authenticated fetches are cancelled first, so a response
 * requested by the previous identity cannot land in the cache afterwards.
 */
export function clearAuthenticatedQueryCache(): void {
  for (const client of registered) {
    const filter = { predicate: isAuthenticatedQuery };
    void client.cancelQueries(filter);
    client.removeQueries(filter);
    client.getMutationCache().clear();
  }
}
