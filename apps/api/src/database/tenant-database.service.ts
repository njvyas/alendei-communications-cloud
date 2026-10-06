import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  withTenantTransaction,
  type Database,
  type TenantSession,
  type Transaction,
} from '@acc/db';

import { ERROR_CODES } from '@acc/contracts';
import { HttpStatus } from '@nestjs/common';

import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { APP_DB, AUTH_DB } from './database.tokens';

/**
 * The one transaction exempt from the pre-commit coverage check: the
 * `authorization.denied` record `AuthorizationService` commits on its own
 * before raising a refusal (ADR-005 D-6). It carries no business mutation, and
 * on a route that checks a precondition permission before the declared one
 * (`POST /organizations`) it commits before the declared permission is recorded
 * — checking it would turn a correct `403` into a `500` and lose the record.
 */
export const DENIAL_RECORD = 'authorization-denied-record';

export interface TenantTransactionOptions {
  readonly coverageExempt?: typeof DENIAL_RECORD;
}

/**
 * Work a tenant transaction must see done after it has released its
 * connection and before its outcome reaches its caller (`whenReleased`).
 *
 * One per `withTenant` call, in its own async storage — never on the mutable
 * request context, where it would outlive the transaction and be flushed by
 * the wrong one. `open` turns false the moment the transaction settles, so
 * work registered by a straggler can never be silently dropped.
 */
interface ReleaseScope {
  readonly pending: (() => Promise<void>)[];
  open: boolean;
}

const releaseScopes = new AsyncLocalStorage<ReleaseScope>();

/**
 * The single sanctioned entry point for tenant-scoped database access.
 *
 * Every call runs inside one transaction whose tenant context is established
 * with `SET LOCAL` (`TENANCY.md` §5, `DATABASE.md` §14a). Because that context
 * resets at transaction end — on commit and on rollback alike — a pooled
 * connection can never carry one tenant's context into another's work.
 */
@Injectable()
export class TenantDatabase {
  private readonly logger = new Logger(TenantDatabase.name);

  constructor(
    @Inject(APP_DB) private readonly appDb: Database,
    @Inject(AUTH_DB) private readonly authDb: Database,
  ) {}

  /**
   * Runs `work` under an explicit tenant context.
   *
   * Callers must derive `session` from validated authentication material or from
   * an event/job envelope's designated authoritative fields — never from request
   * body, query or path data (`TENANCY.md` §§2, 5).
   *
   * The last step before commit is the authorization-coverage check (see
   * `assertCoverageBeforeCommit`): it runs inside the transaction, so a failure
   * rolls the whole unit of work back.
   */
  async withTenant<T>(
    session: TenantSession,
    work: (tx: Transaction) => Promise<T>,
    options: TenantTransactionOptions = {},
  ): Promise<T> {
    const scope: ReleaseScope = { pending: [], open: true };
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      const value = await releaseScopes.run(scope, () =>
        withTenantTransaction(this.appDb, session, async (tx) => {
          const result = await work(tx);
          if (options.coverageExempt !== DENIAL_RECORD) await this.assertCoverageBeforeCommit(tx);
          return result;
        }),
      );
      outcome = { ok: true, value };
    } catch (error) {
      outcome = { ok: false, error };
    }
    scope.open = false;

    // The transaction has committed or rolled back and its connection is back
    // in the pool, so the pending work can take one of its own without nesting
    // (ADR-015 R-1, R-12). It runs before the outcome is released to the
    // caller — a refusal therefore reaches the client only after its record
    // has committed — and a failure here replaces the outcome: fail closed.
    for (const pending of scope.pending) await pending();

    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * Runs `work` once no tenant connection is held (ADR-005 D-6 as amended by
   * ADR-015 R-12) — the one sanctioned way to write an independently
   * committing record from inside a tenant transaction.
   *
   * Inside `withTenant` the work is queued and run by it after the
   * transaction has settled and released its connection, and before the
   * transaction's result or error propagates; if it fails, that failure is what
   * propagates. Outside any tenant transaction it runs immediately. Called from
   * anywhere else that holds a connection — a bare identity transaction — it
   * still runs immediately, and the pool guard refuses its acquisition: the
   * caller fails closed rather than nesting.
   */
  async whenReleased(work: () => Promise<void>): Promise<void> {
    const scope = releaseScopes.getStore();
    if (!scope) return work();
    if (!scope.open) {
      throw new Error('tenant database: work registered after its transaction had settled');
    }
    scope.pending.push(work);
  }

  /**
   * Refuses to commit a write on a route whose declared permission was never
   * checked (`@RequiresPermission`, `AuthorizationCoverageInterceptor`).
   *
   * **Containment, not enforcement.** The service's own
   * `AuthorizationService.assert`, before the write, remains the authorization
   * decision. This only ensures that when that check is missing, the detection
   * happens while the transaction is still open — so the mutation and its
   * success audit row roll back instead of committing behind a `500`.
   *
   * Only a transaction that wrote is refused: `pg_current_xact_id_if_assigned()`
   * is non-null exactly when this transaction has written or row-locked. A read
   * — including one that legitimately runs before the check, in an earlier
   * transaction of the same request — is unaffected, and its response is still
   * suppressed by the interceptor. Outside a request, or on a route with no
   * declaration, there is nothing to compare and nothing is checked.
   */
  private async assertCoverageBeforeCommit(tx: Transaction): Promise<void> {
    const declared = RequestContext.declaredPermission();
    if (declared === null) return;
    const performed = RequestContext.authorizationChecks();
    if (performed.includes(declared)) return;

    const { rows } = await tx.execute<{ wrote: boolean }>(
      sql`select pg_current_xact_id_if_assigned() is not null as wrote`,
    );
    if (!rows[0]?.wrote) return;

    // Same rendering as the interceptor's: a generic `500` carrying only the
    // correlation id, so the caller learns nothing about which route is wrong.
    this.logger.error({
      msg: 'write on a route whose declared permission was never checked — rolling back',
      declared,
      performed,
    });
    throw new Error('authorization coverage: declared permission was never checked before commit');
  }

  /**
   * Runs `work` under the tenant context of the current authenticated request.
   * Fails closed when no principal has been resolved.
   */
  async withRequestTenant<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const principal = RequestContext.get()?.principal;
    if (!principal) {
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_CREDENTIAL_REQUIRED,
        message: 'Authentication is required',
      });
    }

    return this.withTenant(
      {
        orgId: principal.tenant.orgId,
        workspaceId: principal.tenant.workspaceId,
        resellerId: principal.tenant.resellerId,
        userId: principal.userId,
        isPlatformAdmin: principal.tenant.isPlatformAdmin,
      },
      work,
    );
  }

  /**
   * Identity-resolution access, used only before a tenant context exists
   * (credential verification, API key lookup, WebSocket ticket consumption).
   */
  get auth(): Database {
    return this.authDb;
  }
}
