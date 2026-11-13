import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES, type AuthPrincipal, type ErrorCode } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, isNull } from 'drizzle-orm';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AppException } from '../common/errors/app.exception';
import { requireOrganization } from '../workspaces/workspace-administration.service';

export type JourneyRow = typeof schema.journeys.$inferSelect;
export type VersionRow = typeof schema.journeyVersions.$inferSelect;
export type TriggerRow = typeof schema.journeyTriggers.$inferSelect;
export type ExecutionRow = typeof schema.journeyExecutions.$inferSelect;

export const journeyNotFound = (code: ErrorCode, message: string, ctx: Record<string, unknown>) =>
  new AppException({ status: HttpStatus.NOT_FOUND, code, message, logContext: ctx });

/** How a journey row is locked when loaded. */
export type JourneyLock = 'none' | 'share' | 'update';

/**
 * Access helpers shared by the journeys services (8C-1 definitions, 8C-2 lifecycle and
 * executions): the workspace/permission check, journey lookup under the request's tenant
 * transaction, the `Idempotency-Key` requirement, and the audit record.
 */
@Injectable()
export class JourneyAccess {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
  ) {}

  /** The workspace must exist in the caller's organization; then the permission is asserted on it. */
  async assertWorkspaceAccess(
    tx: Transaction,
    principal: AuthPrincipal,
    workspaceId: string,
    permission: string,
  ): Promise<string> {
    const orgId = requireOrganization(principal);
    const [workspace] = await tx
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.orgId, orgId)));
    if (!workspace)
      throw journeyNotFound(ERROR_CODES.RESOURCE_NOT_FOUND, 'Workspace not found', {
        requestedWorkspaceId: workspaceId,
      });
    await this.authorization.assert(tx, {
      principal,
      permission,
      target: { scopeType: 'workspace', scopeId: workspaceId },
      resourceType: 'Workspace',
    });
    return orgId;
  }

  requireKey(key: string | null): string {
    if (key === null) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
        message: 'This operation requires an Idempotency-Key header',
      });
    }
    return key;
  }

  async loadJourney(
    tx: Transaction,
    orgId: string,
    workspaceId: string,
    journeyId: string,
    lock: JourneyLock | boolean = 'none',
  ): Promise<JourneyRow> {
    const mode: JourneyLock = lock === true ? 'update' : lock === false ? 'none' : lock;
    const q = tx
      .select()
      .from(schema.journeys)
      .where(
        and(
          eq(schema.journeys.id, journeyId),
          eq(schema.journeys.workspaceId, workspaceId),
          eq(schema.journeys.orgId, orgId),
          isNull(schema.journeys.deletedAt),
        ),
      )
      .limit(1);
    const [row] =
      mode === 'update' ? await q.for('update') : mode === 'share' ? await q.for('share') : await q;
    if (!row)
      throw journeyNotFound(ERROR_CODES.JOURNEY_NOT_FOUND, 'Journey not found', {
        requestedJourneyId: journeyId,
      });
    return row;
  }

  async recordAudit(
    tx: Transaction,
    principal: AuthPrincipal,
    workspaceId: string,
    action: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      {
        scopeType: 'workspace',
        scopeId: workspaceId,
        ...actorFromPrincipal(principal),
        action,
        resourceType: 'Journey',
        resourceId,
        outcome: 'success',
        before: null,
        after: null,
        metadata,
      },
      tx,
    );
  }
}
