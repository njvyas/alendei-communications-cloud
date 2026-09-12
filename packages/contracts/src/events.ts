/**
 * Domain event envelope (`EVENTS.md` §2).
 *
 * Every event published by ACC carries this envelope. Producers never publish
 * directly: a state change and its `outbox_events` row commit in the same
 * database transaction, and the relay publishes from there (`EVENTS.md` §1).
 */

export const EVENT_TOPIC_PREFIX = 'alendei';

/** Aggregate kinds that Phase 1 emits events for. */
export const AGGREGATE_TYPES = [
  'organization',
  'workspace',
  'team',
  'user',
  'user_role',
  'api_key',
  'session',
] as const;
export type AggregateType = (typeof AGGREGATE_TYPES)[number];

/**
 * Phase 1 event catalogue. `tenancy.organization_created` and
 * `tenancy.user_role_granted` are the two named in `EVENTS.md` §4c; the rest are
 * the identity-lifecycle events Phase 1's own modules produce.
 */
export const EVENT_TYPES = {
  ORGANIZATION_CREATED: 'alendei.tenancy.organization_created.v1',
  WORKSPACE_CREATED: 'alendei.tenancy.workspace_created.v1',
  TEAM_CREATED: 'alendei.tenancy.team_created.v1',
  USER_INVITED: 'alendei.iam.user_invited.v1',
  USER_ROLE_GRANTED: 'alendei.tenancy.user_role_granted.v1',
  USER_ROLE_REVOKED: 'alendei.tenancy.user_role_revoked.v1',
  API_KEY_CREATED: 'alendei.iam.api_key_created.v1',
  API_KEY_REVOKED: 'alendei.iam.api_key_revoked.v1',
  SESSION_CREATED: 'alendei.iam.session_created.v1',
  SESSION_REVOKED: 'alendei.iam.session_revoked.v1',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/**
 * `alendei.<domain>.<event_name>.v<n>` (`EVENTS.md` §2). The topic's `.v<n>`
 * suffix is the topic generation; `eventVersion` on the envelope is the payload
 * shape version and evolves independently.
 */
export function topicForEventType(eventType: string): string {
  return eventType;
}

export interface EventEnvelope<TPayload = Record<string, unknown>> {
  /** UUIDv7. Also the outbox row id, so the two are always the same identity. */
  readonly eventId: string;
  readonly eventType: string;
  /** Payload shape version, independent of the topic's `.v<n>` suffix. */
  readonly eventVersion: number;
  /** Identifier of the registry schema used to validate this payload. */
  readonly schemaVersion: string;
  readonly occurredAt: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** `org_id`. Null only for genuinely platform-level events. */
  readonly tenantId: string | null;
  readonly workspaceId: string | null;
  readonly correlationId: string;
  /** The event or request that caused this one (`EVENTS.md` §2). */
  readonly causationId: string | null;
  readonly payload: TPayload;
}

/**
 * Partition key (`EVENTS.md` §2): `tenant_id` + `aggregate_id`, so every event
 * for one entity lands on the same partition and is consumed in order.
 */
export function partitionKeyFor(tenantId: string | null, aggregateId: string): string {
  return `${tenantId ?? 'platform'}:${aggregateId}`;
}

/** Consumer groups registered in Phase 1. */
export const CONSUMER_GROUPS = {
  AUDIT_PROJECTOR: 'audit-projector',
} as const;

export type ConsumerGroup = (typeof CONSUMER_GROUPS)[keyof typeof CONSUMER_GROUPS];
