import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ERROR_CODES } from '@acc/contracts';

import { AppException } from '../common/errors/app.exception';
import { RequestContext } from '../common/context/request-context';
import { TenantDatabase } from '../database/tenant-database.service';
import type { ResolvedPrincipal } from '../auth/auth.guard';
import { AuthorizationExempt } from '../auth/requires-permission.decorator';
import { WsTicketService } from './ws-ticket.service';

/**
 * WebSocket connection tickets (`API.md` §10, Phase 1B.7 preparation).
 *
 * **Issuance only.** There is no consumption route and no socket gateway — both
 * are deferred (`DECISIONS.md` D15), and a ticket minted today is simply
 * unusable until the phase that builds the gateway arrives. That is deliberate:
 * `API.md` §10 places issuance in Phase 1B precisely so the credential model is
 * settled before anything depends on it.
 *
 * **The endpoint takes no request body**, which is the whole of its scope
 * safety: there is no field through which a caller could name a topic, an
 * organization or a workspace, so the ticket's recorded scope can only be the
 * one computed from the caller's own resolved context.
 */
@Controller('ws')
export class WsTicketController {
  constructor(
    private readonly db: TenantDatabase,
    private readonly tickets: WsTicketService,
  ) {}

  /**
   * Mints a single-use, short-lived ticket bound to the caller's own session
   * and resolved tenant context.
   *
   * **Authorization-exempt, and the reason is the same one `/auth/me/authorization`
   * carries**: the subject is the authenticated principal itself. There is no
   * target resource to check, and the ticket confers exactly the caller's own
   * scope and nothing beyond it — the authority a connection actually exercises
   * is enforced at subscription time against the scope this row records. A
   * permission check here would be checking whether the caller may act on
   * themselves.
   *
   * No `Idempotency-Key`: `API.md` §4 does not list this endpoint, a ticket is
   * cheap and short-lived, and storing a credential-bearing response for replay
   * is the hazard ADR-008 exists to avoid. Two calls simply mint two tickets.
   *
   * The general rate limiter applies as an ordinary authenticated `write`
   * (`API.md` §5a), which bounds ticket minting without a mechanism of its own.
   */
  @Post('ticket')
  @AuthorizationExempt(
    'the subject is the authenticated principal itself — the ticket carries the caller’s own ' +
      'resolved scope and confers nothing beyond it, so there is no target resource to authorize against',
  )
  @HttpCode(HttpStatus.CREATED)
  async issue() {
    const principal = RequestContext.get()?.principal as ResolvedPrincipal | null | undefined;
    if (!principal) {
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_CREDENTIAL_REQUIRED,
        message: 'Authentication is required',
      });
    }

    const data = await this.db.withRequestTenant((tx) => this.tickets.issue(tx, principal));
    return { data };
  }
}
