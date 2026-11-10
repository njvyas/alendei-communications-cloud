import { createHash } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  JOURNEY_AUDIT_ACTIONS,
  JOURNEY_GRAPH_SCHEMA_VERSION,
  PERMISSIONS,
  canonicalJourneyJson,
  defaultJourneyGraph,
  renderTemplate,
  validateJourneyGraph,
  type AuthPrincipal,
  type ErrorCode,
  type JourneyGraph,
  type JourneyGraphIssue,
  type JourneyGraphValidationReport,
  type JourneyRecord,
  type JourneyStatus,
  type JourneyVersionRecord,
  type JourneyVersionSummary,
  type PageInfo,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, desc, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AppException } from '../common/errors/app.exception';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { TenantDatabase } from '../database/tenant-database.service';
import { IdempotencyService, type IdempotentOutcome } from '../idempotency/idempotency.service';
import { requireOrganization } from '../workspaces/workspace-administration.service';
import type { CreateJourneyDto, UpdateJourneyDto } from './journeys.dto';

/**
 * Phase 8C PR 8C-1: journey definitions — create, version, edit drafts, validate and publish
 * (`docs/PHASE-8C-JOURNEYS-HANDOVER.md` §§5–7). **Nothing here executes a journey**: there is
 * no activation, enrolment, runner, trigger processing or send. Those are 8C-2 to 8C-4, and
 * sending (8C-5/8C-6) waits for the shared automation principal built in 8B-3 (owner
 * decisions 1–2, 10-Nov-2026).
 */
export interface ListJourneysFilter extends ListQueryInput {
  readonly status?: JourneyStatus;
  readonly query?: string;
}

type JourneyRow = typeof schema.journeys.$inferSelect;
type VersionRow = typeof schema.journeyVersions.$inferSelect;

const notFound = (code: ErrorCode, message: string, ctx: Record<string, unknown>) =>
  new AppException({ status: HttpStatus.NOT_FOUND, code, message, logContext: ctx });

/** SHA-256 of the canonical JSON form, so key order never changes the hash. */
export function journeyGraphSha256(graph: unknown): string {
  return createHash('sha256').update(canonicalJourneyJson(graph)).digest('hex');
}

function summary(v: VersionRow): JourneyVersionSummary {
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    status: v.status,
    graphSha256: v.graphSha256,
    publishedAt: v.publishedAt ? v.publishedAt.toISOString() : null,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

function versionView(v: VersionRow): JourneyVersionRecord {
  return {
    ...summary(v),
    journeyId: v.journeyId,
    workspaceId: v.workspaceId,
    graphSchemaVersion: v.graphSchemaVersion,
    graph: v.graph as JourneyGraph,
    createdBy: v.createdBy,
    publishedBy: v.publishedBy,
  };
}

function journeyView(j: JourneyRow, versions: readonly VersionRow[]): JourneyRecord {
  const own = versions.filter((v) => v.journeyId === j.id);
  const draft = own.find((v) => v.status === 'draft') ?? null;
  const published = own
    .filter((v) => v.status !== 'draft')
    .sort((a, b) => b.versionNumber - a.versionNumber)[0];
  return {
    id: j.id,
    orgId: j.orgId,
    workspaceId: j.workspaceId,
    name: j.name,
    description: j.description,
    status: j.status,
    createdBy: j.createdBy,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
    draftVersion: draft ? summary(draft) : null,
    latestPublishedVersion: published ? summary(published) : null,
  };
}

/** Graph checks that refuse even a draft save: the value must be a v1 graph object of bounded size. */
const SAVE_BLOCKING: readonly string[] = [
  'GRAPH_NOT_OBJECT',
  'GRAPH_TOO_LARGE',
  'SCHEMA_VERSION_UNSUPPORTED',
];

@Injectable()
export class JourneysService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly lists: ListQuery,
    private readonly idempotency: IdempotencyService,
  ) {}

  private readonly listSpec: ListQuerySpec = {
    sortable: {
      name: { column: schema.journeys.name, encode: (row) => String(row.name) },
      createdAt: { column: schema.journeys.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'name',
    tieBreaker: schema.journeys.id,
  };

  /** The workspace must exist in the caller's organization; then the permission is asserted on it. */
  private async assertWorkspaceAccess(
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
      throw notFound(ERROR_CODES.RESOURCE_NOT_FOUND, 'Workspace not found', {
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

  private requireKey(key: string | null): string {
    if (key === null) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
        message: 'This operation requires an Idempotency-Key header',
      });
    }
    return key;
  }

  private async loadJourney(
    tx: Transaction,
    orgId: string,
    workspaceId: string,
    journeyId: string,
    lock = false,
  ): Promise<JourneyRow> {
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
    const [row] = lock ? await q.for('update') : await q;
    if (!row)
      throw notFound(ERROR_CODES.JOURNEY_NOT_FOUND, 'Journey not found', {
        requestedJourneyId: journeyId,
      });
    return row;
  }

  private async loadVersion(
    tx: Transaction,
    journey: JourneyRow,
    versionId: string,
    lock = false,
  ): Promise<VersionRow> {
    const q = tx
      .select()
      .from(schema.journeyVersions)
      .where(
        and(
          eq(schema.journeyVersions.id, versionId),
          eq(schema.journeyVersions.journeyId, journey.id),
          eq(schema.journeyVersions.orgId, journey.orgId),
        ),
      )
      .limit(1);
    const [row] = lock ? await q.for('update') : await q;
    if (!row)
      throw notFound(ERROR_CODES.JOURNEY_VERSION_NOT_FOUND, 'Journey version not found', {
        requestedVersionId: versionId,
      });
    return row;
  }

  private async versionsOf(tx: Transaction, journeyIds: readonly string[]): Promise<VersionRow[]> {
    if (journeyIds.length === 0) return [];
    return tx
      .select()
      .from(schema.journeyVersions)
      .where(inArray(schema.journeyVersions.journeyId, [...journeyIds]));
  }

  private async recordAudit(
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

  // --- journeys ----------------------------------------------------------------------------

  async list(
    principal: AuthPrincipal,
    workspaceId: string,
    filter: ListJourneysFilter = {},
  ): Promise<{ items: readonly JourneyRecord[]; page: PageInfo }> {
    const resolved = this.lists.resolve(filter, this.listSpec);
    const { rows, versions } = await this.db.withRequestTenant(async (tx) => {
      const orgId = await this.assertWorkspaceAccess(
        tx,
        principal,
        workspaceId,
        PERMISSIONS.JOURNEYS_READ,
      );
      const predicates: SQL[] = [
        eq(schema.journeys.orgId, orgId),
        eq(schema.journeys.workspaceId, workspaceId),
        isNull(schema.journeys.deletedAt),
      ];
      if (filter.status) predicates.push(eq(schema.journeys.status, filter.status));
      if (filter.query) {
        const escaped = filter.query.replace(/[\\%_]/g, (c) => `\\${c}`);
        predicates.push(ilike(schema.journeys.name, `%${escaped}%`));
      }
      if (resolved.after) predicates.push(resolved.after);
      const rows = await tx
        .select()
        .from(schema.journeys)
        .where(and(...predicates))
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));
      return {
        rows,
        versions: await this.versionsOf(
          tx,
          rows.map((r) => r.id),
        ),
      };
    });
    const { items, page } = this.lists.paginate(
      rows as unknown as Record<string, unknown>[],
      resolved,
      this.listSpec,
      (row) => String(row.id),
    );
    return {
      items: (items as unknown as JourneyRow[]).map((j) => journeyView(j, versions)),
      page,
    };
  }

  async get(
    principal: AuthPrincipal,
    workspaceId: string,
    journeyId: string,
  ): Promise<JourneyRecord> {
    return this.db.withRequestTenant(async (tx) => {
      const orgId = await this.assertWorkspaceAccess(
        tx,
        principal,
        workspaceId,
        PERMISSIONS.JOURNEYS_READ,
      );
      const journey = await this.loadJourney(tx, orgId, workspaceId, journeyId);
      return journeyView(journey, await this.versionsOf(tx, [journey.id]));
    });
  }

  /** Creates the journey and version 1 as a draft holding the minimal valid graph. Key required. */
  async create(
    principal: AuthPrincipal,
    workspaceId: string,
    dto: CreateJourneyDto,
    idempotencyKey: string | null,
  ): Promise<IdempotentOutcome<{ data: JourneyRecord }>> {
    const key = this.requireKey(idempotencyKey);
    const orgId = requireOrganization(principal);
    const authorize = (tx: Transaction) =>
      this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.JOURNEYS_MANAGE).then(
        () => undefined,
      );
    return this.idempotency.execute({
      key,
      successStatus: HttpStatus.CREATED,
      request: {
        method: 'POST',
        route: `/workspaces/${workspaceId}/journeys`,
        orgId,
        principal,
        pathParams: { workspaceId },
        query: {},
        body: { name: dto.name, description: dto.description ?? null },
      },
      authorize,
      work: async (tx) => {
        await authorize(tx);
        const journeyId = uuidv7();
        const graph = defaultJourneyGraph();
        const [journey] = await tx
          .insert(schema.journeys)
          .values({
            id: journeyId,
            orgId,
            workspaceId,
            name: dto.name,
            description: dto.description ?? null,
            createdBy: principal.userId ?? null,
          })
          .returning();
        const [version] = await tx
          .insert(schema.journeyVersions)
          .values({
            id: uuidv7(),
            orgId,
            workspaceId,
            journeyId,
            versionNumber: 1,
            graphSchemaVersion: JOURNEY_GRAPH_SCHEMA_VERSION,
            graph,
            graphSha256: journeyGraphSha256(graph),
            createdBy: principal.userId ?? null,
          })
          .returning();
        await this.recordAudit(
          tx,
          principal,
          workspaceId,
          JOURNEY_AUDIT_ACTIONS.CREATED,
          journeyId,
          {
            name: dto.name,
            versionId: version!.id,
          },
        );
        return { data: journeyView(journey!, [version!]) };
      },
    });
  }

  async update(
    principal: AuthPrincipal,
    workspaceId: string,
    journeyId: string,
    dto: UpdateJourneyDto,
  ): Promise<JourneyRecord> {
    return this.db.withRequestTenant(async (tx) => {
      const orgId = await this.assertWorkspaceAccess(
        tx,
        principal,
        workspaceId,
        PERMISSIONS.JOURNEYS_MANAGE,
      );
      const current = await this.loadJourney(tx, orgId, workspaceId, journeyId, true);
      const changes: Partial<JourneyRow> = {};
      if (dto.name !== undefined && dto.name !== current.name) changes.name = dto.name;
      if (dto.description !== undefined && dto.description !== current.description)
        changes.description = dto.description;
      let row = current;
      if (Object.keys(changes).length > 0) {
        [row] = (await tx
          .update(schema.journeys)
          .set({ ...changes, updatedAt: sql`now()` })
          .where(eq(schema.journeys.id, current.id))
          .returning()) as [JourneyRow];
        await this.recordAudit(
          tx,
          principal,
          workspaceId,
          JOURNEY_AUDIT_ACTIONS.UPDATED,
          journeyId,
          {
            changed: Object.keys(changes).sort(),
          },
        );
      }
      return journeyView(row, await this.versionsOf(tx, [journeyId]));
    });
  }

  /**
   * Soft delete. Allowed only while the journey is `draft` or `archived`: an active or paused
   * journey (8C-2) must be archived first, so no deletion can strand an execution.
   */
  async delete(principal: AuthPrincipal, workspaceId: string, journeyId: string): Promise<void> {
    await this.db.withRequestTenant(async (tx) => {
      const orgId = await this.assertWorkspaceAccess(
        tx,
        principal,
        workspaceId,
        PERMISSIONS.JOURNEYS_MANAGE,
      );
      const journey = await this.loadJourney(tx, orgId, workspaceId, journeyId, true);
      if (journey.status !== 'draft' && journey.status !== 'archived') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.JOURNEY_LIFECYCLE_CONFLICT,
          message: 'Only a draft or archived journey can be deleted',
          details: { status: journey.status },
        });
      }
      await tx
        .update(schema.journeys)
        .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(schema.journeys.id, journey.id));
      await this.recordAudit(tx, principal, workspaceId, JOURNEY_AUDIT_ACTIONS.DELETED, journeyId, {
        name: journey.name,
      });
    });
  }

  // --- versions ----------------------------------------------------------------------------

  async listVersions(
    principal: AuthPrincipal,
    workspaceId: string,
    journeyId: string,
  ): Promise<readonly JourneyVersionSummary[]> {
    return this.db.withRequestTenant(async (tx) => {
      const orgId = await this.assertWorkspaceAccess(
        tx,
        principal,
        workspaceId,
        PERMISSIONS.JOURNEYS_READ,
      );
      const journey = await this.loadJourney(tx, orgId, workspaceId, journeyId);
      const rows = await tx
        .select()
        .from(schema.journeyVersions)
        .where(eq(schema.journeyVersions.journeyId, journey.id))
        .orderBy(desc(schema.journeyVersions.versionNumber));
      return rows.map(summary);
    });
  }

  async getVersion(
    principal: AuthPrincipal,
    workspaceId: string,
    journeyId: string,
    versionId: string,
  ): Promise<JourneyVersionRecord> {
    return this.db.withRequestTenant(async (tx) => {
      const orgId = await this.assertWorkspaceAccess(
        tx,
        principal,
        workspaceId,
        PERMISSIONS.JOURNEYS_READ,
      );
      const journey = await this.loadJourney(tx, orgId, workspaceId, journeyId);
      return versionView(await this.loadVersion(tx, journey, versionId));
    });
  }

  /**
   * A new draft copied from the highest published version. Refused (`409 JOURNEY_DRAFT_EXISTS`)
   * while a draft exists; the partial unique index enforces the same rule under concurrency.
   * Key required.
   */
  async createVersion(
    principal: AuthPrincipal,
    workspaceId: string,
    journeyId: string,
    idempotencyKey: string | null,
  ): Promise<IdempotentOutcome<{ data: JourneyVersionRecord }>> {
    const key = this.requireKey(idempotencyKey);
    const orgId = requireOrganization(principal);
    const authorize = (tx: Transaction) =>
      this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.JOURNEYS_MANAGE).then(
        () => undefined,
      );
    return this.idempotency.execute({
      key,
      successStatus: HttpStatus.CREATED,
      request: {
        method: 'POST',
        route: `/workspaces/${workspaceId}/journeys/${journeyId}/versions`,
        orgId,
        principal,
        pathParams: { workspaceId, journeyId },
        query: {},
        body: {},
      },
      authorize,
      work: async (tx) => {
        await authorize(tx);
        const journey = await this.loadJourney(tx, orgId, workspaceId, journeyId, true);
        const versions = await tx
          .select()
          .from(schema.journeyVersions)
          .where(eq(schema.journeyVersions.journeyId, journey.id))
          .orderBy(desc(schema.journeyVersions.versionNumber));
        const draft = versions.find((v) => v.status === 'draft');
        if (draft) {
          throw new AppException({
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.JOURNEY_DRAFT_EXISTS,
            message: 'The journey already has a draft version',
            details: { draftVersionId: draft.id },
          });
        }
        const source = versions[0]!; // a journey always has version 1; no draft ⇒ it is published
        const [created] = await tx
          .insert(schema.journeyVersions)
          .values({
            id: uuidv7(),
            orgId,
            workspaceId,
            journeyId: journey.id,
            versionNumber: source.versionNumber + 1,
            graphSchemaVersion: source.graphSchemaVersion,
            graph: source.graph,
            graphSha256: source.graphSha256,
            createdBy: principal.userId ?? null,
          })
          .returning();
        await tx
          .update(schema.journeys)
          .set({ updatedAt: sql`now()` })
          .where(eq(schema.journeys.id, journey.id));
        await this.recordAudit(
          tx,
          principal,
          workspaceId,
          JOURNEY_AUDIT_ACTIONS.VERSION_CREATED,
          journeyId,
          { versionId: created!.id, versionNumber: created!.versionNumber, copiedFrom: source.id },
        );
        return { data: versionView(created!) };
      },
    });
  }

  /**
   * Replaces a draft's graph. The draft must still hold `expectedGraphSha256` (else
   * `409 JOURNEY_GRAPH_CONFLICT`); a published or retired version is `409
   * JOURNEY_VERSION_IMMUTABLE`. Only a non-object, oversized or non-v1 graph is refused here:
   * a draft may be saved while otherwise invalid.
   */
  async replaceGraph(
    principal: AuthPrincipal,
    workspaceId: string,
    journeyId: string,
    versionId: string,
    graph: unknown,
    expectedGraphSha256: string,
  ): Promise<JourneyVersionRecord> {
    return this.db.withRequestTenant(async (tx) => {
      const orgId = await this.assertWorkspaceAccess(
        tx,
        principal,
        workspaceId,
        PERMISSIONS.JOURNEYS_MANAGE,
      );
      const journey = await this.loadJourney(tx, orgId, workspaceId, journeyId);
      const version = await this.loadVersion(tx, journey, versionId, true);
      this.assertEditableDraft(version, expectedGraphSha256);
      // Checked after the lookups, so an unknown journey or version is 404 whatever the body.
      const blocking = validateJourneyGraph(graph).errors.filter((e) =>
        SAVE_BLOCKING.includes(e.code),
      );
      if (blocking.length > 0) {
        throw new AppException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ERROR_CODES.JOURNEY_GRAPH_INVALID,
          message: 'The graph cannot be saved',
          details: { report: { valid: false, errors: blocking, warnings: [] } },
        });
      }
      const sha = journeyGraphSha256(graph);
      if (sha === version.graphSha256) return versionView(version);
      const [updated] = await tx
        .update(schema.journeyVersions)
        .set({ graph, graphSha256: sha, updatedAt: sql`now()` })
        .where(eq(schema.journeyVersions.id, version.id))
        .returning();
      await tx
        .update(schema.journeys)
        .set({ updatedAt: sql`now()` })
        .where(eq(schema.journeys.id, journey.id));
      await this.recordAudit(
        tx,
        principal,
        workspaceId,
        JOURNEY_AUDIT_ACTIONS.GRAPH_UPDATED,
        journeyId,
        {
          versionId: version.id,
          graphSha256: sha,
          nodes: Object.keys((graph as JourneyGraph).nodes ?? {}).length,
        },
      );
      return versionView(updated!);
    });
  }

  private assertEditableDraft(version: VersionRow, expectedGraphSha256: string): void {
    if (version.status !== 'draft') {
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.JOURNEY_VERSION_IMMUTABLE,
        message: `Journey version ${version.versionNumber} is ${version.status} and cannot change`,
        details: { status: version.status },
      });
    }
    if (version.graphSha256 !== expectedGraphSha256) {
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.JOURNEY_GRAPH_CONFLICT,
        message: 'The draft graph changed since it was read',
        details: { currentGraphSha256: version.graphSha256 },
      });
    }
  }

  /** The full validation report for a version (structural and referential). Writes nothing. */
  async validateVersion(
    principal: AuthPrincipal,
    workspaceId: string,
    journeyId: string,
    versionId: string,
  ): Promise<JourneyGraphValidationReport> {
    return this.db.withRequestTenant(async (tx) => {
      const orgId = await this.assertWorkspaceAccess(
        tx,
        principal,
        workspaceId,
        PERMISSIONS.JOURNEYS_READ,
      );
      const journey = await this.loadJourney(tx, orgId, workspaceId, journeyId);
      const version = await this.loadVersion(tx, journey, versionId);
      return this.fullReport(tx, orgId, workspaceId, version.graph);
    });
  }

  /**
   * Freezes a draft. The graph must hold `expectedGraphSha256` and validate fully (else
   * `422 JOURNEY_GRAPH_INVALID` with the report). Publication activates nothing: activation is
   * 8C-2. Key required.
   */
  async publish(
    principal: AuthPrincipal,
    workspaceId: string,
    journeyId: string,
    versionId: string,
    expectedGraphSha256: string,
    idempotencyKey: string | null,
  ): Promise<IdempotentOutcome<{ data: JourneyVersionRecord }>> {
    const key = this.requireKey(idempotencyKey);
    const orgId = requireOrganization(principal);
    const authorize = (tx: Transaction) =>
      this.assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.JOURNEYS_MANAGE).then(
        () => undefined,
      );
    return this.idempotency.execute({
      key,
      successStatus: HttpStatus.OK,
      request: {
        method: 'POST',
        route: `/workspaces/${workspaceId}/journeys/${journeyId}/versions/${versionId}/publish`,
        orgId,
        principal,
        pathParams: { workspaceId, journeyId, versionId },
        query: {},
        body: { expectedGraphSha256 },
      },
      authorize,
      work: async (tx) => {
        await authorize(tx);
        const journey = await this.loadJourney(tx, orgId, workspaceId, journeyId);
        const version = await this.loadVersion(tx, journey, versionId, true);
        this.assertEditableDraft(version, expectedGraphSha256);
        const report = await this.fullReport(tx, orgId, workspaceId, version.graph);
        if (!report.valid) {
          throw new AppException({
            status: HttpStatus.UNPROCESSABLE_ENTITY,
            code: ERROR_CODES.JOURNEY_GRAPH_INVALID,
            message: 'The journey graph is not valid and cannot be published',
            details: { report },
          });
        }
        const [published] = await tx
          .update(schema.journeyVersions)
          .set({
            status: 'published',
            publishedAt: sql`now()`,
            publishedBy: principal.userId ?? null,
            updatedAt: sql`now()`,
          })
          .where(eq(schema.journeyVersions.id, version.id))
          .returning();
        await tx
          .update(schema.journeys)
          .set({ updatedAt: sql`now()` })
          .where(eq(schema.journeys.id, journey.id));
        await this.recordAudit(
          tx,
          principal,
          workspaceId,
          JOURNEY_AUDIT_ACTIONS.VERSION_PUBLISHED,
          journeyId,
          {
            versionId: version.id,
            versionNumber: version.versionNumber,
            graphSha256: version.graphSha256,
            warnings: report.warnings.length,
          },
        );
        return { data: versionView(published!) };
      },
    });
  }

  /**
   * Structural validation plus the organisation's data: templates (exist, approved, channel,
   * every placeholder mapped) and segments (exist in this workspace). Read-only.
   */
  private async fullReport(
    tx: Transaction,
    orgId: string,
    workspaceId: string,
    graph: unknown,
  ): Promise<JourneyGraphValidationReport> {
    const base = validateJourneyGraph(graph);
    if (base.errors.some((e) => SAVE_BLOCKING.includes(e.code) || e.code === 'NODE_INVALID'))
      return base;
    const errors: JourneyGraphIssue[] = [...base.errors];
    const warnings: JourneyGraphIssue[] = [...base.warnings];
    const nodes = Object.entries((graph as JourneyGraph).nodes ?? {});

    const templateRefs = nodes.filter(
      ([, n]) => n?.type === 'send_message' && typeof n.templateId === 'string',
    ) as [string, Extract<JourneyGraph['nodes'][string], { type: 'send_message' }>][];
    const segmentRefs: [string, string, string][] = [];
    for (const [key, n] of nodes) {
      if (n?.type === 'entry' && n.trigger?.kind === 'schedule')
        segmentRefs.push([key, 'trigger.segmentId', n.trigger.segmentId]);
      if (n?.type === 'condition' && n.rule?.kind === 'segment')
        segmentRefs.push([key, 'rule.segmentId', n.rule.segmentId]);
    }
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const templateIds = [...new Set(templateRefs.map(([, n]) => n.templateId))].filter((id) =>
      uuid.test(id),
    );
    const templates =
      templateIds.length === 0
        ? []
        : await tx
            .select({
              id: schema.templates.id,
              body: schema.templates.body,
              approvalStatus: schema.templates.approvalStatus,
              channelCode: sql<string>`app_channel_code(${schema.templates.channelId})`,
            })
            .from(schema.templates)
            .where(
              and(
                eq(schema.templates.orgId, orgId),
                inArray(schema.templates.id, templateIds),
                isNull(schema.templates.deletedAt),
              ),
            );
    const byId = new Map(templates.map((t) => [t.id, t]));
    for (const [key, n] of templateRefs) {
      if (!uuid.test(n.templateId)) continue; // already a FIELD_INVALID
      const t = byId.get(n.templateId);
      if (!t) {
        errors.push({
          code: 'TEMPLATE_NOT_FOUND',
          nodeKey: key,
          path: 'templateId',
          message: 'template not found',
        });
        continue;
      }
      if (t.approvalStatus !== 'approved')
        errors.push({
          code: 'TEMPLATE_NOT_APPROVED',
          nodeKey: key,
          path: 'templateId',
          message: `template approval status is '${t.approvalStatus}'`,
        });
      if (t.channelCode !== n.channel)
        errors.push({
          code: 'TEMPLATE_CHANNEL_MISMATCH',
          nodeKey: key,
          path: 'channel',
          message: `template channel is '${t.channelCode}'`,
        });
      const placeholders = [...new Set(renderTemplate(t.body, {}).missingVariables)];
      const mapped = Object.keys(n.variables ?? {});
      for (const p of placeholders)
        if (!mapped.includes(p))
          errors.push({
            code: 'TEMPLATE_VARIABLE_UNMAPPED',
            nodeKey: key,
            path: `variables.${p}`,
            message: `template variable '${p}' has no value`,
          });
      for (const m of mapped)
        if (!placeholders.includes(m))
          warnings.push({
            code: 'TEMPLATE_VARIABLE_UNKNOWN',
            nodeKey: key,
            path: `variables.${m}`,
            message: `the template has no variable '${m}'`,
          });
    }

    const segmentIds = [...new Set(segmentRefs.map(([, , id]) => id))].filter(
      (id) => typeof id === 'string' && uuid.test(id),
    );
    const segments =
      segmentIds.length === 0
        ? []
        : await tx
            .select({ id: schema.segments.id })
            .from(schema.segments)
            .where(
              and(
                eq(schema.segments.orgId, orgId),
                eq(schema.segments.workspaceId, workspaceId),
                inArray(schema.segments.id, segmentIds),
                isNull(schema.segments.deletedAt),
              ),
            );
    const found = new Set(segments.map((s) => s.id));
    for (const [key, path, id] of segmentRefs)
      if (typeof id === 'string' && uuid.test(id) && !found.has(id))
        errors.push({
          code: 'SEGMENT_NOT_FOUND',
          nodeKey: key,
          path,
          message: 'segment not found in this workspace',
        });

    return { valid: errors.length === 0, errors, warnings };
  }
}
