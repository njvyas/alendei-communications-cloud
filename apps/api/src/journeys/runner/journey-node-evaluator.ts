import {
  JOURNEY_CUSTOM_FIELD_PATTERN,
  JOURNEY_END_REASONS,
  JOURNEY_NODE_CATALOGUE,
  JOURNEY_RUNNER_ERROR_CODES,
  nextJourneyWindowStart,
  type JourneyConditionRule,
  type JourneyContactUpdate,
  type JourneyNode,
  type JourneyStepOutcome,
  type JourneyValueSource,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, sql } from 'drizzle-orm';

import {
  FORBIDDEN_CUSTOM_FIELDS,
  contactTagsFromMetadata,
} from '../../contacts/audience-predicates';
import { JourneyNodeFailure } from './runner-errors';
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
 * - every send-related node fails closed: journey sends are disabled (owner decisions 1–2).
 */
export type NodeResult =
  | {
      readonly kind: 'advance';
      readonly next: string;
      readonly outcome: JourneyStepOutcome;
      readonly details: Record<string, unknown>;
      /** Set when the node wrote the contact (the runner audits it). */
      readonly contactUpdate?: { readonly operations: readonly Record<string, unknown>[] };
    }
  | {
      readonly kind: 'wait';
      readonly until: Date;
      readonly details: Record<string, unknown>;
    }
  | {
      readonly kind: 'end';
      readonly status: 'completed';
      readonly endReason: string;
      readonly outcome: JourneyStepOutcome;
      readonly details: Record<string, unknown>;
    };

export interface ExecutionState {
  readonly id: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly contactId: string;
  readonly status: 'running' | 'waiting';
  readonly wakeAt: Date | null;
}

type ContactRow = typeof schema.contacts.$inferSelect;

export async function evaluateNode(
  tx: Transaction,
  node: JourneyNode,
  execution: ExecutionState,
  now: Date,
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
    case 'wait_for_outcome':
      throw new JourneyNodeFailure(
        JOURNEY_RUNNER_ERROR_CODES.SEND_DISABLED,
        `${node.type} is not available: journey sends are disabled`,
      );
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
    case 'send_outcome':
      throw new JourneyNodeFailure(
        JOURNEY_RUNNER_ERROR_CODES.SEND_DISABLED,
        'send outcomes are not available: journey sends are disabled',
      );
  }
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
