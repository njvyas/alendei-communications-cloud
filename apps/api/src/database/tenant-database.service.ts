import { Inject, Injectable } from '@nestjs/common';
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
 * The single sanctioned entry point for tenant-scoped database access.
 *
 * Every call runs inside one transaction whose tenant context is established
 * with `SET LOCAL` (`TENANCY.md` §5, `DATABASE.md` §14a). Because that context
 * resets at transaction end — on commit and on rollback alike — a pooled
 * connection can never carry one tenant's context into another's work.
 */
@Injectable()
export class TenantDatabase {
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
   */
  async withTenant<T>(session: TenantSession, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return withTenantTransaction(this.appDb, session, work);
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
