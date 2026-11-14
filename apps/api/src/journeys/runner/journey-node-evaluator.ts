import {
  JOURNEY_CUSTOM_FIELD_PATTERN,
  JOURNEY_END_REASONS,
  JOURNEY_NODE_CATALOGUE,
  JOURNEY_RUNNER_ERROR_CODES,
  journeySendRefusedCode,
  nextJourneyWindowStart,
  type JourneyConditionRule,
  type JourneyContactUpdate,
  type JourneyNode,
  type JourneyStepOutcome,
  type JourneyValueSource,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';

import {
  FORBIDDEN_CUSTOM_FIELDS,
  contactTagsFromMetadata,
} from '../../contacts/audience-predicates';
import {
  messageOutcomeReached,
  nextOutcomeRecheck,
  sendRefusalDisposition,
  type JourneySendPort,
  type JourneySendResult,
  type SentMessageState,
} from './journey-send.port';
import { JourneyNodeFailure, JourneySendRetry } from './runner-errors';
import { resolveChannelId, segmentPredicates } from './segment-criteria';

/**
 * Phase 8C PR 8C-3: what one node does, given the claimed execution's current state
 * (handover §§6, 8.3). The runner applies the result in the same transaction.
 *
 * - waits arm a timer (`wait`) on the first visit and complete (`advance`) once it is due;
 * - conditions read the contact's **current** state inside the transaction;
 * - `update_contact` writes the contact (the runner audits it);
 * - `exit` ends the execution `completed`;
 * - placeholders (webhook, CRM, human and AI handoff) record `stubbed` and do nothing;
 * - 8C-5b: `send_message` goes through the `JourneySendPort` (unavailable in production until
 *   8C-6, so the execution fails `SEND_UNAVAILABLE`); `wait_for_outcome` and the
 *   `send_outcome` condition read the claimed execution's attributed message (0067).
 */
export type NodeResult =
  | {
      readonly kind: 'advance';
      readonly next: string;
      readonly outcome: JourneyStepOutcome;
      readonly details: Record<string, unknown>;
      /** Set when the node wrote the contact (the runner audits it). */
      readonly contactUpdate?: { readonly operations: readonly Record<string, unknown>[] };
      /** 8C-5b: the message a completed send created (the step's `message_id`). */
      readonly messageId?: string;
      readonly errorCode?: string;
    }
  | {
      readonly kind: 'wait';
      readonly until: Date;
      readonly details: Record<string, unknown>;
      /** 8C-5b: set only by `wait_for_outcome` when it arms (`wait_deadline_at`). */
      readonly deadline?: Date;
    }
  | {
      /** 8C-5b: a `wait_for_outcome` re-check without an outcome: a new `wake_at`, no history. */
      readonly kind: 'rearm';
      readonly until: Date;
    }
  | {
      readonly kind: 'end';
      readonly status: 'completed' | 'exited';
      readonly endReason: string;
      readonly outcome: JourneyStepOutcome;
      readonly details: Record<string, unknown>;
      readonly errorCode?: string;
    };

export interface ExecutionState {
  readonly id: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly journeyId: string;
  readonly contactId: string;
  readonly status: 'running' | 'waiting';
  readonly wakeAt: Date | null;
  /** 8C-5b: set only while waiting at a `wait_for_outcome` node. */
  readonly waitDeadlineAt: Date | null;
}

export interface NodeDependencies {
  readonly sendPort: JourneySendPort;
}

type ContactRow = typeof schema.contacts.$inferSelect;

export async function evaluateNode(
  tx: Transaction,
  node: JourneyNode,
  execution: ExecutionState,
  now: Date,
  deps: NodeDependencies,
  nodeKey: string,
): Promise<NodeResult> {
  switch (node.type) {
    case 'entry':
      return { kind: 'advance', next: node.next, outcome: 'completed', details: {} };
    case 'wait_duration':
      return waitResult(
        node.next,
        execution,
        now,
        () => new Date(now.getTime() + node.seconds * 1000),
      );
    case 'wait_until':
      return waitResult(node.next, execution, now, () => new Date(Date.parse(node.at)));
    case 'wait_window':
      return waitResult(node.next, execution, now, () => nextJourneyWindowStart(node, now) ?? now);
    case 'condition': {
      const result = await evaluateCondition(tx, node.rule, execution);
      return {
        kind: 'advance',
        next: result ? node.onTrue : node.onFalse,
        outcome: 'completed',
        details: { conditionKind: node.rule.kind, result },
      };
    }
    case 'update_contact': {
      const operations = await applyContactUpdates(tx, node.operations, execution);
      return {
        kind: 'advance',
        next: node.next,
        outcome: 'completed',
        details: { operations },
        contactUpdate: { operations },
      };
    }
    case 'exit':
      return {
        kind: 'end',
        status: 'completed',
        endReason: node.reason ?? JOURNEY_END_REASONS.EXIT_NODE,
        outcome: 'exited',
        details: {},
      };
    case 'webhook':
    case 'crm_action':
    case 'human_handoff':
    case 'ai_handoff':
      // Placeholders (owner decision 3, ROADMAP §11c): recorded, nothing performed, no call out.
      return {
        kind: 'advance',
        next: node.next,
        outcome: 'stubbed',
        details: { placeholder: node.type },
      };
    case 'send_message':
      return evaluateSend(tx, node, execution, deps.sendPort, nodeKey);
    case 'wait_for_outcome':
      return evaluateWaitForOutcome(tx, node, execution, now);
    default: {
      const type = (node as { type?: unknown }).type;
      if (
        typeof type === 'string' &&
        Object.prototype.hasOwnProperty.call(JOURNEY_NODE_CATALOGUE, type)
      )
        throw new JourneyNodeFailure(
          JOURNEY_RUNNER_ERROR_CODES.NODE_MISSING,
          `unhandled node type`,
        );
      throw new JourneyNodeFailure(JOURNEY_RUNNER_ERROR_CODES.NODE_MISSING, 'unknown node type');
    }
  }
}

/** First visit: wait until `target` (or pass straight through when it is not in the future). */
function waitResult(
  next: string,
  execution: ExecutionState,
  now: Date,
  target: () => Date,
): NodeResult {
  if (execution.status === 'waiting') {
    return { kind: 'advance', next, outcome: 'completed', details: { waited: true } };
  }
  const until = target();
  if (until.getTime() <= now.getTime()) {
    return { kind: 'advance', next, outcome: 'completed', details: { waited: false } };
  }
  return { kind: 'wait', until, details: { until: until.toISOString() } };
}

// --- conditions ------------------------------------------------------------------------------

async function loadContact(
  tx: Transaction,
  execution: ExecutionState,
  forUpdate = false,
): Promise<ContactRow> {
  const q = tx
    .select()
    .from(schema.contacts)
    .where(
      and(eq(schema.contacts.id, execution.contactId), eq(schema.contacts.orgId, execution.orgId)),
    )
    .limit(1);
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) throw new JourneyNodeFailure('CONTACT_UNAVAILABLE', 'contact is not available');
  return row;
}

/** A contact field's current value as a string, or `null` when absent. */
function fieldValue(contact: ContactRow, field: string): string | null {
  if (field === 'firstName') return contact.firstName;
  if (field === 'lastName') return contact.lastName;
  const key = field.slice('custom.'.length);
  const metadata = (contact.metadata ?? {}) as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(metadata, key)) return null;
  const v = metadata[key];
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export async function evaluateCondition(
  tx: Transaction,
  rule: JourneyConditionRule,
  execution: ExecutionState,
): Promise<boolean> {
  switch (rule.kind) {
    case 'attribute': {
      const value = fieldValue(await loadContact(tx, execution), rule.field);
      const present = value !== null && value.trim().length > 0;
      if (rule.op === 'exists') return present;
      if (rule.op === 'not_exists') return !present;
      // eq / neq: case-insensitive, as the segment `equals` filter.
      const equal = value !== null && value.toLowerCase() === (rule.value ?? '').toLowerCase();
      return rule.op === 'eq' ? equal : !equal;
    }
    case 'tag': {
      const tags = contactTagsFromMetadata((await loadContact(tx, execution)).metadata).map((t) =>
        t.toLowerCase(),
      );
      return tags.includes(rule.tag.trim().toLowerCase()) === rule.present;
    }
    case 'segment': {
      const predicates = await segmentPredicates(tx, {
        id: rule.segmentId,
        orgId: execution.orgId,
        workspaceId: execution.workspaceId,
      });
      const { rows } = await tx.execute<{ member: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM ${schema.contacts}
           WHERE ${schema.contacts.id} = ${execution.contactId}
             AND ${schema.contacts.orgId} = ${execution.orgId}
             AND ${schema.contacts.workspaceId} = ${execution.workspaceId}
             ${predicates.length > 0 ? sql`AND ${sql.join(predicates, sql` AND `)}` : sql``}
        ) AS member`);
      return Boolean(rows[0]?.member) === rule.member;
    }
    case 'consent': {
      const channelId = await resolveChannelId(tx, rule.channel);
      // The latest events (by occurred_at) for this channel and consent type decide: granted
      // when one is a grant and none is a revoke (the submission core's rule).
      const { rows } = await tx.execute<{ granted: boolean }>(sql`
        WITH latest AS (
          SELECT event FROM consent_events
           WHERE contact_id = ${execution.contactId} AND org_id = ${execution.orgId}
             AND channel_id = ${channelId} AND consent_type = ${rule.consentType}
             AND occurred_at = (
               SELECT max(occurred_at) FROM consent_events
                WHERE contact_id = ${execution.contactId} AND org_id = ${execution.orgId}
                  AND channel_id = ${channelId} AND consent_type = ${rule.consentType})
        )
        SELECT (EXISTS (SELECT 1 FROM latest WHERE event = 'grant')
                AND NOT EXISTS (SELECT 1 FROM latest WHERE event = 'revoke')) AS granted`);
      return Boolean(rows[0]?.granted) === rule.granted;
    }
    case 'send_outcome': {
      // No message (the send was skipped, refused or never reached): false.
      const message = await sentMessage(tx, execution, rule.sendNodeKey);
      return message !== null && messageOutcomeReached(message, rule.outcome);
    }
  }
}

// --- send_message (8C-5b) --------------------------------------------------------------------

type SendNode = Extract<JourneyNode, { type: 'send_message' }>;
type WaitForOutcomeNode = Extract<JourneyNode, { type: 'wait_for_outcome' }>;

/** A non-`sent` port result, raised inside the port's savepoint so it rolls back. */
class PortDeclined extends Error {
  constructor(readonly result: Exclude<JourneySendResult, { kind: 'sent' }>) {
    super('journey send port declined');
  }
}

/**
 * The send node (handover Rev 2 §7.2). The identity and variables are read under the claim;
 * the port runs in its own savepoint, so a refusal leaves none of its partial writes; a sent
 * message is recorded on the step (`message_id`), where the 0066 FK, CHECK and the step <->
 * message guard prove it belongs to this execution.
 */
async function evaluateSend(
  tx: Transaction,
  node: SendNode,
  execution: ExecutionState,
  port: JourneySendPort,
  nodeKey: string,
): Promise<NodeResult> {
  const channelId = await resolveChannelId(tx, node.channel);
  const [identity] = await tx
    .select({ address: schema.contactIdentities.normalizedAddress })
    .from(schema.contactIdentities)
    .where(
      and(
        eq(schema.contactIdentities.contactId, execution.contactId),
        eq(schema.contactIdentities.orgId, execution.orgId),
        eq(schema.contactIdentities.channelId, channelId),
        eq(schema.contactIdentities.status, 'active'),
      ),
    )
    .orderBy(
      desc(schema.contactIdentities.isPrimary),
      asc(schema.contactIdentities.createdAt),
      asc(schema.contactIdentities.id),
    )
    .limit(1);
  if (!identity) return sendEdge(node, 'skipped', JOURNEY_RUNNER_ERROR_CODES.NO_IDENTITY);

  const contact = await loadContact(tx, execution);
  const variables: Record<string, string | null> = {};
  for (const [name, source] of Object.entries(node.variables))
    variables[name] = sourceValue(contact, source);

  let result: JourneySendResult;
  try {
    result = await tx.transaction(async (savepoint) => {
      const r = await port.send(savepoint, {
        orgId: execution.orgId,
        workspaceId: execution.workspaceId,
        journeyId: execution.journeyId,
        executionId: execution.id,
        contactId: execution.contactId,
        nodeKey,
        channel: node.channel,
        templateId: node.templateId,
        recipient: identity.address,
        variables,
      });
      if (r.kind !== 'sent') throw new PortDeclined(r);
      return r;
    });
  } catch (error) {
    if (!(error instanceof PortDeclined)) throw error;
    result = error.result;
  }

  switch (result.kind) {
    case 'sent':
      return {
        kind: 'advance',
        next: node.next,
        outcome: 'completed',
        details: { channel: node.channel },
        messageId: result.messageId,
      };
    case 'unavailable':
      throw new JourneyNodeFailure(
        JOURNEY_RUNNER_ERROR_CODES.SEND_UNAVAILABLE,
        'journey sending is not available',
      );
    case 'refused': {
      const code = journeySendRefusedCode(result.code);
      switch (sendRefusalDisposition(result.code)) {
        case 'skip':
          return sendEdge(node, 'skipped', code);
        case 'refuse':
          return sendEdge(node, 'refused', code);
        case 'fail':
          throw new JourneyNodeFailure(code, 'the send was refused');
        case 'transient':
          throw new JourneySendRetry(result.code);
        case 'poison':
          throw new JourneySendRetry(code);
      }
    }
  }
}

/** A skipped or refused send: the node's `onSuppressed` / `onRefused` edge. */
function sendEdge(node: SendNode, outcome: 'skipped' | 'refused', errorCode: string): NodeResult {
  const edge = outcome === 'skipped' ? node.onSuppressed : node.onRefused;
  if (edge === 'exit')
    return {
      kind: 'end',
      status: 'exited',
      endReason:
        outcome === 'skipped'
          ? JOURNEY_END_REASONS.SEND_SUPPRESSED
          : JOURNEY_END_REASONS.SEND_REFUSED,
      outcome,
      details: { channel: node.channel },
      errorCode,
    };
  return {
    kind: 'advance',
    next: node.next,
    outcome,
    details: { channel: node.channel },
    errorCode,
  };
}

/**
 * The message the execution's `sendNodeKey` step created, read through `messages_runner_select`
 * (0067: the claimed execution's messages only, outcome columns only). `null` when that step
 * recorded no message. A recorded message the runner cannot read fails closed.
 */
async function sentMessage(
  tx: Transaction,
  execution: ExecutionState,
  sendNodeKey: string,
): Promise<SentMessageState | null> {
  const [step] = await tx
    .select({ messageId: schema.journeyExecutionSteps.messageId })
    .from(schema.journeyExecutionSteps)
    .where(
      and(
        eq(schema.journeyExecutionSteps.executionId, execution.id),
        eq(schema.journeyExecutionSteps.orgId, execution.orgId),
        eq(schema.journeyExecutionSteps.nodeKey, sendNodeKey),
        isNotNull(schema.journeyExecutionSteps.messageId),
      ),
    )
    .orderBy(desc(schema.journeyExecutionSteps.seq))
    .limit(1);
  if (!step?.messageId) return null;
  const msg = schema.messages;
  const [message] = await tx
    .select({ status: msg.status, deliveryStatus: msg.deliveryStatus, readAt: msg.readAt })
    .from(msg)
    .where(and(eq(msg.id, step.messageId), eq(msg.orgId, execution.orgId)));
  if (!message)
    throw new JourneyNodeFailure(
      JOURNEY_RUNNER_ERROR_CODES.SEND_UNAVAILABLE,
      'the recorded message is not readable',
    );
  return message;
}

/**
 * `wait_for_outcome` (handover Rev 2 §6): arm a persisted deadline on the first visit; on each
 * wake take `onOutcome` once the outcome is reached, `onTimeout` at or after the deadline, and
 * otherwise re-arm silently (no history row, no transition). At most two history rows per wait.
 *
 * - No message from the send node: `onTimeout` at once.
 * - A failed message can never reach `delivered`/`read`: `onTimeout` at once (`{failed: true}`).
 * - An unknown outcome is never treated as a failure: it waits for the deadline.
 */
async function evaluateWaitForOutcome(
  tx: Transaction,
  node: WaitForOutcomeNode,
  execution: ExecutionState,
  now: Date,
): Promise<NodeResult> {
  const timeout = (details: Record<string, unknown>): NodeResult => ({
    kind: 'advance',
    next: node.onTimeout,
    outcome: 'completed',
    details: { timedOut: true, ...details },
  });
  const message = await sentMessage(tx, execution, node.sendNodeKey);
  if (!message) return timeout({ message: false });
  if (messageOutcomeReached(message, node.outcome))
    return {
      kind: 'advance',
      next: node.onOutcome,
      outcome: 'completed',
      details: { outcome: node.outcome },
    };
  if (messageOutcomeReached(message, 'failed')) return timeout({ failed: true });

  if (execution.status !== 'waiting') {
    const deadline = new Date(now.getTime() + node.timeoutSeconds * 1000);
    return {
      kind: 'wait',
      until: nextOutcomeRecheck(now, deadline, now),
      deadline,
      details: { deadline: deadline.toISOString() },
    };
  }
  const deadline = execution.waitDeadlineAt;
  if (!deadline || now.getTime() >= deadline.getTime()) return timeout({});
  const armedAt = new Date(deadline.getTime() - node.timeoutSeconds * 1000);
  return { kind: 'rearm', until: nextOutcomeRecheck(armedAt, deadline, now) };
}

// --- update_contact --------------------------------------------------------------------------

function sourceValue(contact: ContactRow, source: JourneyValueSource): string | null {
  return source.source === 'literal' ? source.value : fieldValue(contact, source.field);
}

/**
 * Applies the operations to the claimed contact, in order, under a row lock. Returns what was
 * done for history and audit: operation kinds and field names only — never values or tags.
 */
async function applyContactUpdates(
  tx: Transaction,
  operations: readonly JourneyContactUpdate[],
  execution: ExecutionState,
): Promise<Record<string, unknown>[]> {
  const contact = await loadContact(tx, execution, true);
  let firstName = contact.firstName;
  let lastName = contact.lastName;
  const metadata: Record<string, unknown> = {
    ...((contact.metadata ?? {}) as Record<string, unknown>),
  };
  let tags = contactTagsFromMetadata(metadata);
  let tagsChanged = false;
  const view = (): ContactRow => ({ ...contact, firstName, lastName, metadata });
  const done: Record<string, unknown>[] = [];

  for (const op of operations) {
    if (op.op === 'add_tag') {
      const tag = op.tag.trim();
      if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
        tags = [...tags, tag];
        tagsChanged = true;
      }
      done.push({ op: 'add_tag' });
    } else if (op.op === 'remove_tag') {
      const before = tags.length;
      tags = tags.filter((t) => t.toLowerCase() !== op.tag.trim().toLowerCase());
      tagsChanged ||= tags.length !== before;
      done.push({ op: 'remove_tag' });
    } else {
      const value = sourceValue(view(), op.value);
      if (op.field === 'firstName') firstName = value;
      else if (op.field === 'lastName') lastName = value;
      else {
        if (!JOURNEY_CUSTOM_FIELD_PATTERN.test(op.field))
          throw new JourneyNodeFailure(
            JOURNEY_RUNNER_ERROR_CODES.CONTACT_FIELD_RESERVED,
            'invalid field',
          );
        const key = op.field.slice('custom.'.length);
        if (FORBIDDEN_CUSTOM_FIELDS.has(key.toLowerCase()))
          throw new JourneyNodeFailure(
            JOURNEY_RUNNER_ERROR_CODES.CONTACT_FIELD_RESERVED,
            'the field is reserved',
          );
        if (value === null) delete metadata[key];
        else metadata[key] = value;
      }
      done.push({ op: 'set_attribute', field: op.field });
    }
  }
  if (tagsChanged) metadata.tags = tags;
  await tx
    .update(schema.contacts)
    .set({ firstName, lastName, metadata, updatedAt: sql`now()` })
    .where(and(eq(schema.contacts.id, contact.id), eq(schema.contacts.orgId, execution.orgId)));
  return done;
}
