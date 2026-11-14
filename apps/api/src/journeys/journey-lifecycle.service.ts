import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  JOURNEY_AUDIT_ACTIONS,
  JOURNEY_END_REASONS,
  PERMISSIONS,
  deriveJourneyTrigger,
  journeyGraphHasSendNode,
  journeyLifecycleTarget,
  nextJourneyScheduleFire,
  type AuthPrincipal,
  type JourneyGraph,
  type JourneyLifecycleAction,
  type JourneyRecord,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { AuthorizationService } from '../auth/authorization.service';
import { AppException } from '../common/errors/app.exception';
import { TenantDatabase } from '../database/tenant-database.service';
import { JourneyAccess, type JourneyRow, type VersionRow } from './journey-access';
import { JourneyValidation } from './journey-validation';
import { loadJourneyView } from './journey-views';

const AUDIT_ACTION: Record<JourneyLifecycleAction, string> = {
  activate: JOURNEY_AUDIT_ACTIONS.ACTIVATED,
  pause: JOURNEY_AUDIT_ACTIONS.PAUSED,
  resume: JOURNEY_AUDIT_ACTIONS.RESUMED,
  archive: JOURNEY_AUDIT_ACTIONS.ARCHIVED,
};

/**
 * Phase 8C PR 8C-2: the journey lifecycle (`docs/PHASE-8C-JOURNEYS-HANDOVER.md` §8.5).
 *
 * - **activate** (`draft → active`): the highest published version becomes the active version;
 *   its trigger is derived from the entry node and persisted.
 * - **pause** (`active → paused`): the trigger is paused. Executions keep their state.
 * - **resume** (`paused → active`): the trigger is re-armed (`next_fire_at` recomputed).
 * - **archive** (`* → archived`, terminal): the trigger is retired and every live execution
 *   ends `cancelled` (`journey_archived`).
 * - **promotion**: publishing a version while the journey is active or paused makes it the
 *   active version; executions already running finish on their own version.
 *
 * Activation, resume and promotion require `messages.send` at the journey's workspace
 * (handover §11.4) and refuse any version with a `send_message` node (`JOURNEY_SEND_DISABLED`):
 * journey sends stay disabled until the shared automation sending principal exists (owner
 * decisions 1–2, 10-Nov-2026). **Nothing here runs a journey**: no runner, trigger intake or
 * scheduler exists in 8C-2, so an active journey only accepts API enrolments, which wait
 * unclaimed in `journey_execution_queue`.
 *
 * Every transition is conditional on the current status under a row lock, and a repeat in the
 * target state is a no-op (no write, no audit).
 */
@Injectable()
export class JourneyLifecycleService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly access: JourneyAccess,
    private readonly authorization: AuthorizationService,
    private readonly validation: JourneyValidation,
  ) {}

  async transition(
    principal: AuthPrincipal,
    workspaceId: string,
    journeyId: string,
    action: JourneyLifecycleAction,
  ): Promise<JourneyRecord> {
    return this.db.withRequestTenant(async (tx) => {
      const orgId = await this.access.assertWorkspaceAccess(
        tx,
        principal,
        workspaceId,
        PERMISSIONS.JOURNEYS_MANAGE,
      );
      const journey = await this.access.loadJourney(tx, orgId, workspaceId, journeyId, 'update');
      const target = journeyLifecycleTarget(action, journey.status);
      if (target === null) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.JOURNEY_LIFECYCLE_CONFLICT,
          message: `Cannot ${action} a journey that is ${journey.status}`,
          details: { status: journey.status, action },
        });
      }
      if (target === journey.status) return loadJourneyView(tx, journey); // repeat: no-op

      let metadata: Record<string, unknown>;
      switch (action) {
        case 'activate':
          metadata = await this.activate(tx, principal, journey);
          break;
        case 'pause':
          metadata = await this.setTriggerStatus(tx, journey, 'paused', 'active');
          await this.setStatus(tx, journey, 'paused');
          break;
        case 'resume':
          metadata = await this.resume(tx, principal, journey);
          break;
        case 'archive':
          metadata = await this.archive(tx, journey);
          break;
      }
      await this.access.recordAudit(tx, principal, workspaceId, AUDIT_ACTION[action], journeyId, {
        from: journey.status,
        to: target,
        ...metadata,
      });
      const [row] = await tx
        .select()
        .from(schema.journeys)
        .where(eq(schema.journeys.id, journey.id));
      return loadJourneyView(tx, row!);
    });
  }

  /**
   * Publishing while active or paused: the new version becomes the active version (handover
   * §8.5). Called inside the publish transaction, with the journey row locked, after the graph
   * passed full validation. Returns the audit metadata to merge, or `null` when the journey is
   * not live (a draft or archived journey activates nothing on publish).
   */
  async promoteOnPublish(
    tx: Transaction,
    principal: AuthPrincipal,
    journey: JourneyRow,
    version: VersionRow,
  ): Promise<Record<string, unknown> | null> {
    if (journey.status !== 'active' && journey.status !== 'paused') return null;
    await this.assertRunnable(tx, principal, journey, version, { revalidate: false });
    const previous = journey.activeVersionId;
    const triggerStatus = journey.status === 'active' ? 'active' : 'paused';
    await this.retireTriggers(tx, journey);
    await this.retireOtherPublished(tx, journey, version.id);
    const trigger = await this.insertTrigger(tx, journey, version, triggerStatus);
    await tx
      .update(schema.journeys)
      .set({ activeVersionId: version.id, updatedAt: sql`now()` })
      .where(eq(schema.journeys.id, journey.id));
    return { promoted: true, previousActiveVersionId: previous, triggerKind: trigger.kind };
  }

  // --- transitions -----------------------------------------------------------------------

  private async activate(
    tx: Transaction,
    principal: AuthPrincipal,
    journey: JourneyRow,
  ): Promise<Record<string, unknown>> {
    const [version] = await tx
      .select()
      .from(schema.journeyVersions)
      .where(
        and(
          eq(schema.journeyVersions.journeyId, journey.id),
          eq(schema.journeyVersions.status, 'published'),
        ),
      )
      .orderBy(desc(schema.journeyVersions.versionNumber))
      .limit(1);
    if (!version) {
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.JOURNEY_NO_PUBLISHED_VERSION,
        message: 'A journey needs a published version before it can be activated',
      });
    }
    await this.assertRunnable(tx, principal, journey, version, { revalidate: true });
    await this.retireOtherPublished(tx, journey, version.id);
    const trigger = await this.insertTrigger(tx, journey, version, 'active');
    await tx
      .update(schema.journeys)
      .set({
        status: 'active',
        activeVersionId: version.id,
        activatedAt: sql`now()`,
        activatedBy: principal.userId ?? null,
        updatedAt: sql`now()`,
      })
      .where(eq(schema.journeys.id, journey.id));
    return {
      versionId: version.id,
      versionNumber: version.versionNumber,
      triggerKind: trigger.kind,
    };
  }

  private async resume(
    tx: Transaction,
    principal: AuthPrincipal,
    journey: JourneyRow,
  ): Promise<Record<string, unknown>> {
    const [version] = await tx
      .select()
      .from(schema.journeyVersions)
      .where(eq(schema.journeyVersions.id, journey.activeVersionId!));
    await this.assertRunnable(tx, principal, journey, version!, {
      revalidate: true,
      allowElapsedOnce: true,
    });
    const graph = version!.graph as JourneyGraph;
    const derived = deriveJourneyTrigger(graph);
    const nextFireAt =
      derived.kind === 'schedule' ? nextJourneyScheduleFire(derived.schedule!, new Date()) : null;
    await tx
      .update(schema.journeyTriggers)
      .set({ status: 'active', nextFireAt, updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.journeyTriggers.journeyId, journey.id),
          eq(schema.journeyTriggers.status, 'paused'),
        ),
      );
    await this.setStatus(tx, journey, 'active');
    return { versionId: version!.id };
  }

  private async archive(tx: Transaction, journey: JourneyRow): Promise<Record<string, unknown>> {
    await this.retireTriggers(tx, journey);
    const cancelled = await this.cancelLiveExecutions(tx, journey);
    await this.setStatus(tx, journey, 'archived');
    return { cancelledExecutions: cancelled };
  }

  // --- checks and helpers ----------------------------------------------------------------

  /**
   * The rules every path that makes a version runnable applies (activate, resume, promote):
   * the caller holds `messages.send` at the workspace (a journey must not grant send rights
   * its author lacks); the version has no `send_message` node while sends are disabled; the
   * graph still validates against the organisation's data; a one-off schedule is not already
   * in the past.
   */
  private async assertRunnable(
    tx: Transaction,
    principal: AuthPrincipal,
    journey: JourneyRow,
    version: VersionRow,
    opts: { readonly revalidate: boolean; readonly allowElapsedOnce?: boolean },
  ): Promise<void> {
    await this.authorization.assert(tx, {
      principal,
      permission: PERMISSIONS.MESSAGES_SEND,
      target: { scopeType: 'workspace', scopeId: journey.workspaceId },
      resourceType: 'Workspace',
    });
    const graph = version.graph as JourneyGraph;
    if (journeyGraphHasSendNode(graph)) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.JOURNEY_SEND_DISABLED,
        message:
          'Journey sends are disabled until the shared automation sending principal exists; a version with a send_message node cannot run.',
        details: { versionId: version.id },
        logContext: { journeyId: journey.id },
      });
    }
    if (opts.revalidate) {
      const report = await this.validation.fullReport(
        tx,
        journey.orgId,
        journey.workspaceId,
        graph,
      );
      if (!report.valid) {
        throw new AppException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: ERROR_CODES.JOURNEY_GRAPH_INVALID,
          message: 'The journey version no longer validates and cannot run',
          details: { report },
        });
      }
    }
    const derived = deriveJourneyTrigger(graph);
    if (
      !opts.allowElapsedOnce &&
      derived.kind === 'schedule' &&
      derived.schedule!.type === 'once' &&
      nextJourneyScheduleFire(derived.schedule!, new Date()) === null
    ) {
      const key = graph.entry;
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ERROR_CODES.JOURNEY_GRAPH_INVALID,
        message: 'The one-off schedule has already passed',
        details: {
          report: {
            valid: false,
            errors: [
              {
                code: 'SCHEDULE_ELAPSED',
                nodeKey: key,
                path: 'trigger.schedule.at',
                message: 'the scheduled instant has already passed',
              },
            ],
            warnings: [],
          },
        },
      });
    }
  }

  private async setStatus(
    tx: Transaction,
    journey: JourneyRow,
    status: JourneyRow['status'],
  ): Promise<void> {
    await tx
      .update(schema.journeys)
      .set({ status, updatedAt: sql`now()` })
      .where(and(eq(schema.journeys.id, journey.id), eq(schema.journeys.status, journey.status)));
  }

  private async setTriggerStatus(
    tx: Transaction,
    journey: JourneyRow,
    to: 'active' | 'paused',
    from: 'active' | 'paused',
  ): Promise<Record<string, unknown>> {
    await tx
      .update(schema.journeyTriggers)
      .set({ status: to, updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.journeyTriggers.journeyId, journey.id),
          eq(schema.journeyTriggers.status, from),
        ),
      );
    return {};
  }

  private async retireTriggers(tx: Transaction, journey: JourneyRow): Promise<void> {
    await tx
      .update(schema.journeyTriggers)
      .set({ status: 'retired', nextFireAt: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.journeyTriggers.journeyId, journey.id),
          ne(schema.journeyTriggers.status, 'retired'),
        ),
      );
  }

  /** Older published versions stop being enrollable: they become `retired` (immutable guard allows it). */
  private async retireOtherPublished(
    tx: Transaction,
    journey: JourneyRow,
    keepVersionId: string,
  ): Promise<void> {
    await tx
      .update(schema.journeyVersions)
      .set({ status: 'retired', updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.journeyVersions.journeyId, journey.id),
          eq(schema.journeyVersions.status, 'published'),
          ne(schema.journeyVersions.id, keepVersionId),
        ),
      );
  }

  private async insertTrigger(
    tx: Transaction,
    journey: JourneyRow,
    version: VersionRow,
    status: 'active' | 'paused',
  ) {
    const derived = deriveJourneyTrigger(version.graph as JourneyGraph);
    const [trigger] = await tx
      .insert(schema.journeyTriggers)
      .values({
        id: uuidv7(),
        orgId: journey.orgId,
        workspaceId: journey.workspaceId,
        journeyId: journey.id,
        journeyVersionId: version.id,
        kind: derived.kind,
        eventKind: derived.eventKind,
        eventTag: derived.eventTag,
        segmentId: derived.segmentId,
        schedule: derived.schedule,
        nextFireAt:
          derived.kind === 'schedule'
            ? nextJourneyScheduleFire(derived.schedule!, new Date())
            : null,
        status,
      })
      .returning();
    return trigger!;
  }

  /**
   * Ends every live execution of the journey as `cancelled` (`journey_archived`): one
   * conditional, fenced update (`state_version + 1`), one history row each (`seq` = the new
   * `state_version`), and their queue rows removed — in the caller's transaction.
   */
  private async cancelLiveExecutions(tx: Transaction, journey: JourneyRow): Promise<number> {
    const result = await tx.execute<{ n: number }>(sql`
      WITH ended AS (
        UPDATE journey_executions e
           SET status = 'cancelled', ended_at = now(), end_reason = ${JOURNEY_END_REASONS.JOURNEY_ARCHIVED},
               wake_at = NULL, wait_deadline_at = NULL, state_version = e.state_version + 1, updated_at = now()
         WHERE e.journey_id = ${journey.id} AND e.org_id = ${journey.orgId}
           AND e.status IN ('running', 'waiting')
        RETURNING e.id, e.org_id, e.workspace_id, e.journey_version_id, e.state_version, e.current_node_key
      ), history AS (
        INSERT INTO journey_execution_steps
          (org_id, workspace_id, execution_id, seq, node_key, node_type, outcome, details)
        SELECT ended.org_id, ended.workspace_id, ended.id, ended.state_version, ended.current_node_key,
               coalesce(v.graph -> 'nodes' -> ended.current_node_key ->> 'type', 'unknown'),
               'cancelled', jsonb_build_object('reason', ${JOURNEY_END_REASONS.JOURNEY_ARCHIVED}::text)
          FROM ended JOIN journey_versions v ON v.id = ended.journey_version_id
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM history`);
    // Queue rows of ended executions: nothing may claim them again.
    await tx.execute(sql`
      DELETE FROM journey_execution_queue q
       USING journey_executions e
       WHERE q.execution_id = e.id AND e.journey_id = ${journey.id}
         AND e.status NOT IN ('running', 'waiting')`);
    return Number(result.rows[0]?.n ?? 0);
  }
}
