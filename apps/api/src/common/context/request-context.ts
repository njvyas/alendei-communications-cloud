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
  /**
   * Target-scope checks performed during this request (Phase 1B.5.7).
   *
   * Written by `AuthorizationService.assert` and read by
   * `AuthorizationCoverageInterceptor`, which verifies that the permission a
   * route declared was actually checked. It is a record of what happened, never
   * an input to a decision — nothing authorizes anything by consulting it.
   *
   * Optional and lazily created: it is bookkeeping the runtime fills in, not
   * something a caller opening a context has to know to supply. A store built
   * without it behaves as one with no checks recorded, which is the
   * fail-closed direction for the interceptor that reads it.
   */
  authorizationChecks?: string[];
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

  /**
   * Records that a target-scope check ran for `permission`.
   *
   * Append-only and unconditional: a check that was performed and refused is
   * still a check that was performed, and the coverage cross-check asks whether
   * the route looked, not what the answer was.
   */
  recordAuthorizationCheck(permission: string): void {
    const store = storage.getStore();
    if (!store) return;
    (store.authorizationChecks ??= []).push(permission);
  },

  authorizationChecks(): readonly string[] {
    return storage.getStore()?.authorizationChecks ?? [];
  },
};
