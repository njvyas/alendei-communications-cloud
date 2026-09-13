import { Injectable, Logger } from '@nestjs/common';
import {
  isAuthRoleAuditAction,
  isSecuritySensitiveAction,
  type AuditRecordInput,
} from '@acc/contracts';
import { auditLogs, type Transaction } from '@acc/db';

import { RequestContext } from '../common/context/request-context';
import { TenantDatabase } from '../database/tenant-database.service';
import { redact } from './audit-redactor';

/**
 * What a caller supplies to `AuditWriter.record`.
 *
 * This is the committed `AuditRecordInput` contract with the four request-context
 * fields made optional, because the writer resolves them from the ambient
 * request rather than trusting a caller to pass them through correctly. A full
 * `AuditRecordInput` is assignable to it, so the contract remains the shape
 * every module speaks.
 */
export type AuditWriteInput = Omit<
  AuditRecordInput,
  'correlationId' | 'causationId' | 'ip' | 'userAgent'
> &
  Partial<Pick<AuditRecordInput, 'correlationId' | 'causationId' | 'ip' | 'userAgent'>>;

/**
 * The single audit write path (`SECURITY.md` §4, ADR-002, ADR-003 D-2).
 *
 * Two properties do the real work here, and both are about what this class
 * refuses to do:
 *
 * **It never sends tenancy.** A caller supplies `scopeType`/`scopeId` and
 * nothing else about where the action happened. `org_id`, `workspace_id`,
 * `team_id` and `reseller_id` are derived by `fn_validate_audit_scope` from the
 * scope the caller named, and are deliberately absent from the INSERT below — so
 * a caller cannot file a record against a tenant it does not reach, even by
 * mistake, and the RLS policy then authorizes the *derived* tenancy.
 *
 * **It never swallows a failure.** Every write is synchronous in Phase 1B: there
 * is no outbox yet, so there is nothing to hand an audit row to, and a
 * fire-and-forget path would lose records while appearing to work. A caller that
 * passes its own transaction gets the guarantee `SECURITY.md` §4 actually
 * promises — if the audit row cannot be written, the business mutation rolls
 * back with it.
 */
@Injectable()
export class AuditWriter {
  private readonly logger = new Logger(AuditWriter.name);

  constructor(private readonly db: TenantDatabase) {}

  /**
   * Records one audit event.
   *
   * @param input the event. `scopeType`/`scopeId` are the only authoritative
   *   statement of where it happened.
   * @param tx an open transaction to write inside. Required in practice for a
   *   security-sensitive mutation, so the row and the mutation share a fate.
   *   Ignored for the `acc_auth` actions, which run before any tenant
   *   transaction exists and use their own principal.
   */
  async record(input: AuditWriteInput, tx?: Transaction): Promise<void> {
    const values = this.buildValues(input);

    if (isAuthRoleAuditAction(input.action)) {
      // Pre-tenant identity events. `acc_auth` is confined by policy to platform
      // scope and this action vocabulary, so it cannot file against a tenant.
      //
      // A caller-supplied transaction is still honoured here, and must be: four
      // of the five actions in this vocabulary accompany a business mutation
      // that `acc_auth` itself performs — `auth.login.succeeded` inserts a
      // `sessions` row and touches `users.last_login_at`, `auth.logout` and
      // `auth.token.refreshed` update `sessions`, and `api_key.authenticated`
      // updates `api_keys.last_used_at`. Writing the audit row on a separate
      // connection would let a rolled-back login leave behind a record saying it
      // succeeded, or a failed audit leave a session with no record at all.
      // Only `auth.login.failed` has no mutation to join, and that is the case
      // that legitimately passes no transaction.
      await (tx ?? this.db.auth).insert(auditLogs).values(values);
      return;
    }

    if (tx) {
      await tx.insert(auditLogs).values(values);
      return;
    }

    if (isSecuritySensitiveAction(input.action)) {
      // Architectural metadata today (ADR-003 D-2 keeps the classification for
      // Phase 2's outbox routing) but load-bearing here: a sensitive action
      // written outside its mutation's transaction cannot offer the
      // roll-back-together guarantee, and silently degrading to a best-effort
      // write is exactly the failure this refuses to hide.
      throw new Error(
        `audit: ${input.action} is security-sensitive and must be recorded inside the transaction that performs it`,
      );
    }

    await this.db.withRequestTenant(async (requestTx) => {
      await requestTx.insert(auditLogs).values(values);
    });
  }

  /**
   * Builds the row. Deliberately enumerates every column it sets, so a tenancy
   * column can never arrive by object spread from a caller's payload.
   */
  private buildValues(input: AuditWriteInput): typeof auditLogs.$inferInsert {
    const store = RequestContext.get();

    const correlationId = input.correlationId ?? store?.correlationId;
    if (!correlationId) {
      // correlation_id is NOT NULL and is the thread tying this row to the
      // request that caused it. Guessing one would produce an untraceable
      // record, which is worse than a loud failure.
      throw new Error(
        `audit: no correlationId for ${input.action} — supply one explicitly when recording outside a request`,
      );
    }

    return {
      scopeType: input.scopeType,
      scopeId: input.scopeId,

      actorType: input.actorType,
      actorUserId: input.actorUserId,
      actorApiKeyId: input.actorApiKeyId,
      actorLabel: input.actorLabel,

      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      outcome: input.outcome,

      before: input.before === null ? null : redact(input.before),
      after: input.after === null ? null : redact(input.after),
      metadata: redact(input.metadata),

      correlationId,
      causationId: input.causationId ?? store?.causationId ?? null,
      ip: input.ip ?? store?.ip ?? null,
      userAgent: input.userAgent ?? store?.userAgent ?? null,
    };
  }
}
