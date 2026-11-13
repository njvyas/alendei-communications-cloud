import type {
  JourneyExecutionRecord,
  JourneyExecutionStepRecord,
  JourneyGraph,
  JourneyRecord,
  JourneyTriggerRecord,
  JourneyVersionRecord,
  JourneyVersionSummary,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, inArray, ne } from 'drizzle-orm';

import type { ExecutionRow, JourneyRow, TriggerRow, VersionRow } from './journey-access';

type StepRow = typeof schema.journeyExecutionSteps.$inferSelect;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function versionSummary(v: VersionRow): JourneyVersionSummary {
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    status: v.status,
    graphSha256: v.graphSha256,
    publishedAt: iso(v.publishedAt),
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

export function versionView(v: VersionRow): JourneyVersionRecord {
  return {
    ...versionSummary(v),
    journeyId: v.journeyId,
    workspaceId: v.workspaceId,
    graphSchemaVersion: v.graphSchemaVersion,
    graph: v.graph as JourneyGraph,
    createdBy: v.createdBy,
    publishedBy: v.publishedBy,
  };
}

export function triggerView(t: TriggerRow): JourneyTriggerRecord {
  return {
    id: t.id,
    journeyVersionId: t.journeyVersionId,
    kind: t.kind,
    eventKind: t.eventKind,
    eventTag: t.eventTag,
    segmentId: t.segmentId,
    nextFireAt: iso(t.nextFireAt),
    status: t.status,
  };
}

export function journeyView(
  j: JourneyRow,
  versions: readonly VersionRow[],
  triggers: readonly TriggerRow[],
): JourneyRecord {
  const own = versions.filter((v) => v.journeyId === j.id);
  const draft = own.find((v) => v.status === 'draft') ?? null;
  const published = own
    .filter((v) => v.status !== 'draft')
    .sort((a, b) => b.versionNumber - a.versionNumber)[0];
  const trigger = triggers.find((t) => t.journeyId === j.id && t.status !== 'retired') ?? null;
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
    draftVersion: draft ? versionSummary(draft) : null,
    latestPublishedVersion: published ? versionSummary(published) : null,
    activeVersionId: j.activeVersionId,
    activatedAt: iso(j.activatedAt),
    activatedBy: j.activatedBy,
    trigger: trigger ? triggerView(trigger) : null,
  };
}

export function executionView(e: ExecutionRow): JourneyExecutionRecord {
  return {
    id: e.id,
    journeyId: e.journeyId,
    journeyVersionId: e.journeyVersionId,
    workspaceId: e.workspaceId,
    contactId: e.contactId,
    status: e.status,
    currentNodeKey: e.currentNodeKey,
    wakeAt: iso(e.wakeAt),
    stateVersion: e.stateVersion,
    transitions: e.transitions,
    entryKind: e.entryKind,
    enrolledBy: e.enrolledBy,
    enteredAt: e.enteredAt.toISOString(),
    endedAt: iso(e.endedAt),
    endReason: e.endReason,
    updatedAt: e.updatedAt.toISOString(),
  };
}

export function stepView(s: StepRow): JourneyExecutionStepRecord {
  return {
    seq: s.seq,
    nodeKey: s.nodeKey,
    nodeType: s.nodeType,
    outcome: s.outcome,
    attempt: s.attempt,
    messageId: s.messageId,
    errorCode: s.errorCode,
    details: s.details as Record<string, unknown>,
    startedAt: s.startedAt.toISOString(),
    finishedAt: s.finishedAt.toISOString(),
  };
}

export async function versionsOf(
  tx: Transaction,
  journeyIds: readonly string[],
): Promise<VersionRow[]> {
  if (journeyIds.length === 0) return [];
  return tx
    .select()
    .from(schema.journeyVersions)
    .where(inArray(schema.journeyVersions.journeyId, [...journeyIds]));
}

/** The live (non-retired) trigger of each journey. */
export async function liveTriggersOf(
  tx: Transaction,
  journeyIds: readonly string[],
): Promise<TriggerRow[]> {
  if (journeyIds.length === 0) return [];
  return tx
    .select()
    .from(schema.journeyTriggers)
    .where(
      and(
        inArray(schema.journeyTriggers.journeyId, [...journeyIds]),
        ne(schema.journeyTriggers.status, 'retired'),
      ),
    );
}

/** A journey's full record, read inside the caller's transaction. */
export async function loadJourneyView(tx: Transaction, j: JourneyRow): Promise<JourneyRecord> {
  return journeyView(j, await versionsOf(tx, [j.id]), await liveTriggersOf(tx, [j.id]));
}
