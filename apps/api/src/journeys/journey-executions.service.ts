import { createHash } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  JOURNEY_AUDIT_ACTIONS,
  JOURNEY_END_REASONS,
  JOURNEY_EXECUTION_STATUSES,
  JOURNEY_NODE_EDGES,
  PERMISSIONS,
  type AuthPrincipal,
  type JourneyEnrolmentResult,
  type JourneyExecutionDetailRecord,
  type JourneyExecutionRecord,
  type JourneyExecutionStatus,
  type JourneyGraph,
  type JourneyNodeStats,
  type JourneyStatsRecord,
  type JourneyStepOutcome,
  type JourneyVersionStats,
  type PageInfo,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, asc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { TenantDatabase } from '../database/tenant-database.service';
import { IdempotencyService, type IdempotentOutcome } from '../idempotency/idempotency.service';
import { requireOrganization } from '../workspaces/workspace-administration.service';
import {
  JourneyAccess,
  journeyNotFound,
  type ExecutionRow,
  type JourneyRow,
} from './journey-access';
import { executionView, stepView } from './journey-views';

export interface ListExecutionsFilter extends ListQueryInput {
  readonly status?: JourneyExecutionStatus;
  readonly contactId?: string;
  readonly versionId?: string;
}

/**
 * Node keys in a stable, readable order: breadth-first from the entry along each node's edges
 * (in `JOURNEY_NODE_EDGES` order), then any unreachable keys sorted. JSONB does not keep the
 * author's key order, so the stored order is not used.
 */
export function journeyNodeOrder(graph: JourneyGraph): string[] {
  const nodes = graph.nodes ?? {};
  const has = (k: unknown): k is string =>
    typeof k === 'string' && Object.prototype.hasOwnProperty.call(nodes, k);
  const seen = new Set<string>();
  const queue: string[] = has(graph.entry) ? [graph.entry] : [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = nodes[key] as unknown as Record<string, unknown>;
    const fields = Object.prototype.hasOwnProperty.call(JOURNEY_NODE_EDGES, node.type as string)
      ? JOURNEY_NODE_EDGES[node.type as keyof typeof JOURNEY_NODE_EDGES]
      : [];
    for (const f of fields)
      if (has(node[f]) && !seen.has(node[f] as string)) queue.push(node[f] as string);
  }
  return [
    ...seen,
    ...Object.keys(nodes)
      .filter((k) => !seen.has(k))
      .sort(),
  ];
}

/** At most this many history rows are returned with one execution (the transition bound). */
const MAX_STEPS = 1000;

/**
 * The entry reference of an API enrolment: derived from the organisation, journey and
 * `Idempotency-Key`, so a replay after the idempotency record expired still cannot enrol a
 * contact twice under the same key (`uq_journey_executions_entry`). Never the key itself.
 */
export function apiEntryRef(orgId: string, journeyId: string, idempotencyKey: string): string {
  return `api:${createHash('sha256').update(`${orgId}\n${journeyId}\n${idempotencyKey}`).digest('hex')}`;
}

/**
 * Phase 8C PR 8C-2: journey executions (`docs/PHASE-8C-JOURNEYS-HANDOVER.md` §§7, 8.1).
 *
 * - **API enrolment**: one execution per contact on the active version, positioned after the
 *   entry node (the `entered` history row is `seq` 1), with an unclaimed queue row. Nothing
 *   claims it: the runner is 8C-3 and stays disabled. Entry policy is `once` (a contact enters
 *   a journey at most once); a live execution is never duplicated (partial unique index).
 * - **Reads**: executions (keyset), one execution with its history, per-node statistics.
 * - **Operator cancel**: a conditional, fenced transition to `cancelled`; a repeat is a no-op.
 */
@Injectable()
export class JourneyExecutionsService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly access: JourneyAccess,
    private readonly lists: ListQuery,
    private readonly idempotency: IdempotencyService,
  ) {}

  private readonly listSpec: ListQuerySpec = {
    sortable: {
      createdAt: {
        column: schema.journeyExecutions.id,
        encode: (row) => String(row.id),
      },
    },
    defaultSort: '-createdAt',
    tieBreaker: schema.journeyExecutions.id,
  };

  // --- enrolment ---------------------------------------------------------------------------

  async enrol(
    principal: AuthPrincipal,
    workspaceId: string,
    journeyId: string,
    contactIds: readonly string[],
    idempotencyKey: string | null,
  ): Promise<IdempotentOutcome<{ data: JourneyEnrolmentResult }>> {
    const key = this.access.requireKey(idempotencyKey);
    const orgId = requireOrganization(principal);
    const authorize = (tx: Transaction) =>
      this.access
        .assertWorkspaceAccess(tx, principal, workspaceId, PERMISSIONS.JOURNEYS_MANAGE)
        .then(() => undefined);
    return this.idempotency.execute({
      key,
      successStatus: HttpStatus.OK,
      request: {
        method: 'POST',
        route: `/workspaces/${workspaceId}/journeys/${journeyId}/enrollments`,
        orgId,
        principal,
        pathParams: { workspaceId, journeyId },
        query: {},
        body: { contactIds: [...contactIds] },
      },
      authorize,
      work: async (tx) => {
        await authorize(tx);
        // FOR SHARE: enrolment and a concurrent pause/archive (FOR UPDATE) serialise, so an
        // archive always sees, and cancels, every execution enrolled before it.
        const journey = await this.access.loadJourney(tx, orgId, workspaceId, journeyId, 'share');
        if (journey.status !== 'active') {
          throw new AppException({
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.JOURNEY_LIFECYCLE_CONFLICT,
            message: `Only an active journey accepts enrolments; this one is ${journey.status}`,
            details: { status: journey.status },
          });
        }
        const [trigger] = await tx
          .select()
          .from(schema.journeyTriggers)
          .where(
            and(
              eq(schema.journeyTriggers.journeyId, journey.id),
              eq(schema.journeyTriggers.journeyVersionId, journey.activeVersionId!),
              eq(schema.journeyTriggers.status, 'active'),
            ),
          );
        if (!trigger || trigger.kind !== 'api') {
          throw new AppException({
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.JOURNEY_TRIGGER_NOT_API,
            message: 'This journey is entered by its event or schedule trigger, not by the API',
            details: { triggerKind: trigger?.kind ?? null },
          });
        }
        const [version] = await tx
          .select()
          .from(schema.journeyVersions)
          .where(eq(schema.journeyVersions.id, journey.activeVersionId!));
        const graph = version!.graph as JourneyGraph;
        const entryKey = graph.entry;
        const entryNode = graph.nodes[entryKey] as { next: string };
        return {
          data: await this.enrolContacts(
            tx,
            principal,
            journey,
            version!.id,
            entryKey,
            entryNode.next,
            contactIds,
            apiEntryRef(orgId, journeyId, key),
          ),
        };
      },
    });
  }

  private async enrolContacts(
    tx: Transaction,
    principal: AuthPrincipal,
    journey: JourneyRow,
    versionId: string,
    entryKey: string,
    firstNodeKey: string,
    contactIds: readonly string[],
    entryRef: string,
  ): Promise<JourneyEnrolmentResult> {
    const ids = [...new Set(contactIds)];
    const idList = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    // One statement: live contacts of this workspace, minus any contact that ever entered this
    // journey (entry policy `once`). ON CONFLICT covers concurrent enrolments: the partial
    // unique index on live executions and the entry-reference index make the loser a no-op.
    const created = await tx.execute<{ id: string; contact_id: string }>(sql`
      INSERT INTO journey_executions
        (org_id, workspace_id, journey_id, journey_version_id, contact_id, status,
         current_node_key, state_version, transitions, entry_kind, entry_ref, enrolled_by)
      SELECT c.org_id, c.workspace_id, ${journey.id}::uuid, ${versionId}::uuid, c.id, 'running',
             ${firstNodeKey}, 1, 1, 'api', ${entryRef}, ${principal.userId ?? null}::uuid
        FROM contacts c
       WHERE c.org_id = ${journey.orgId} AND c.workspace_id = ${journey.workspaceId}
         AND c.id IN (${idList})
         AND NOT EXISTS (SELECT 1 FROM journey_executions e
                          WHERE e.journey_id = ${journey.id} AND e.contact_id = c.id)
       ORDER BY c.id
      ON CONFLICT DO NOTHING
      RETURNING id, contact_id`);
    const createdRows = created.rows;
    if (createdRows.length > 0) {
      const executionIds = sql.join(
        createdRows.map((r) => sql`${r.id}::uuid`),
        sql`, `,
      );
      await tx.execute(sql`
        INSERT INTO journey_execution_queue (execution_id, org_id)
        SELECT id, org_id FROM journey_executions WHERE id IN (${executionIds})`);
      await tx.execute(sql`
        INSERT INTO journey_execution_steps
          (org_id, workspace_id, execution_id, seq, node_key, node_type, outcome, details)
        SELECT org_id, workspace_id, id, 1, ${entryKey}, 'entry', 'entered',
               jsonb_build_object('entryKind', 'api')
          FROM journey_executions WHERE id IN (${executionIds})`);
    }
    const found = await tx.execute<{ id: string }>(sql`
      SELECT id FROM contacts
       WHERE org_id = ${journey.orgId} AND workspace_id = ${journey.workspaceId}
         AND id IN (${idList})`);
    const foundIds = new Set(found.rows.map((r) => r.id));
    const createdBy = new Map(createdRows.map((r) => [r.contact_id, r.id]));
    // For contacts already in the journey: their most recent execution.
    const existing = await tx.execute<{ contact_id: string; id: string }>(sql`
      SELECT DISTINCT ON (contact_id) contact_id, id FROM journey_executions
       WHERE journey_id = ${journey.id} AND contact_id IN (${idList})
       ORDER BY contact_id, id DESC`);
    const existingBy = new Map(existing.rows.map((r) => [r.contact_id, r.id]));
    const results = contactIds.map((contactId) => {
      if (createdBy.has(contactId))
        return {
          contactId,
          outcome: 'enrolled' as const,
          executionId: createdBy.get(contactId)!,
        };
      if (!foundIds.has(contactId))
        return { contactId, outcome: 'contact_not_found' as const, executionId: null };
      return {
        contactId,
        outcome: 'already_enrolled' as const,
        executionId: existingBy.get(contactId) ?? null,
      };
    });
    const count = (o: string) => results.filter((r) => r.outcome === o).length;
    const summary = {
      journeyId: journey.id,
      journeyVersionId: versionId,
      enrolled: count('enrolled'),
      alreadyEnrolled: count('already_enrolled'),
      contactNotFound: count('contact_not_found'),
    };
    await this.access.recordAudit(
      tx,
      principal,
      journey.workspaceId,
      JOURNEY_AUDIT_ACTIONS.ENROLLED,
      journey.id,
      { ...summary, requested: contactIds.length, entryKind: 'api' },
    );
    return { ...summary, results };
  }

  // --- reads -------------------------------------------------------------------------------

  async list(
    principal: AuthPrincipal,
    workspaceId: string,
    journeyId: string,
    filter: ListExecutionsFilter = {},
  ): Promise<{ items: readonly JourneyExecutionRecord[]; page: PageInfo }> {
    const resolved = this.lists.resolve(filter, this.listSpec);
    const rows = await this.db.withRequestTenant(async (tx) => {
      const orgId = await this.access.assertWorkspaceAccess(
        tx,
        principal,
        workspaceId,
        PERMISSIONS.JOURNEYS_READ,
      );
      const journey = await this.access.loadJourney(tx, orgId, workspaceId, journeyId);
      const predicates: SQL[] = [
        eq(schema.journeyExecutions.orgId, orgId),
        eq(schema.journeyExecutions.journeyId, journey.id),
      ];
      if (filter.status) predicates.push(eq(schema.journeyExecutions.status, filter.status));
      if (filter.contactId)
        predicates.push(eq(schema.journeyExecutions.contactId, filter.contactId));
      if (filter.versionId)
        predicates.push(eq(schema.journeyExecutions.journeyVersionId, filter.versionId));
      if (resolved.after) predicates.push(resolved.after);
      return tx
        .select()
        .from(schema.journeyExecutions)
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
    return { items: (items as unknown as ExecutionRow[]).map(executionView), page };
  }

  async get(
    principal: AuthPrincipal,
    workspaceId: string,
    journeyId: string,
    executionId: string,
  ): Promise<JourneyExecutionDetailRecord> {
    return this.db.withRequestTenant(async (tx) => {
      const orgId = await this.access.assertWorkspaceAccess(
        tx,
        principal,
        workspaceId,
        PERMISSIONS.JOURNEYS_READ,
      );
      const journey = await this.access.loadJourney(tx, orgId, workspaceId, journeyId);
      const execution = await this.loadExecution(tx, journey, executionId);
      return this.detail(tx, execution);
    });
  }

  private async detail(
    tx: Transaction,
    execution: ExecutionRow,
  ): Promise<JourneyExecutionDetailRecord> {
    const steps = await tx
      .select()
      .from(schema.journeyExecutionSteps)
      .where(
        and(
          eq(schema.journeyExecutionSteps.executionId, execution.id),
          eq(schema.journeyExecutionSteps.orgId, execution.orgId),
        ),
      )
      .orderBy(asc(schema.journeyExecutionSteps.seq))
      .limit(MAX_STEPS);
    return { ...executionView(execution), steps: steps.map(stepView) };
  }

  private async loadExecution(
    tx: Transaction,
    journey: JourneyRow,
    executionId: string,
    lock = false,
  ): Promise<ExecutionRow> {
    const q = tx
      .select()
      .from(schema.journeyExecutions)
      .where(
        and(
          eq(schema.journeyExecutions.id, executionId),
          eq(schema.journeyExecutions.journeyId, journey.id),
          eq(schema.journeyExecutions.orgId, journey.orgId),
        ),
      )
      .limit(1);
    const [row] = lock ? await q.for('update') : await q;
    if (!row)
      throw journeyNotFound(
        ERROR_CODES.JOURNEY_EXECUTION_NOT_FOUND,
        'Journey execution not found',
        {
          requestedExecutionId: executionId,
        },
      );
    return row;
  }

  // --- operator cancel ---------------------------------------------------------------------

  /**
   * Ends a live execution as `cancelled` (`operator_cancelled`). Conditional on the
   * `state_version` read under the row lock, and it advances `state_version`, so a runner
   * holding an older claim can never commit a transition afterwards. A repeat is a no-op;
   * an execution that ended otherwise is `409 JOURNEY_EXECUTION_ENDED`.
   */
  async cancel(
    principal: AuthPrincipal,
    workspaceId: string,
    journeyId: string,
    executionId: string,
  ): Promise<JourneyExecutionDetailRecord> {
    return this.db.withRequestTenant(async (tx) => {
      const orgId = await this.access.assertWorkspaceAccess(
        tx,
        principal,
        workspaceId,
        PERMISSIONS.JOURNEYS_MANAGE,
      );
      const journey = await this.access.loadJourney(tx, orgId, workspaceId, journeyId);
      const execution = await this.loadExecution(tx, journey, executionId, true);
      if (execution.status === 'cancelled') return this.detail(tx, execution);
      if (execution.status !== 'running' && execution.status !== 'waiting') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.JOURNEY_EXECUTION_ENDED,
          message: `The execution has already ended (${execution.status})`,
          details: { status: execution.status },
        });
      }
      const seq = execution.stateVersion + 1;
      const [updated] = await tx
        .update(schema.journeyExecutions)
        .set({
          status: 'cancelled',
          endedAt: sql`now()`,
          endReason: JOURNEY_END_REASONS.OPERATOR_CANCELLED,
          wakeAt: null,
          stateVersion: seq,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.journeyExecutions.id, execution.id),
            eq(schema.journeyExecutions.stateVersion, execution.stateVersion),
            inArray(schema.journeyExecutions.status, ['running', 'waiting']),
          ),
        )
        .returning();
      if (!updated) {
        // Unreachable under the row lock; kept so a lost race can never write history.
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.JOURNEY_EXECUTION_ENDED,
          message: 'The execution changed concurrently',
        });
      }
      await tx
        .delete(schema.journeyExecutionQueue)
        .where(eq(schema.journeyExecutionQueue.executionId, execution.id));
      const [version] = await tx
        .select({ graph: schema.journeyVersions.graph })
        .from(schema.journeyVersions)
        .where(eq(schema.journeyVersions.id, execution.journeyVersionId));
      const nodeKey = execution.currentNodeKey!;
      const nodes = (version!.graph as JourneyGraph).nodes;
      const nodeType = Object.prototype.hasOwnProperty.call(nodes, nodeKey)
        ? nodes[nodeKey]!.type
        : 'unknown';
      await tx.insert(schema.journeyExecutionSteps).values({
        orgId: execution.orgId,
        workspaceId: execution.workspaceId,
        executionId: execution.id,
        seq,
        nodeKey,
        nodeType,
        outcome: 'cancelled',
        details: { reason: JOURNEY_END_REASONS.OPERATOR_CANCELLED },
      });
      await this.access.recordAudit(
        tx,
        principal,
        workspaceId,
        JOURNEY_AUDIT_ACTIONS.EXECUTION_CANCELLED,
        journey.id,
        { executionId: execution.id, journeyVersionId: execution.journeyVersionId, nodeKey },
      );
      return this.detail(tx, updated);
    });
  }

  // --- statistics --------------------------------------------------------------------------

  /**
   * Per-version execution totals by status, and per node: live executions positioned there and
   * history rows by outcome. Versions that never ran (drafts) are omitted; `versionId`
   * narrows to one version.
   */
  async stats(
    principal: AuthPrincipal,
    workspaceId: string,
    journeyId: string,
    versionId?: string,
  ): Promise<JourneyStatsRecord> {
    return this.db.withRequestTenant(async (tx) => {
      const orgId = await this.access.assertWorkspaceAccess(
        tx,
        principal,
        workspaceId,
        PERMISSIONS.JOURNEYS_READ,
      );
      const journey = await this.access.loadJourney(tx, orgId, workspaceId, journeyId);
      const versionPredicates: SQL[] = [
        eq(schema.journeyVersions.journeyId, journey.id),
        ne(schema.journeyVersions.status, 'draft'),
      ];
      if (versionId) versionPredicates.push(eq(schema.journeyVersions.id, versionId));
      const versions = await tx
        .select()
        .from(schema.journeyVersions)
        .where(and(...versionPredicates))
        .orderBy(asc(schema.journeyVersions.versionNumber));
      if (versionId && versions.length === 0)
        throw journeyNotFound(ERROR_CODES.JOURNEY_VERSION_NOT_FOUND, 'Journey version not found', {
          requestedVersionId: versionId,
        });

      const byStatus = await tx.execute<{ v: string; status: JourneyExecutionStatus; n: number }>(
        sql`SELECT journey_version_id AS v, status, count(*)::int AS n FROM journey_executions
             WHERE journey_id = ${journey.id} AND org_id = ${orgId}
             GROUP BY 1, 2`,
      );
      const positions = await tx.execute<{
        v: string;
        node: string;
        status: 'running' | 'waiting';
        n: number;
      }>(
        sql`SELECT journey_version_id AS v, current_node_key AS node, status, count(*)::int AS n
              FROM journey_executions
             WHERE journey_id = ${journey.id} AND org_id = ${orgId}
               AND status IN ('running', 'waiting')
             GROUP BY 1, 2, 3`,
      );
      const outcomes = await tx.execute<{
        v: string;
        node: string;
        outcome: JourneyStepOutcome;
        n: number;
      }>(
        sql`SELECT e.journey_version_id AS v, s.node_key AS node, s.outcome, count(*)::int AS n
              FROM journey_execution_steps s
              JOIN journey_executions e ON e.id = s.execution_id AND e.org_id = s.org_id
             WHERE e.journey_id = ${journey.id} AND e.org_id = ${orgId}
             GROUP BY 1, 2, 3`,
      );

      const result: JourneyVersionStats[] = versions.map((v) => {
        const executions = Object.fromEntries(
          JOURNEY_EXECUTION_STATUSES.map((s) => [s, 0]),
        ) as Record<JourneyExecutionStatus, number>;
        for (const r of byStatus.rows) if (r.v === v.id) executions[r.status] = Number(r.n);
        const total = Object.values(executions).reduce((a, b) => a + b, 0);
        const graphNodes = (v.graph as JourneyGraph).nodes ?? {};
        const nodes: JourneyNodeStats[] = journeyNodeOrder(v.graph as JourneyGraph).map(
          (nodeKey) => {
            const at = (status: 'running' | 'waiting') =>
              Number(
                positions.rows.find(
                  (p) => p.v === v.id && p.node === nodeKey && p.status === status,
                )?.n ?? 0,
              );
            const byOutcome: Partial<Record<JourneyStepOutcome, number>> = {};
            for (const o of outcomes.rows)
              if (o.v === v.id && o.node === nodeKey) byOutcome[o.outcome] = Number(o.n);
            return {
              nodeKey,
              nodeType: graphNodes[nodeKey]!.type,
              running: at('running'),
              waiting: at('waiting'),
              outcomes: byOutcome,
            };
          },
        );
        return {
          versionId: v.id,
          versionNumber: v.versionNumber,
          executions: { ...executions, total },
          nodes,
        };
      });
      return { journeyId: journey.id, versions: result };
    });
  }
}
