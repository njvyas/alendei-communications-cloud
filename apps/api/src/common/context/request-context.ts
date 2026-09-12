import { AsyncLocalStorage } from 'node:async_hooks';

import type { AuthPrincipal } from '@acc/contracts';

/**
 * Per-request ambient context (`OBSERVABILITY.md` §1).
 *
 * `correlationId` is the stable business key that survives sampling and is
 * propagated into every log line, event envelope and audit row for this request.
 * `traceId` is the OpenTelemetry identifier for the same request and is emitted
 * alongside it — the two are deliberately not treated as interchangeable.
 */
export interface RequestContextStore {
  correlationId: string;
  requestId: string;
  causationId: string | null;
  traceId: string | null;
  principal: AuthPrincipal | null;
  ip: string | null;
  userAgent: string | null;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

export const RequestContext = {
  run<T>(store: RequestContextStore, work: () => T): T {
    return storage.run(store, work);
  },

  get(): RequestContextStore | undefined {
    return storage.getStore();
  },

  /**
   * The correlation id for the current request, or a fixed placeholder when
   * called outside one (e.g. during bootstrap). Never throws: an error handler
   * must always be able to report a correlation id.
   */
  correlationId(): string {
    return storage.getStore()?.correlationId ?? 'no-correlation-id';
  },

  setPrincipal(principal: AuthPrincipal): void {
    const store = storage.getStore();
    if (store) store.principal = principal;
  },

  setTraceId(traceId: string): void {
    const store = storage.getStore();
    if (store) store.traceId = traceId;
  },
};
