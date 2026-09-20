import { HttpStatus, Injectable } from '@nestjs/common';
import { AUDIT_ACTIONS, ERROR_CODES, type AuthPrincipal } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';

import { AppException } from '../common/errors/app.exception';
import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AppConfigService } from '../config/app-config.service';
import { issueWsTicket } from './ws-ticket';

/**
 * A minted ticket, as the caller receives it.
 *
 * `ticket` is the plaintext and appears **only** here, on the response to the
 * request that minted it. The stored hash is never part of this shape and no
 * read path exists that could return it — there is no ticket read endpoint at
 * all.
 */
export interface WsTicketView {
  readonly id: string;
  /** Plaintext, presented exactly once. */
  readonly ticket: string;
  readonly expiresAt: string;
  /** The topics this ticket admits subscription to. Computed, never requested. */
  readonly scope: readonly string[];
  readonly orgId: string;
  readonly workspaceId: string | null;
}

/**
 * WebSocket connection-ticket issuance (`API.md` §10/§10a, `TENANCY.md` §4b).
 *
 * **Issuance only.** Consumption and the socket gateway are deferred
 * (`DECISIONS.md` D15), so nothing here marks a ticket consumed, and
 * `TESTING.md` §6i's consumption, replay and subscription cases remain
 * unexercisable by design rather than by omission.
 *
 * ---
 *
 * **The point of the ticket is that the socket never resolves scope.** A
 * query-string JWT leaks into proxy logs and browser history, and a socket that
 * re-derived tenancy from what the client sent would be trusting the one input
 * the HTTP path refuses to trust. So the decision is made here, over an
 * authenticated HTTP request, and *recorded on the row*: the connection later
 * binds to what the ticket says and to nothing the client asserts.
 *
 * **Scope is computed, not requested.** There is no field on the request for a
 * caller to name a topic — `WsTicketController` accepts no body at all — so
 * "never broaden authorization through caller-supplied scope" is structural
 * rather than filtered. The scope recorded is the narrowest the caller's own
 * resolved context admits: a workspace-pinned principal gets the workspace
 * topic and **not** the organization one, because a ticket that admitted
 * organization-wide topics would hand a workspace user reach it does not have
 * over HTTP (`API.md` §10a, first row).
 *
 * **Only a user session can hold a ticket, and that is the schema's rule rather
 * than a policy choice.** `ws_tickets.user_id` is `NOT NULL`, so an API-key
 * principal — which has no user — is literally unrepresentable in the table.
 * Rather than invent a nullable column or a second persistence model, the
 * endpoint refuses the case and says why. An API key has no interactive socket
 * to open in any event.
 */
@Injectable()
export class WsTicketService {
  constructor(
    private readonly audit: AuditWriter,
    private readonly config: AppConfigService,
  ) {}

  async issue(tx: Transaction, principal: AuthPrincipal): Promise<WsTicketView> {
    const orgId = principal.tenant.orgId;
    if (!orgId) {
      // `ws_tickets.org_id` is NOT NULL, and a ticket with no tenant would bind
      // a connection to nothing. Refused before any material is generated.
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.TENANCY_CONTEXT_REQUIRED,
        message: 'No organization context is established for this request',
      });
    }

    // A user session, because the row requires a user and a ticket is bound to
    // the session that asked for it — revoking that session is what invalidates
    // its outstanding tickets (`API.md` §10a).
    if (principal.actorType !== 'user' || !principal.userId || !principal.sessionId) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_PERMISSION_DENIED,
        message: 'Only a signed-in user session can obtain a WebSocket ticket',
        logContext: { actorType: principal.actorType },
      });
    }

    const scope = this.topicScopeFor(orgId, principal.tenant.workspaceId);
    const material = issueWsTicket();
    const expiresAt = new Date(Date.now() + this.config.auth.wsTicketTtlSeconds * 1000);

    const [row] = await tx
      .insert(schema.wsTickets)
      .values({
        ticketHash: material.hash,
        userId: principal.userId,
        sessionId: principal.sessionId,
        orgId,
        workspaceId: principal.tenant.workspaceId,
        scope,
        expiresAt,
      })
      .returning({
        id: schema.wsTickets.id,
        expiresAt: schema.wsTickets.expiresAt,
        orgId: schema.wsTickets.orgId,
        workspaceId: schema.wsTickets.workspaceId,
        consumedAt: schema.wsTickets.consumedAt,
      });

    if (!row) throw new Error('ws ticket: insert returned no row');

    await this.audit.record(
      {
        // The scope the ticket is bound to: for a credential, where it may act
        // is the truthful statement of where it was issued.
        scopeType: row.workspaceId ? 'workspace' : 'organization',
        scopeId: row.workspaceId ?? row.orgId,
        ...actorFromPrincipal(principal),
        action: AUDIT_ACTIONS.WS_TICKET_ISSUED,
        resourceType: 'WsTicket',
        resourceId: row.id,
        outcome: 'success',
        before: null,
        // Binding and expiry only. Neither the ticket nor its digest appears.
        after: { expiresAt: row.expiresAt.toISOString(), scope },
        metadata: { sessionId: principal.sessionId, topics: scope.length },
      },
      tx,
    );

    return {
      id: row.id,
      ticket: material.ticket,
      expiresAt: row.expiresAt.toISOString(),
      scope,
      orgId: row.orgId,
      workspaceId: row.workspaceId,
    };
  }

  /**
   * The topics this context admits, narrowest first and only one of them.
   *
   * `API.md` §10 names resource topics of the form `org:{org_id}:conversations`
   * and `org:{org_id}:campaigns:{id}`. Those resources are Phase 8's and do not
   * exist, so inventing their names here would be inventing a taxonomy nothing
   * consumes. What is recorded instead is the **tenant prefix** the caller's
   * context reaches, in that documented shape — the namespace under which those
   * resource topics will live when the phase that owns them arrives, at which
   * point this function grows rather than changes meaning.
   *
   * A pinned workspace yields the workspace prefix **alone**: including the
   * organization prefix as well would be a widening, and the whole contract of
   * §10a's first row is that a ticket cannot admit what its holder could not
   * reach over HTTP.
   */
  private topicScopeFor(orgId: string, workspaceId: string | null): string[] {
    return workspaceId ? [`org:${orgId}:workspace:${workspaceId}`] : [`org:${orgId}`];
  }
}
