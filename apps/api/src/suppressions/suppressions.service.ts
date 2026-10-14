import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  PERMISSIONS,
  type AuthPrincipal,
  type PageInfo,
  type SuppressionResponse,
  type SuppressionStatus,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AppException } from '../common/errors/app.exception';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { normalizeAddress } from '../contacts/contacts.normalization';
import { TenantDatabase } from '../database/tenant-database.service';
import { IdempotencyService, type IdempotentOutcome } from '../idempotency/idempotency.service';
import { requireOrganization } from '../workspaces/workspace-administration.service';
import type {
  CreateSuppressionDto,
  LiftSuppressionDto,
} from './suppressions.dto';

type SuppressionRow = typeof schema.suppressions.$inferSelect;

function suppressionNotFound(id: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: 'Suppression not found',
    logContext: { requestedSuppressionId: id },
  });
}

function channelNotFound(id: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: 'Channel not found',
    logContext: { requestedChannelId: id },
  });
}

function suppressionView(row: SuppressionRow): SuppressionResponse {
  return {
    id: row.id,
    orgId: row.orgId,
    channelId: row.channelId,
    rawAddress: row.rawAddress,
    normalizedAddress: row.normalizedAddress,
    reason: row.reason,
    status: row.status,
    clearedAt: row.clearedAt ? row.clearedAt.toISOString() : null,
    clearedReason: row.clearedReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ListSuppressionsFilter extends ListQueryInput {
  readonly channelId?: string;
  readonly status?: SuppressionStatus;
}

@Injectable()
export class SuppressionsService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly lists: ListQuery,
    private readonly idempotency: IdempotencyService,
  ) {}

  private readonly listSpec: ListQuerySpec = {
    sortable: {
      createdAt: { column: schema.suppressions.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'createdAt',
    tieBreaker: schema.suppressions.id,
  };

  async list(
    principal: AuthPrincipal,
    filter: ListSuppressionsFilter = {},
  ): Promise<{ items: readonly SuppressionResponse[]; page: PageInfo }> {
    const orgId = requireOrganization(principal);
    const resolved = this.lists.resolve(filter, this.listSpec);

    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.SUPPRESSIONS_READ,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const predicates: SQL[] = [eq(schema.suppressions.orgId, orgId)];
      if (filter.channelId) predicates.push(eq(schema.suppressions.channelId, filter.channelId));
      if (filter.status) predicates.push(eq(schema.suppressions.status, filter.status));
      if (resolved.after) predicates.push(resolved.after);

      return tx
        .select()
        .from(schema.suppressions)
        .where(and(...predicates))
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));
    });

    const { items, page } = this.lists.paginate(
      rows as unknown as Record<string, unknown>[],
      resolved,
      this.listSpec,
      (row) => String(row.id),
    );
    return { items: items.map((r) => suppressionView(r as never)), page };
  }

  async get(principal: AuthPrincipal, id: string): Promise<SuppressionResponse> {
    const orgId = requireOrganization(principal);
    return this.db.withRequestTenant(async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.SUPPRESSIONS_READ,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const [row] = await tx
        .select()
        .from(schema.suppressions)
        .where(and(eq(schema.suppressions.id, id), eq(schema.suppressions.orgId, orgId)));
      if (!row) throw suppressionNotFound(id);
      return suppressionView(row);
    });
  }

  async create(
    principal: AuthPrincipal,
    dto: CreateSuppressionDto,
    idempotencyKey: string | null,
  ): Promise<IdempotentOutcome<{ data: SuppressionResponse }>> {
    const orgId = requireOrganization(principal);
    const authorize = (tx: Transaction) =>
      this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.SUPPRESSIONS_MANAGE,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

    return this.idempotency.execute({
      key: idempotencyKey,
      successStatus: HttpStatus.CREATED,
      request: {
        method: 'POST',
        route: '/suppressions',
        orgId,
        principal,
        pathParams: {},
        query: {},
        body: { channelId: dto.channelId, reason: dto.reason },
      },
      authorize,
      work: async (tx) => {
        await authorize(tx);

        let channelCode: string | null = null;
        if (dto.channelId) {
          const channelResult = await tx.execute<{ code: string }>(
            sql`SELECT app_channel_code(${dto.channelId}) AS code`,
          );
          if (!channelResult.rows[0]?.code) throw channelNotFound(dto.channelId);
          channelCode = channelResult.rows[0].code;
        }

        const normalizedAddress = normalizeAddress(dto.rawAddress, channelCode);
        const suppressionId = uuidv7();

        await tx.execute(sql`SAVEPOINT suppression_insert`);
        try {
          const [row] = await tx
            .insert(schema.suppressions)
            .values({
              id: suppressionId,
              orgId,
              channelId: dto.channelId ?? null,
              rawAddress: dto.rawAddress,
              normalizedAddress,
              reason: dto.reason,
              status: 'active',
            })
            .returning();

          await tx.execute(sql`RELEASE SAVEPOINT suppression_insert`);

          // Privacy: zero PII in audit log
          await this.audit.record(
            {
              scopeType: 'organization',
              scopeId: orgId,
              ...actorFromPrincipal(principal),
              action: 'suppression.created',
              resourceType: 'Suppression',
              resourceId: suppressionId,
              outcome: 'success',
              before: null,
              after: null,
              metadata: {},
            },
            tx,
          );

          return { data: suppressionView(row!) };
        } catch (error) {
          const cause =
            (error as { cause?: { code?: string; constraint?: string } }).cause ??
            (error as { code?: string; constraint?: string });
          if (cause?.code === '23505') {
            await tx.execute(sql`ROLLBACK TO SAVEPOINT suppression_insert`);

            // Query existing active suppression under Model B RLS
            const existing = await tx
              .select()
              .from(schema.suppressions)
              .where(
                and(
                  eq(schema.suppressions.orgId, orgId),
                  dto.channelId
                    ? eq(schema.suppressions.channelId, dto.channelId)
                    : isNull(schema.suppressions.channelId),
                  eq(schema.suppressions.normalizedAddress, normalizedAddress),
                  eq(schema.suppressions.status, 'active'),
                ),
              );

            if (existing.length > 0) {
              throw new AppException({
                status: HttpStatus.CONFLICT,
                code: ERROR_CODES.SUPPRESSION_ALREADY_ACTIVE,
                message: 'An active suppression already exists for this address',
                details: {
                  existingSuppressionId: existing[0]!.id,
                  channelId: existing[0]!.channelId,
                  status: existing[0]!.status,
                },
              });
            }

            throw new AppException({
              status: HttpStatus.CONFLICT,
              code: ERROR_CODES.RESOURCE_CONFLICT,
              message: 'Suppression conflict',
            });
          }
          throw error;
        }
      },
    });
  }

  async lift(
    principal: AuthPrincipal,
    id: string,
    dto: LiftSuppressionDto,
  ): Promise<SuppressionResponse> {
    const orgId = requireOrganization(principal);
    return this.db.withRequestTenant(async (tx) => {
      await this.authorization.assert(tx, {
        principal,
        permission: PERMISSIONS.SUPPRESSIONS_MANAGE,
        target: { scopeType: 'organization', scopeId: orgId },
        resourceType: 'Organization',
      });

      const [existing] = await tx
        .select()
        .from(schema.suppressions)
        .where(and(eq(schema.suppressions.id, id), eq(schema.suppressions.orgId, orgId)))
        .for('update');
      if (!existing) throw suppressionNotFound(id);

      const [row] = await tx
        .update(schema.suppressions)
        .set({
          status: 'cleared',
          clearedAt: new Date(),
          clearedReason: dto.reason,
          updatedAt: new Date(),
        })
        .where(eq(schema.suppressions.id, id))
        .returning();

      // Privacy: zero PII in audit log
      await this.audit.record(
        {
          scopeType: 'organization',
          scopeId: orgId,
          ...actorFromPrincipal(principal),
          action: 'suppression.lifted',
          resourceType: 'Suppression',
          resourceId: id,
          outcome: 'success',
          before: { status: existing.status },
          after: { status: 'cleared' },
          metadata: {},
        },
        tx,
      );

      return suppressionView(row!);
    });
  }
}
