import {
  ACTOR_TYPES,
  AUDIT_OUTCOMES,
  CHANNEL_CODES,
  CHANNEL_STATUSES,
  MESSAGE_ATTEMPT_STATUSES,
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_STATUSES,
  PROVIDER_CIRCUIT_POLICY_BOUNDS,
  PROVIDER_CIRCUIT_STATES,
  PROVIDER_HEALTH_CLASSIFICATIONS,
  PROVIDER_HEALTH_SAMPLE_KINDS,
  PROVIDER_HEALTH_SOURCES,
  PROVIDER_PROBE_OUTCOMES,
  PROVIDER_SUBMISSION_SAMPLE_OUTCOMES,
  PROVIDER_FAILURE_CATEGORIES,
  PROVIDER_HEALTH_STATES,
  PROVIDER_STATUSES,
  SCOPE_TYPES,
  SIMULATOR_BEHAVIORS,
  SIMULATOR_HEALTH_BEHAVIORS,
  SUPPRESSION_STATUSES,
  DOMAIN_TYPES,
  DOMAIN_STATUSES,
  DOMAIN_VERIFICATION_METHODS,
  DOMAIN_VERIFICATION_STATUSES,
  PRICING_RATE_MAX_E4,
  PRICING_UNITS,
  PRICING_VERSION_STATUSES,
  JOURNEY_ENROLMENT_OUTCOMES,
  JOURNEY_EXECUTION_STATUSES,
  JOURNEY_GRAPH_ISSUE_CODES,
  JOURNEY_STATUSES,
  JOURNEY_STEP_OUTCOMES,
  JOURNEY_TRIGGER_KINDS,
  JOURNEY_TRIGGER_STATUSES,
  JOURNEY_VERSION_STATUSES,
} from '@acc/contracts';
import { ApiProperty, ApiSchema } from '@nestjs/swagger';

import { API_KEY_SCOPE_TYPES, API_KEY_STATUSES } from '../api-keys/api-key.dto';
import {
  BILLING_MODES,
  BILLING_POLICIES,
  ORGANIZATION_STATUSES,
} from '../organizations/organization.dto';
import { USER_STATUSES } from '../users/user.dto';
import { SCOPE_STATUSES } from '../workspaces/workspace.dto';

/**
 * Documentation-only response schemas (Phase 1C.3 ADR, G5). Each mirrors a
 * view the runtime already returns — the service interfaces
 * (`OrganizationView`, `WorkspaceView`, …) and the inline controller bodies —
 * because interfaces cannot be reflected. None is instantiated, and none
 * changes a response; the contract suites validate real responses against
 * them, so a drift in either direction fails.
 */

const uuid = { type: 'string', format: 'uuid' } as const;
const nullableUuid = { type: 'string', format: 'uuid', nullable: true } as const;
const timestamp = { type: 'string', format: 'date-time' } as const;
const nullableTimestamp = { type: 'string', format: 'date-time', nullable: true } as const;
const nullableString = { type: 'string', nullable: true } as const;
/**
 * Any JSON value (a provider capability's value is free-form, non-secret JSON).
 * OpenAPI 3.0 has no `null` type and forbids `nullable` beside `anyOf` without
 * a `type`, so `null` is admitted through the object member.
 */
export const ANY_JSON = {
  description: 'Any JSON value',
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'object', additionalProperties: true, nullable: true },
    { type: 'array', items: {} },
  ],
};

// --- tenancy -----------------------------------------------------------------

@ApiSchema({ name: 'Organization' })
export class OrganizationSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty(nullableString) legalName!: string | null;
  @ApiProperty(nullableString) gstin!: string | null;
  @ApiProperty(nullableUuid) resellerId!: string | null;
  @ApiProperty({ enum: ORGANIZATION_STATUSES }) status!: string;
  @ApiProperty(nullableTimestamp) statusChangedAt!: string | null;
  @ApiProperty({ enum: BILLING_MODES }) billingMode!: string;
  @ApiProperty({ enum: BILLING_POLICIES }) billingPolicy!: string;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(timestamp) updatedAt!: string;
}

@ApiSchema({ name: 'Workspace' })
export class WorkspaceSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: SCOPE_STATUSES }) status!: string;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(timestamp) updatedAt!: string;
}

@ApiSchema({ name: 'Team' })
export class TeamSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty(uuid) workspaceId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: SCOPE_STATUSES }) status!: string;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(timestamp) updatedAt!: string;
}

/** `GET /tenants/workspaces` item — the deprecated alias's own, narrower shape. */
@ApiSchema({ name: 'LegacyWorkspaceListItem' })
export class LegacyWorkspaceListItemSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: SCOPE_STATUSES }) status!: string;
  @ApiProperty(timestamp) createdAt!: string;
}

/** `GET /tenants/workspaces/:id` — no timestamps. */
@ApiSchema({ name: 'LegacyWorkspace' })
export class LegacyWorkspaceSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: SCOPE_STATUSES }) status!: string;
}

// --- RBAC ----------------------------------------------------------------------

@ApiSchema({ name: 'Role' })
export class RoleSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty() key!: string;
  @ApiProperty() name!: string;
  @ApiProperty(nullableString) description!: string | null;
  @ApiProperty(nullableUuid) orgId!: string | null;
  @ApiProperty() isSystemRole!: boolean;
  @ApiProperty({ enum: SCOPE_TYPES, isArray: true }) allowedScopeTypes!: string[];
  @ApiProperty({ type: String, isArray: true }) permissions!: string[];
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(timestamp) updatedAt!: string;
}

@ApiSchema({ name: 'Permission' })
export class PermissionSchema {
  @ApiProperty() key!: string;
  @ApiProperty() domain!: string;
  @ApiProperty() action!: string;
  @ApiProperty(nullableString) description!: string | null;
}

@ApiSchema({ name: 'RoleAssignment' })
export class RoleAssignmentSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) userId!: string;
  @ApiProperty(uuid) roleId!: string;
  @ApiProperty() roleKey!: string;
  @ApiProperty(nullableUuid) orgId!: string | null;
  @ApiProperty({ enum: SCOPE_TYPES }) scopeType!: string;
  @ApiProperty(nullableUuid) scopeId!: string | null;
  @ApiProperty(nullableUuid) grantedBy!: string | null;
  @ApiProperty(timestamp) createdAt!: string;
}

// --- users and sessions ----------------------------------------------------------

@ApiSchema({ name: 'User' })
export class UserSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty(nullableString) phone!: string | null;
  @ApiProperty({ enum: USER_STATUSES }) status!: string;
  @ApiProperty(nullableTimestamp) lastLoginAt!: string | null;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(timestamp) updatedAt!: string;
}

/** A live session, as listed to its owner or to an administrator. */
@ApiSchema({ name: 'Session' })
export class SessionSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(nullableTimestamp) lastUsedAt!: string | null;
  @ApiProperty(timestamp) expiresAt!: string;
  @ApiProperty(nullableString) ip!: string | null;
  @ApiProperty(nullableString) userAgent!: string | null;
  @ApiProperty({ description: 'True for the session making this request.' }) current!: boolean;
}

@ApiSchema({ name: 'RevokedCount' })
export class RevokedCountSchema {
  @ApiProperty({ minimum: 0, description: 'The number of live sessions revoked.' })
  revoked!: number;
}

// --- authentication ------------------------------------------------------------------

@ApiSchema({ name: 'AccessToken' })
export class AccessTokenSchema {
  @ApiProperty() accessToken!: string;
  @ApiProperty({ enum: ['Bearer'] }) tokenType!: string;
  @ApiProperty({ description: 'Access-token lifetime in seconds.' }) expiresIn!: number;
}

@ApiSchema({ name: 'TenantContext' })
export class TenantContextSchema {
  @ApiProperty(nullableUuid) orgId!: string | null;
  @ApiProperty(nullableUuid) workspaceId!: string | null;
  @ApiProperty(nullableUuid) resellerId!: string | null;
  @ApiProperty() isPlatformAdmin!: boolean;
}

@ApiSchema({ name: 'PrincipalRole' })
export class PrincipalRoleSchema {
  @ApiProperty() roleKey!: string;
  @ApiProperty({ enum: SCOPE_TYPES }) scopeType!: string;
  @ApiProperty(nullableUuid) scopeId!: string | null;
  @ApiProperty(nullableUuid) orgId!: string | null;
}

@ApiSchema({ name: 'Principal' })
export class PrincipalSchema {
  @ApiProperty({ enum: ACTOR_TYPES }) actorType!: string;
  @ApiProperty({ enum: ['session', 'api_key'] }) authMethod!: string;
  @ApiProperty(nullableUuid) userId!: string | null;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: "The signed-in user's own email; null for an API-key principal.",
  })
  email!: string | null;
  @ApiProperty(nullableUuid) apiKeyId!: string | null;
  @ApiProperty(nullableUuid) sessionId!: string | null;
  @ApiProperty(timestamp) authenticatedAt!: string;
  @ApiProperty({ type: TenantContextSchema }) tenant!: TenantContextSchema;
  @ApiProperty({ type: 'array', items: uuid }) authorizedOrganizationIds!: string[];
  @ApiProperty({ type: PrincipalRoleSchema, isArray: true }) roles!: PrincipalRoleSchema[];
  @ApiProperty({ type: String, isArray: true }) permissions!: string[];
}

@ApiSchema({ name: 'Grant' })
export class GrantSchema {
  @ApiProperty({
    description:
      'The role id — for an API key, the synthetic `api_key:<key id>` of its effective grant.',
  })
  roleId!: string;
  @ApiProperty() roleKey!: string;
  @ApiProperty({ enum: SCOPE_TYPES }) scopeType!: string;
  @ApiProperty(nullableUuid) scopeId!: string | null;
  @ApiProperty(nullableUuid) orgId!: string | null;
  @ApiProperty({ type: String, isArray: true, description: 'Sorted.' }) permissions!: string[];
}

@ApiSchema({ name: 'EffectiveAuthorization' })
export class EffectiveAuthorizationSchema {
  @ApiProperty({ enum: ACTOR_TYPES }) actorType!: string;
  @ApiProperty(nullableUuid) userId!: string | null;
  @ApiProperty(nullableUuid) apiKeyId!: string | null;
  @ApiProperty({ type: GrantSchema, isArray: true }) grants!: GrantSchema[];
  @ApiProperty({ type: 'array', items: uuid }) organizationIds!: string[];
  @ApiProperty() isPlatformAdmin!: boolean;
}

@ApiSchema({ name: 'WsTicket' })
export class WsTicketSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ description: 'The single-use ticket; shown once.' }) ticket!: string;
  @ApiProperty(timestamp) expiresAt!: string;
  @ApiProperty({ type: String, isArray: true }) scope!: string[];
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty(nullableUuid) workspaceId!: string | null;
}

// --- API keys and audit ----------------------------------------------------------------

@ApiSchema({ name: 'ApiKey' })
export class ApiKeySchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'The public prefix, `ak_(live|test)_…`.' }) prefix!: string;
  @ApiProperty({ enum: API_KEY_STATUSES }) status!: string;
  @ApiProperty({ enum: API_KEY_SCOPE_TYPES }) scopeType!: string;
  @ApiProperty(uuid) scopeId!: string;
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty({ type: String, isArray: true }) scopes!: string[];
  @ApiProperty(nullableTimestamp) expiresAt!: string | null;
  @ApiProperty(nullableTimestamp) lastUsedAt!: string | null;
  @ApiProperty(nullableTimestamp) revokedAt!: string | null;
  @ApiProperty(nullableString) revokedReason!: string | null;
  @ApiProperty(nullableUuid) createdBy!: string | null;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(timestamp) updatedAt!: string;
}

@ApiSchema({ name: 'CreatedApiKey' })
export class CreatedApiKeySchema extends ApiKeySchema {
  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'The secret half of the credential — returned once, on the creating response only; the credential is `<prefix>.<secret>`. An idempotent replay returns `null`.',
  })
  secret!: string | null;
}

@ApiSchema({ name: 'AuditLog' })
export class AuditLogSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(timestamp) occurredAt!: string;
  @ApiProperty() action!: string;
  @ApiProperty({ enum: AUDIT_OUTCOMES }) outcome!: string;
  @ApiProperty({ enum: ACTOR_TYPES }) actorType!: string;
  @ApiProperty(nullableUuid) actorUserId!: string | null;
  @ApiProperty(nullableUuid) actorApiKeyId!: string | null;
  @ApiProperty(nullableString) actorLabel!: string | null;
  @ApiProperty() resourceType!: string;
  @ApiProperty(nullableString) resourceId!: string | null;
  @ApiProperty({ enum: SCOPE_TYPES }) scopeType!: string;
  @ApiProperty(nullableUuid) scopeId!: string | null;
  @ApiProperty(nullableUuid) resellerId!: string | null;
  @ApiProperty(nullableUuid) orgId!: string | null;
  @ApiProperty(nullableUuid) workspaceId!: string | null;
  @ApiProperty(nullableUuid) teamId!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  before!: Record<string, unknown> | null;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  after!: Record<string, unknown> | null;
  @ApiProperty({ type: 'object', additionalProperties: true })
  metadata!: Record<string, unknown>;
  @ApiProperty(uuid) correlationId!: string;
  @ApiProperty(nullableUuid) causationId!: string | null;
  @ApiProperty(nullableString) ip!: string | null;
  @ApiProperty(nullableString) userAgent!: string | null;
}

// --- health ------------------------------------------------------------------------------

@ApiSchema({ name: 'Liveness' })
export class LivenessSchema {
  @ApiProperty({ enum: ['ok'] }) status!: string;
  @ApiProperty() service!: string;
}

/** Every response schema, registered so an unused one still appears (and is checked). */
export const RESPONSE_SCHEMAS = [
  OrganizationSchema,
  WorkspaceSchema,
  TeamSchema,
  LegacyWorkspaceListItemSchema,
  LegacyWorkspaceSchema,
  RoleSchema,
  PermissionSchema,
  RoleAssignmentSchema,
  UserSchema,
  SessionSchema,
  RevokedCountSchema,
  AccessTokenSchema,
  TenantContextSchema,
  PrincipalRoleSchema,
  PrincipalSchema,
  GrantSchema,
  EffectiveAuthorizationSchema,
  WsTicketSchema,
  ApiKeySchema,
  CreatedApiKeySchema,
  AuditLogSchema,
  LivenessSchema,
] as const;

// --- provider catalogue (Phase 2.1, ADR-013) ------------------------------------

@ApiSchema({ name: 'Channel' })
export class ChannelSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ enum: CHANNEL_CODES }) code!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ enum: CHANNEL_STATUSES }) status!: string;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(timestamp) updatedAt!: string;
}

@ApiSchema({ name: 'Provider' })
export class ProviderSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) channelId!: string;
  @ApiProperty({ enum: CHANNEL_CODES }) channelCode!: string;
  @ApiProperty() name!: string;
  @ApiProperty() adapterKey!: string;
  @ApiProperty({ enum: PROVIDER_STATUSES }) status!: string;
  @ApiProperty({
    enum: PROVIDER_HEALTH_STATES,
    description: 'Derived from samples, or the manual override when set (Phase 2.3)',
  })
  healthState!: string;
  @ApiProperty({
    // OpenAPI 3.0: a nullable enum must list null among its values.
    enum: [...PROVIDER_HEALTH_STATES, null],
    nullable: true,
    description: 'The manual health pin; null when health is derived automatically',
  })
  healthOverride!: string | null;
  @ApiProperty(nullableTimestamp) healthChangedAt!: string | null;
  @ApiProperty({
    enum: PROVIDER_CIRCUIT_STATES,
    description: 'Moved only by the circuit breaker (Phase 2.3)',
  })
  circuitState!: string;
  @ApiProperty(nullableTimestamp) circuitChangedAt!: string | null;
  @ApiProperty({
    ...nullableTimestamp,
    description: "When an open circuit's cooldown ends; null in any other state",
  })
  circuitCooldownUntil!: string | null;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(timestamp) updatedAt!: string;
}

@ApiSchema({ name: 'ProviderCapability' })
export class ProviderCapabilitySchema {
  @ApiProperty() key!: string;
  @ApiProperty(ANY_JSON) value!: unknown;
}

@ApiSchema({ name: 'ProviderDetail' })
export class ProviderDetailSchema extends ProviderSchema {
  @ApiProperty({ type: [ProviderCapabilitySchema] }) capabilities!: ProviderCapabilitySchema[];
}

/**
 * The normalized adapter failure, or `null` when the provider accepted. Inline
 * rather than a `$ref`: OpenAPI 3.0 cannot make a `$ref` nullable (`nullable`
 * beside `allOf` does not admit `null`), and the contract suite validates the
 * accepted answer's `null` against this.
 */
const PROVIDER_FAILURE = {
  type: 'object',
  nullable: true,
  required: ['category', 'retryable', 'providerCode', 'message'],
  properties: {
    category: { type: 'string', enum: [...PROVIDER_FAILURE_CATEGORIES] },
    retryable: { type: 'boolean' },
    providerCode: { type: 'string', nullable: true },
    message: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const nullableDateTime = { type: 'string', format: 'date-time', nullable: true } as const;

/** Phase 5.0 PR-C: a provider's webhook ingress state. Never carries a key or a hash. */
@ApiSchema({ name: 'ProviderWebhookIngress' })
export class ProviderWebhookIngressSchema {
  @ApiProperty(uuid) providerId!: string;
  @ApiProperty({
    description: 'Whether this provider accepts delivery receipts (OD-12 kill switch)',
  })
  enabled!: boolean;
  @ApiProperty({ description: 'Whether an ingress key exists (only its hash is stored)' })
  keyConfigured!: boolean;
  @ApiProperty(nullableDateTime) keyRotatedAt!: string | null;
  @ApiProperty({
    ...nullableDateTime,
    description: 'While in the future, the previous key is still accepted (rotation grace)',
  })
  previousKeyValidUntil!: string | null;
}

/** Phase 5.0 PR-C: the one response that carries a plaintext ingress key — shown once. */
@ApiSchema({ name: 'ProviderSimulatorDeliveryRequestOutcome' })
export class ProviderSimulatorDeliveryRequestOutcomeSchema {
  @ApiProperty({ type: 'integer', minimum: 0 }) index!: number;
  @ApiProperty({ type: 'integer', minimum: 0, description: 'Receipt elements in this request.' })
  elements!: number;
  @ApiProperty({ type: 'integer', description: 'The HTTP status the ingress answered.' })
  status!: number;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    nullable: true,
    description: 'Elements received (200 only).',
  })
  received!: number | null;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'The ingress error code (non-200 only).',
  })
  errorCode!: string | null;
}

@ApiSchema({ name: 'ProviderSimulatorDeliveryEvents' })
export class ProviderSimulatorDeliveryEventsSchema {
  @ApiProperty(uuid) providerId!: string;
  @ApiProperty(uuid) attemptId!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'The simulator_delivery scenario used.',
  })
  scenario!: Record<string, unknown>;
  @ApiProperty({ type: 'integer', minimum: 0 }) elementCount!: number;
  @ApiProperty({ type: ProviderSimulatorDeliveryRequestOutcomeSchema, isArray: true })
  requests!: ProviderSimulatorDeliveryRequestOutcomeSchema[];
}

@ApiSchema({ name: 'ProviderWebhookIngressKey' })
export class ProviderWebhookIngressKeySchema extends ProviderWebhookIngressSchema {
  @ApiProperty({
    description:
      'The ingress key, shown only in this response and never stored (only its peppered hash is). Treat as a secret.',
  })
  key!: string;
  @ApiProperty({ description: 'The ingress route; replace :providerKey with the key' })
  ingressPathTemplate!: string;
}

@ApiSchema({ name: 'ProviderTestSendResult' })
export class ProviderTestSendResultSchema {
  @ApiProperty(uuid) providerId!: string;
  @ApiProperty() adapterKey!: string;
  @ApiProperty({ enum: CHANNEL_CODES }) channelCode!: string;
  @ApiProperty({ enum: SIMULATOR_BEHAVIORS }) behavior!: string;
  @ApiProperty(uuid) submissionId!: string;
  @ApiProperty(uuid) correlationId!: string;
  @ApiProperty({ enum: ['accepted', 'rejected'] }) outcome!: string;
  @ApiProperty(nullableString) providerMessageId!: string | null;
  @ApiProperty(PROVIDER_FAILURE as never) failure!: Record<string, unknown> | null;
  @ApiProperty({ type: 'integer' }) latencyMs!: number;
  @ApiProperty({ description: "Whether this submission was the circuit's half-open probe" })
  circuitProbe!: boolean;
  @ApiProperty({ enum: PROVIDER_HEALTH_STATES }) healthState!: string;
  @ApiProperty({ enum: PROVIDER_CIRCUIT_STATES }) circuitState!: string;
}

// --- provider health and circuit breaker (Phase 2.3) ------------------------------

@ApiSchema({ name: 'ProviderHealthCheckResult' })
export class ProviderHealthCheckResultSchema {
  @ApiProperty(uuid) providerId!: string;
  @ApiProperty() adapterKey!: string;
  @ApiProperty({ enum: CHANNEL_CODES }) channelCode!: string;
  @ApiProperty({ enum: SIMULATOR_HEALTH_BEHAVIORS }) behavior!: string;
  @ApiProperty({ enum: PROVIDER_PROBE_OUTCOMES }) outcome!: string;
  @ApiProperty({ type: 'integer' }) latencyMs!: number;
  @ApiProperty(uuid) correlationId!: string;
  @ApiProperty({ enum: PROVIDER_HEALTH_STATES }) healthState!: string;
  @ApiProperty({ enum: PROVIDER_CIRCUIT_STATES }) circuitState!: string;
}

@ApiSchema({ name: 'ProviderHealthSample' })
export class ProviderHealthSampleSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) providerId!: string;
  @ApiProperty({ enum: PROVIDER_HEALTH_SAMPLE_KINDS }) kind!: string;
  @ApiProperty({
    enum: [
      ...new Set([...PROVIDER_SUBMISSION_SAMPLE_OUTCOMES, ...PROVIDER_PROBE_OUTCOMES, 'manual']),
    ],
  })
  outcome!: string;
  @ApiProperty({ enum: PROVIDER_HEALTH_CLASSIFICATIONS }) classification!: string;
  @ApiProperty({ type: 'integer', nullable: true }) latencyMs!: number | null;
  @ApiProperty({ enum: PROVIDER_HEALTH_STATES }) healthState!: string;
  @ApiProperty({ enum: PROVIDER_CIRCUIT_STATES }) circuitState!: string;
  @ApiProperty({ type: 'integer' }) circuitGeneration!: number;
  @ApiProperty({ enum: PROVIDER_HEALTH_SOURCES }) source!: string;
  @ApiProperty(timestamp) observedAt!: string;
  @ApiProperty(timestamp) createdAt!: string;
}

// --- the circuit policy (Gate D.3 remediation) -------------------------------------

const bounded = (field: keyof typeof PROVIDER_CIRCUIT_POLICY_BOUNDS) => ({
  type: 'integer' as const,
  minimum: PROVIDER_CIRCUIT_POLICY_BOUNDS[field].min,
  maximum: PROVIDER_CIRCUIT_POLICY_BOUNDS[field].max,
});

@ApiSchema({ name: 'CircuitPolicy' })
export class CircuitPolicySchema {
  @ApiProperty(bounded('windowMs')) windowMs!: number;
  @ApiProperty(bounded('windowMaxSamples')) windowMaxSamples!: number;
  @ApiProperty(bounded('minSamples')) minSamples!: number;
  @ApiProperty(bounded('failurePercent')) failurePercent!: number;
  @ApiProperty(bounded('cooldownMs')) cooldownMs!: number;
  @ApiProperty(bounded('halfOpenMaxProbes')) halfOpenMaxProbes!: number;
  @ApiProperty(bounded('probeLeaseMs')) probeLeaseMs!: number;
  @ApiProperty(bounded('halfOpenSuccessesToClose')) halfOpenSuccessesToClose!: number;
  @ApiProperty({ type: 'integer', minimum: 1 }) version!: number;
  @ApiProperty(timestamp) updatedAt!: string;
}

// --- organization provider assignments (Phase 3.2, ADR-014 §4) ------------------

@ApiSchema({ name: 'OrganizationProviderAssignment' })
export class OrganizationProviderAssignmentSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty(uuid) providerId!: string;
  @ApiProperty(uuid) channelId!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) priority!: number;
  @ApiProperty({ enum: ['active', 'disabled'] }) status!: string;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(timestamp) updatedAt!: string;
}

// --- suppressions (Phase 3.1, ADR-014 §6) ----------------------------------------

@ApiSchema({ name: 'Suppression' })
export class SuppressionSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty({ ...nullableUuid, description: 'Null: suppressed on every channel.' })
  channelId!: string | null;
  @ApiProperty() rawAddress!: string;
  @ApiProperty() normalizedAddress!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: SUPPRESSION_STATUSES }) status!: string;
  @ApiProperty(nullableTimestamp) clearedAt!: string | null;
  @ApiProperty(nullableString) clearedReason!: string | null;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(timestamp) updatedAt!: string;
}

// --- messages (Phase 3.3, ADR-014 §9) --------------------------------------------

@ApiSchema({ name: 'QueuedMessage' })
export class QueuedMessageSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ enum: ['queued'] }) status!: string;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty() correlationId!: string;
}

/**
 * Phase 5.0 delivery-axis fields (Option B), shared by messages and attempts. Optional in
 * the schema (AC-API-1: additive), but always present in this API version's responses:
 * `null` delivery status means not tracked; the submission `status` is independent.
 */
const deliveryStatusProperty = {
  required: false,
  // OpenAPI 3.0: a nullable enum must list null among its values.
  enum: [...MESSAGE_DELIVERY_STATUSES, null],
  nullable: true,
  description:
    'Delivery outcome, independent of `status`. null = not tracked (the record predates delivery tracking, or never reached a provider). not_supported = the provider or channel reports no delivery receipts.',
} as const;
const deliveredAtProperty = {
  required: false,
  type: 'string',
  format: 'date-time',
  nullable: true,
  description: 'Earliest positive-delivery time; null when not delivered.',
} as const;
const readAtProperty = {
  required: false,
  type: 'string',
  format: 'date-time',
  nullable: true,
  description: 'Earliest read time reported by the provider; null when not read or not reported.',
} as const;

@ApiSchema({ name: 'MessageSummary' })
export class MessageSummarySchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty(uuid) workspaceId!: string;
  @ApiProperty(uuid) contactId!: string;
  @ApiProperty(uuid) channelId!: string;
  @ApiProperty({ enum: CHANNEL_CODES }) channelCode!: string;
  @ApiProperty(nullableUuid) templateId!: string | null;
  @ApiProperty({ enum: MESSAGE_STATUSES }) status!: string;
  @ApiProperty({
    description:
      'Permanently masked recipient address (phone number or email). Never returns full unmasked numbers.',
    example: '+1 •••• 0199',
  })
  recipientAddress!: string;
  @ApiProperty(nullableString) failureReason!: string | null;
  @ApiProperty({ type: 'integer', minimum: 0 }) attemptCount!: number;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(nullableTimestamp) completedAt!: string | null;
  @ApiProperty(deliveryStatusProperty) deliveryStatus?: string | null;
  @ApiProperty(deliveredAtProperty) deliveredAt?: string | null;
  @ApiProperty(readAtProperty) readAt?: string | null;
}

@ApiSchema({ name: 'MessageAttempt' })
export class MessageAttemptSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) attemptNumber!: number;
  @ApiProperty(uuid) providerId!: string;
  @ApiProperty({ enum: MESSAGE_ATTEMPT_STATUSES }) status!: string;
  @ApiProperty(nullableString) failureReason!: string | null;
  @ApiProperty({ type: 'integer', minimum: 0, nullable: true }) latencyMs!: number | null;
  @ApiProperty(nullableTimestamp) completedAt!: string | null;
  @ApiProperty(deliveryStatusProperty) deliveryStatus?: string | null;
  @ApiProperty(deliveredAtProperty) deliveredAt?: string | null;
  @ApiProperty(readAtProperty) readAt?: string | null;
}

@ApiSchema({ name: 'MessageDetail' })
export class MessageDetailSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty(uuid) workspaceId!: string;
  @ApiProperty(uuid) contactId!: string;
  @ApiProperty(uuid) channelId!: string;
  @ApiProperty(nullableUuid) templateId!: string | null;
  @ApiProperty({ enum: MESSAGE_STATUSES }) status!: string;
  @ApiProperty({
    description:
      'Permanently masked recipient address (phone number or email). Never returns full unmasked numbers.',
    example: '+1 •••• 0199',
  })
  recipientAddress!: string;
  @ApiProperty({ type: 'object', additionalProperties: true })
  payload!: Record<string, unknown>;
  @ApiProperty(nullableString) failureReason!: string | null;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(nullableTimestamp) completedAt!: string | null;
  @ApiProperty(deliveryStatusProperty) deliveryStatus?: string | null;
  @ApiProperty(deliveredAtProperty) deliveredAt?: string | null;
  @ApiProperty(readAtProperty) readAt?: string | null;
  @ApiProperty({
    type: MessageAttemptSchema,
    isArray: true,
    description: 'Dispatch attempts, ordered by `attemptNumber`; empty until the first attempt.',
  })
  attempts!: MessageAttemptSchema[];
}

const count = { type: 'integer', minimum: 0 } as const;

@ApiSchema({ name: 'MessageUsageCounts' })
export class MessageUsageCountsSchema {
  @ApiProperty(count) total!: number;
  @ApiProperty({ ...count, description: 'A provider accepted the submission.' }) accepted!: number;
  @ApiProperty(count) failed!: number;
  @ApiProperty(count) outcomeUnknown!: number;
  @ApiProperty({ ...count, description: 'Not yet settled.' }) pending!: number;
}

@ApiSchema({ name: 'MessageUsageChannelRow' })
export class MessageUsageChannelRowSchema extends MessageUsageCountsSchema {
  @ApiProperty({ enum: CHANNEL_CODES }) channelCode!: string;
}

@ApiSchema({ name: 'MessageUsageDayRow' })
export class MessageUsageDayRowSchema extends MessageUsageChannelRowSchema {
  @ApiProperty({
    type: 'string',
    format: 'date',
    description: 'Calendar day in the report time zone. Days with no messages are omitted.',
  })
  day!: string;
}

@ApiSchema({ name: 'MessageUsageFailureReason' })
export class MessageUsageFailureReasonSchema {
  @ApiProperty({
    type: 'string',
    description: 'The leading upper-case reason code, or OTHER for free text.',
    example: 'NO_ELIGIBLE_PROVIDER',
  })
  reason!: string;
  @ApiProperty(count) count!: number;
}

@ApiSchema({ name: 'MessageUsageDelivery' })
export class MessageUsageDeliverySchema {
  @ApiProperty({ ...count, description: 'Positive delivery evidence.' }) delivered!: number;
  @ApiProperty({ ...count, description: 'Final non-delivery reported by the provider.' })
  undelivered!: number;
  @ApiProperty({ ...count, description: 'Awaiting a delivery receipt.' }) pending!: number;
  @ApiProperty({ ...count, description: 'The provider or channel reports no delivery receipts.' })
  notSupported!: number;
  @ApiProperty({
    ...count,
    description:
      'No delivery status: the message predates delivery tracking or never reached a provider.',
  })
  notTracked!: number;
  @ApiProperty({
    type: 'number',
    minimum: 0,
    maximum: 1,
    nullable: true,
    description:
      'delivered / (delivered + undelivered); null when no message has a final delivery outcome.',
  })
  deliveryRate!: number | null;
}

@ApiSchema({ name: 'MessageUsageReport' })
export class MessageUsageReportSchema {
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty(timestamp) from!: string;
  @ApiProperty(timestamp) to!: string;
  @ApiProperty({ type: 'string', example: 'Asia/Kolkata' }) timeZone!: string;
  @ApiProperty(nullableUuid) workspaceId!: string | null;
  @ApiProperty({
    // OpenAPI 3.0: a nullable enum must list null among its values.
    enum: [...CHANNEL_CODES, null],
    nullable: true,
  })
  channelCode!: string | null;
  @ApiProperty({ type: MessageUsageCountsSchema }) totals!: MessageUsageCountsSchema;
  @ApiProperty({
    type: 'number',
    minimum: 0,
    maximum: 1,
    nullable: true,
    description: 'accepted / (accepted + failed + outcomeUnknown); null when nothing has settled.',
  })
  acceptanceRate!: number | null;
  @ApiProperty({ type: MessageUsageChannelRowSchema, isArray: true })
  byChannel!: MessageUsageChannelRowSchema[];
  @ApiProperty({ type: MessageUsageDayRowSchema, isArray: true })
  byDay!: MessageUsageDayRowSchema[];
  @ApiProperty({ type: MessageUsageFailureReasonSchema, isArray: true })
  topFailureReasons!: MessageUsageFailureReasonSchema[];
  @ApiProperty({
    type: MessageUsageDeliverySchema,
    required: false,
    description:
      'Totals on the delivery axis (additive; always present in this API version). The five counts sum to totals.total; every submission field above is unchanged.',
  })
  delivery?: MessageUsageDeliverySchema;
}

// --- domains, branding & onboarding (Phase 4, U12) --------------------------

@ApiSchema({ name: 'BrandConfig' })
export class BrandConfigSchema {
  @ApiProperty({ nullable: true, required: false }) brandName?: string;
  @ApiProperty({ nullable: true, required: false }) logoUrl?: string;
  @ApiProperty({ nullable: true, required: false }) faviconUrl?: string;
  @ApiProperty({ nullable: true, required: false }) primaryColor?: string;
  @ApiProperty({ nullable: true, required: false }) accentColor?: string;
  @ApiProperty({ nullable: true, required: false }) supportEmail?: string;
  @ApiProperty({ nullable: true, required: false }) supportPhone?: string;
  @ApiProperty({ nullable: true, required: false }) customCss?: string;
  @ApiProperty({ nullable: true, required: false }) privacyPolicyUrl?: string;
  @ApiProperty({ nullable: true, required: false }) termsOfServiceUrl?: string;
}

@ApiSchema({ name: 'ResolvedDomainOrganization' })
export class ResolvedDomainOrganizationSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty() status!: string;
  @ApiProperty(nullableUuid) resellerId!: string | null;
}

@ApiSchema({ name: 'ResolvedDomain' })
export class ResolvedDomainSchema {
  @ApiProperty() matched!: boolean;
  @ApiProperty() domain!: string;
  @ApiProperty({ enum: ['platform', 'subdomain', 'custom', 'unrecognized'] }) domainType!: string;
  @ApiProperty({ enum: ['admin', 'console', 'customer', 'reseller', 'default'] })
  portalType!: string;
  @ApiProperty({ type: ResolvedDomainOrganizationSchema, nullable: true })
  organization!: ResolvedDomainOrganizationSchema | null;
  @ApiProperty({ type: BrandConfigSchema }) branding!: BrandConfigSchema;
}

@ApiSchema({ name: 'DomainDnsRecord' })
export class DomainDnsRecordSchema {
  @ApiProperty({ enum: ['TXT', 'CNAME'] }) type!: string;
  @ApiProperty() name!: string;
  @ApiProperty() value!: string;
  @ApiProperty({ type: 'integer' }) ttl!: number;
}

@ApiSchema({ name: 'DomainVerificationDetails' })
export class DomainVerificationDetailsSchema {
  @ApiProperty(uuid) domainId!: string;
  @ApiProperty() domain!: string;
  @ApiProperty({ enum: DOMAIN_VERIFICATION_METHODS }) method!: string;
  @ApiProperty({ enum: DOMAIN_VERIFICATION_STATUSES }) status!: string;
  @ApiProperty({ type: DomainDnsRecordSchema }) record!: DomainDnsRecordSchema;
  @ApiProperty() instructions!: string;
}

@ApiSchema({ name: 'DomainView' })
export class DomainViewSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty() domain!: string;
  @ApiProperty({ enum: DOMAIN_TYPES }) domainType!: string;
  @ApiProperty({ enum: DOMAIN_STATUSES }) status!: string;
  @ApiProperty({ enum: DOMAIN_VERIFICATION_METHODS }) verificationMethod!: string;
  @ApiProperty() verificationValue!: string;
  @ApiProperty({ enum: DOMAIN_VERIFICATION_STATUSES }) verificationStatus!: string;
  @ApiProperty(nullableTimestamp) verifiedAt!: string | null;
  @ApiProperty() isPrimary!: boolean;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(timestamp) updatedAt!: string;
}

@ApiSchema({ name: 'OnboardingResult' })
export class OnboardingResultSchema {
  @ApiProperty(uuid) organizationId!: string;
  @ApiProperty() organizationSlug!: string;
  @ApiProperty() organizationName!: string;
  @ApiProperty(uuid) defaultWorkspaceId!: string;
  @ApiProperty(uuid) adminUserId!: string;
  @ApiProperty({ type: DomainViewSchema }) domain!: DomainViewSchema;
  @ApiProperty({ type: BrandConfigSchema }) branding!: BrandConfigSchema;
  @ApiProperty() portalUrl!: string;
}

// --- organization lifecycle history (Phase 4, U13.2) -----------------------

@ApiSchema({ name: 'OrganizationLifecycleActor' })
export class OrganizationLifecycleActorSchema {
  @ApiProperty() type!: string;
  @ApiProperty({ type: 'string', nullable: true }) id!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) email!: string | null;
}

@ApiSchema({ name: 'OrganizationLifecycleEvent' })
export class OrganizationLifecycleEventSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty() action!: string;
  @ApiProperty({ type: 'string', nullable: true, enum: ['active', 'suspended', 'closed'] })
  previousStatus!: string | null;
  @ApiProperty({ enum: ['active', 'suspended', 'closed'] }) newStatus!: string;
  @ApiProperty({ type: 'string', nullable: true }) reason!: string | null;
  @ApiProperty({ type: OrganizationLifecycleActorSchema }) actor!: OrganizationLifecycleActorSchema;
  @ApiProperty(timestamp) occurredAt!: string;
}

// --- resellers & hierarchy (Phase 4, U13) -----------------------------------

@ApiSchema({ name: 'Reseller' })
export class ResellerSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ type: 'string', nullable: true }) domain!: string | null;
  @ApiProperty({ type: BrandConfigSchema }) brandConfig!: BrandConfigSchema;
  @ApiProperty({ example: '15.000' }) defaultMarkupPct!: string;
  @ApiProperty({ enum: ['active', 'suspended', 'closed'] }) status!: string;
  @ApiProperty() isPlatformDefault!: boolean;
  @ApiProperty({ type: 'integer', minimum: 0, required: false }) customerCount?: number;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(timestamp) updatedAt!: string;
}

@ApiSchema({ name: 'ResellerOrganization' })
export class ResellerOrganizationSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() status!: string;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(timestamp) updatedAt!: string;
}

// --- pricing (Phase 7 PR 7-2) ----------------------------------------------------

const rateE4 = { type: 'integer', minimum: 0, maximum: PRICING_RATE_MAX_E4 } as const;

@ApiSchema({ name: 'PricingPlan' })
export class PricingPlanSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty(nullableString) description!: string | null;
  @ApiProperty(timestamp) createdAt!: string;
}

@ApiSchema({ name: 'PricingPlanVersionSummary' })
export class PricingPlanVersionSummarySchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) planId!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) versionNumber!: number;
  @ApiProperty({ enum: PRICING_VERSION_STATUSES }) status!: string;
  @ApiProperty(nullableTimestamp) effectiveFrom!: string | null;
  @ApiProperty(nullableTimestamp) activatedAt!: string | null;
  @ApiProperty(timestamp) createdAt!: string;
}

@ApiSchema({ name: 'PricingPlanDetail' })
export class PricingPlanDetailSchema extends PricingPlanSchema {
  @ApiProperty({ type: [PricingPlanVersionSummarySchema] })
  versions!: PricingPlanVersionSummarySchema[];
}

@ApiSchema({ name: 'PricingRule' })
export class PricingRuleSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) channelId!: string;
  @ApiProperty() channelCode!: string;
  @ApiProperty(nullableUuid) providerId!: string | null;
  @ApiProperty({ enum: PRICING_UNITS }) unit!: string;
  @ApiProperty({ ...rateE4, description: 'Unit price in 1/10,000 paisa.' }) unitPriceE4!: number;
}

@ApiSchema({ name: 'PricingPlanVersion' })
export class PricingPlanVersionSchema extends PricingPlanVersionSummarySchema {
  @ApiProperty({ type: [PricingRuleSchema] }) rules!: PricingRuleSchema[];
}

@ApiSchema({ name: 'ProviderCostRate' })
export class ProviderCostRateSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) providerId!: string;
  @ApiProperty(uuid) channelId!: string;
  @ApiProperty() channelCode!: string;
  @ApiProperty({ enum: PRICING_UNITS }) unit!: string;
  @ApiProperty({ ...rateE4, description: 'Unit cost in 1/10,000 paisa.' }) unitCostE4!: number;
  @ApiProperty(timestamp) effectiveFrom!: string;
  @ApiProperty(timestamp) createdAt!: string;
}

@ApiSchema({ name: 'PricingAssignment' })
export class PricingAssignmentSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ ...nullableUuid, description: '`null` is the platform default rate card.' })
  orgId!: string | null;
  @ApiProperty(uuid) planId!: string;
  @ApiProperty(timestamp) effectiveFrom!: string;
  @ApiProperty(timestamp) createdAt!: string;
}

// --- Phase 7 PR 7-6a: tenant billing reads (DECISIONS.md §1zi.9) -----------------
// Amounts are integer paise (INR, OD-7-9). Provider cost, reseller markup and rate-card
// internals are never part of a tenant response.

const paiseAmount = { type: 'integer', minimum: 0, description: 'Integer paise (INR).' } as const;
const nullablePaise = { ...paiseAmount, nullable: true } as const;

@ApiSchema({ name: 'BillingAccount' })
export class BillingAccountSchema {
  @ApiProperty({ enum: ['prepaid', 'postpaid'] }) billingMode!: string;
  @ApiProperty({ enum: ['charge_per_logical_message', 'charge_per_attempt'] })
  billingPolicy!: string;
  @ApiProperty({ enum: ['active', 'frozen'] }) status!: string;
  @ApiProperty({ type: 'string', enum: ['INR'] }) currency!: string;
  @ApiProperty({ ...nullablePaise, description: 'Prepaid only: the wallet balance.' })
  balancePaise!: number | null;
  @ApiProperty({ ...nullablePaise, description: 'Postpaid only: the credit limit.' })
  creditLimitPaise!: number | null;
  @ApiProperty({
    ...nullablePaise,
    description: 'Postpaid only: charges posted against the limit.',
  })
  usedPaise!: number | null;
  @ApiProperty({ ...paiseAmount, description: 'Funds held for messages not yet settled.' })
  reservedPaise!: number;
  @ApiProperty({
    type: 'integer',
    description:
      'What new sends can reserve: balance − reserved (prepaid) or limit − used − reserved (postpaid).',
  })
  availablePaise!: number;
}

@ApiSchema({ name: 'BillingLedgerEntry' })
export class BillingLedgerEntrySchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({
    enum: ['reservation', 'reservation_release', 'customer_charge', 'recharge'],
    description:
      'reservation: funds held at submission; reservation_release: a hold returned; customer_charge: a settled charge; recharge: funds credited to the wallet (amount and time only).',
  })
  entryType!: string;
  @ApiProperty({ ...paiseAmount, minimum: 1 }) amountPaise!: number;
  @ApiProperty({ type: 'string', enum: ['INR'] }) currency!: string;
  @ApiProperty(nullableUuid) messageId!: string | null;
  @ApiProperty(nullableUuid) attemptId!: string | null;
  @ApiProperty(nullableString) correlationId!: string | null;
  @ApiProperty(timestamp) occurredAt!: string;
}

@ApiSchema({ name: 'BillingUsageTotals' })
export class BillingUsageTotalsSchema {
  @ApiProperty(paiseAmount) chargedPaise!: number;
  @ApiProperty({ type: 'integer', minimum: 0, description: 'Messages charged.' }) messages!: number;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description:
      'Billable units of the charged messages (SMS segments; one per WhatsApp/RCS message).',
  })
  units!: number;
}

@ApiSchema({ name: 'BillingUsageChannelRow' })
export class BillingUsageChannelRowSchema extends BillingUsageTotalsSchema {
  @ApiProperty({ enum: [...CHANNEL_CODES] }) channelCode!: string;
}

@ApiSchema({ name: 'BillingUsageDayRow' })
export class BillingUsageDayRowSchema extends BillingUsageChannelRowSchema {
  @ApiProperty({
    type: 'string',
    format: 'date',
    description: 'Calendar day in the report time zone. Days with no charges are omitted.',
  })
  day!: string;
}

@ApiSchema({ name: 'BillingUsage' })
export class BillingUsageSchema {
  @ApiProperty(timestamp) from!: string;
  @ApiProperty(timestamp) to!: string;
  @ApiProperty({ type: 'string', example: 'Asia/Kolkata' }) timeZone!: string;
  @ApiProperty({ enum: [...CHANNEL_CODES, null], nullable: true }) channelCode!: string | null;
  @ApiProperty({ type: 'string', enum: ['INR'] }) currency!: string;
  @ApiProperty({ type: BillingUsageTotalsSchema }) totals!: BillingUsageTotalsSchema;
  @ApiProperty({ type: BillingUsageChannelRowSchema, isArray: true })
  byChannel!: BillingUsageChannelRowSchema[];
  @ApiProperty({ type: BillingUsageDayRowSchema, isArray: true })
  daily!: BillingUsageDayRowSchema[];
}

// --- Phase 7 PR 7-6b: the unknown-outcome register (platform, billing.manage) --------

@ApiSchema({ name: 'UnknownOutcomeExposure' })
export class UnknownOutcomeExposureSchema {
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    nullable: true,
    description:
      'ESTIMATE, not a ledger entry: the customer price the automatic path would have charged (E_m, or the unknown attempt E_a under charge_per_attempt). Integer paise.',
  })
  customerPaise!: number | null;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    nullable: true,
    description:
      'ESTIMATE, not a ledger entry: the provider cost rated for the unknown attempt, when there is one. Integer paise.',
  })
  providerCostPaise!: number | null;
}

@ApiSchema({ name: 'UnknownOutcome' })
export class UnknownOutcomeSchema {
  @ApiProperty(uuid) messageId!: string;
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty({ enum: [...CHANNEL_CODES] }) channelCode!: string;
  @ApiProperty({ enum: ['charge_per_logical_message', 'charge_per_attempt'] })
  billingPolicy!: string;
  @ApiProperty(timestamp) completedAt!: string;
  @ApiProperty({ type: 'integer', minimum: 0 }) ageSeconds!: number;
  @ApiProperty(nullableUuid) attemptId!: string | null;
  @ApiProperty(nullableUuid) providerId!: string | null;
  @ApiProperty({ type: UnknownOutcomeExposureSchema })
  estimatedExposure!: UnknownOutcomeExposureSchema;
  @ApiProperty({ enum: ['evidenced', 'unevidenced'] }) evidence!: string;
  @ApiProperty({
    enum: ['open', 'pending_approval', 'charged', 'charged_without_cost', 'written_off'],
    description:
      'written_off: an executed write-off; charged / charged_without_cost: charged, with or without the provider cost; pending_approval: a resolution awaits a second approver; open: none of these (a rejected request leaves the item open).',
  })
  status!: string;
}

/**
 * Phase 7 PR 7-6d-1 — a billing account as the platform sees it, or `null` when not
 * provisioned. Inline rather than a `$ref`: OpenAPI 3.0 cannot make a `$ref` nullable.
 */
const PLATFORM_BILLING_ACCOUNT = {
  type: 'object',
  nullable: true,
  required: [
    'account',
    'id',
    'status',
    'balancePaise',
    'creditLimitPaise',
    'usedPaise',
    'reservedPaise',
    'availablePaise',
    'version',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    account: { type: 'string', enum: ['wallet', 'credit_account'] },
    id: uuid,
    status: { type: 'string', enum: ['active', 'frozen'] },
    balancePaise: { type: 'integer', minimum: 0, nullable: true, description: 'Wallet only.' },
    creditLimitPaise: {
      type: 'integer',
      minimum: 0,
      nullable: true,
      description: 'Credit account only.',
    },
    usedPaise: { type: 'integer', minimum: 0, nullable: true, description: 'Credit account only.' },
    reservedPaise: { type: 'integer', minimum: 0 },
    availablePaise: {
      type: 'integer',
      description:
        'balance − reserved, or limit − used − reserved; may be negative after a limit decrease.',
    },
    version: { type: 'integer', minimum: 0 },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  additionalProperties: false,
} as const;

@ApiSchema({ name: 'BillingAccounts' })
export class BillingAccountsSchema {
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty(PLATFORM_BILLING_ACCOUNT as never) wallet!: Record<string, unknown> | null;
  @ApiProperty(PLATFORM_BILLING_ACCOUNT as never) creditAccount!: Record<string, unknown> | null;
}

/** Phase 7 PR 7-6d-1 — a billing-account operation. */
@ApiSchema({ name: 'AccountOperation' })
export class AccountOperationSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty({ enum: ['wallet', 'credit_account'] }) account!: string;
  @ApiProperty({ enum: ['provision', 'credit_limit_change', 'freeze', 'unfreeze', 'recharge'] })
  kind!: string;
  @ApiProperty({ enum: ['pending', 'executed', 'rejected'] }) status!: string;
  @ApiProperty({
    ...nullablePaise,
    description:
      'The new limit of a credit-limit change, or the net spendable amount of a recharge (D-76d-2).',
  })
  amountPaise!: number | null;
  @ApiProperty({ ...nullablePaise, description: 'The limit the requester saw.' })
  previousLimitPaise!: number | null;
  @ApiProperty({ description: 'Whether a second approver is required.' }) dualControl!: boolean;
  @ApiProperty({
    ...nullablePaise,
    description:
      'The dual-control threshold in force at request (server configuration); null when unset.',
  })
  thresholdPaise!: number | null;
  @ApiProperty() reason!: string;
  @ApiProperty(uuid) requestedBy!: string;
  @ApiProperty(timestamp) requestedAt!: string;
  @ApiProperty(nullableUuid) approvedBy!: string | null;
  @ApiProperty(nullableTimestamp) approvedAt!: string | null;
  @ApiProperty(nullableUuid) rejectedBy!: string | null;
  @ApiProperty(nullableTimestamp) rejectedAt!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) rejectionReason!: string | null;
  @ApiProperty(nullableTimestamp) executedAt!: string | null;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'Recharge: the external payment reference (platform only; never shown to tenants).',
  })
  paymentReference!: string | null;
  @ApiProperty({
    type: 'string',
    format: 'date',
    nullable: true,
    description: 'Recharge: when the money was received.',
  })
  receivedOn!: string | null;
  @ApiProperty({ ...nullableUuid, description: 'Recharge: the ledger entry it posted.' })
  resultLedgerId!: string | null;
  @ApiProperty({
    type: 'string',
    nullable: true,
    enum: ['account_frozen', 'account_not_configured', null],
    description: 'Why the last approval was refused; the request stayed pending.',
  })
  lastRefusal!: string | null;
  @ApiProperty(nullableTimestamp) lastRefusedAt!: string | null;
}

@ApiSchema({ name: 'AccountOperationResult' })
export class AccountOperationResultSchema {
  @ApiProperty({ type: AccountOperationSchema }) operation!: AccountOperationSchema;
  @ApiProperty({
    ...PLATFORM_BILLING_ACCOUNT,
    description: 'The affected account after the operation; null when it does not exist.',
  } as never)
  account!: Record<string, unknown> | null;
}

/** Phase 7 PR 7-6c — an operator resolution of an unknown outcome. */
@ApiSchema({ name: 'UnknownResolution' })
export class UnknownResolutionSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty(uuid) messageId!: string;
  @ApiProperty(nullableUuid) attemptId!: string | null;
  @ApiProperty({ enum: ['charge', 'write_off'] }) action!: string;
  @ApiProperty({ enum: ['pending', 'executed', 'rejected'] }) status!: string;
  @ApiProperty({ enum: ['charge_per_logical_message', 'charge_per_attempt'] })
  billingPolicy!: string;
  @ApiProperty({
    ...paiseAmount,
    description:
      'Snapshot at request, in paise: the total customer charge a charge posts (E_m, or under charge_per_attempt E_a of the unknown attempt and of every earlier attempt that reached the provider), or the amount written off.',
  })
  customerAmountPaise!: number;
  @ApiProperty({
    ...nullablePaise,
    description: "Snapshot at request: the unknown attempt's evaluated provider cost.",
  })
  providerCostPaise!: number | null;
  @ApiProperty({ enum: ['evidenced', 'unevidenced'] }) evidence!: string;
  @ApiProperty({
    description: 'Whether a charge posts the provider cost: only with a provider receipt.',
  })
  postsProviderCost!: boolean;
  @ApiProperty({ description: 'Whether a second approver is required.' }) dualControl!: boolean;
  @ApiProperty({
    ...nullablePaise,
    description: 'The dual-control threshold in force at request; null when unset.',
  })
  thresholdPaise!: number | null;
  @ApiProperty() reason!: string;
  @ApiProperty(uuid) requestedBy!: string;
  @ApiProperty(timestamp) requestedAt!: string;
  @ApiProperty(nullableUuid) approvedBy!: string | null;
  @ApiProperty(nullableTimestamp) approvedAt!: string | null;
  @ApiProperty(nullableUuid) rejectedBy!: string | null;
  @ApiProperty(nullableTimestamp) rejectedAt!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) rejectionReason!: string | null;
  @ApiProperty(nullableTimestamp) executedAt!: string | null;
  @ApiProperty({ ...nullablePaise, description: 'Customer charges posted on execution.' })
  chargedPaise!: number | null;
  @ApiProperty({ ...nullablePaise, description: 'Provider cost posted on execution.' })
  providerCostPostedPaise!: number | null;
  @ApiProperty({
    type: 'string',
    nullable: true,
    enum: ['insufficient_funds', 'account_frozen', 'account_not_configured', null],
    description: 'Why the last approval was refused; the request stayed pending.',
  })
  lastRefusal!: string | null;
  @ApiProperty(nullableTimestamp) lastRefusedAt!: string | null;
}

// --- Phase 8C PR 8C-1: journey definitions ------------------------------------------------

const sha256Hex = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;

/**
 * A nullable version summary, inline (as `PROVIDER_FAILURE`): OpenAPI 3.0 cannot make a `$ref`
 * nullable, so `null` is admitted on the object itself.
 */
const NULLABLE_VERSION_SUMMARY = {
  type: 'object',
  nullable: true,
  required: [
    'id',
    'versionNumber',
    'status',
    'graphSha256',
    'publishedAt',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: uuid,
    versionNumber: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: [...JOURNEY_VERSION_STATUSES] },
    graphSha256: sha256Hex,
    publishedAt: nullableTimestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  additionalProperties: false,
} as const;

@ApiSchema({ name: 'JourneyVersionSummary' })
export class JourneyVersionSummarySchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) versionNumber!: number;
  @ApiProperty({ enum: [...JOURNEY_VERSION_STATUSES] }) status!: string;
  @ApiProperty({ ...sha256Hex, description: 'SHA-256 of the canonical JSON graph.' })
  graphSha256!: string;
  @ApiProperty(nullableTimestamp) publishedAt!: string | null;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(timestamp) updatedAt!: string;
}

@ApiSchema({ name: 'JourneyVersion' })
export class JourneyVersionSchema extends JourneyVersionSummarySchema {
  @ApiProperty(uuid) journeyId!: string;
  @ApiProperty(uuid) workspaceId!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) graphSchemaVersion!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'The journey graph (`packages/contracts/src/journeys.ts`).',
  })
  graph!: Record<string, unknown>;
  @ApiProperty(nullableUuid) createdBy!: string | null;
  @ApiProperty({ ...nullableUuid, description: 'Null when an API key published the version.' })
  publishedBy!: string | null;
}

/** 8C-2: the journey's live trigger, inline and nullable (as `NULLABLE_VERSION_SUMMARY`). */
const NULLABLE_JOURNEY_TRIGGER = {
  type: 'object',
  nullable: true,
  required: [
    'id',
    'journeyVersionId',
    'kind',
    'eventKind',
    'eventTag',
    'segmentId',
    'nextFireAt',
    'status',
  ],
  properties: {
    id: uuid,
    journeyVersionId: uuid,
    kind: { type: 'string', enum: [...JOURNEY_TRIGGER_KINDS] },
    eventKind: nullableString,
    eventTag: nullableString,
    segmentId: nullableUuid,
    nextFireAt: nullableTimestamp,
    status: { type: 'string', enum: [...JOURNEY_TRIGGER_STATUSES] },
  },
  additionalProperties: false,
  description:
    "Derived from the active version's entry node at activation. Nothing processes it until 8C-4.",
} as const;

@ApiSchema({ name: 'Journey' })
export class JourneySchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) orgId!: string;
  @ApiProperty(uuid) workspaceId!: string;
  @ApiProperty() name!: string;
  @ApiProperty(nullableString) description!: string | null;
  @ApiProperty({ enum: [...JOURNEY_STATUSES] }) status!: string;
  @ApiProperty(nullableUuid) createdBy!: string | null;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(timestamp) updatedAt!: string;
  @ApiProperty(NULLABLE_VERSION_SUMMARY as never)
  draftVersion!: Record<string, unknown> | null;
  @ApiProperty(NULLABLE_VERSION_SUMMARY as never)
  latestPublishedVersion!: Record<string, unknown> | null;
  @ApiProperty({
    ...nullableUuid,
    description: 'The published version new enrolments use; null until first activated.',
  })
  activeVersionId!: string | null;
  @ApiProperty(nullableTimestamp) activatedAt!: string | null;
  @ApiProperty({ ...nullableUuid, description: 'Null when an API key activated the journey.' })
  activatedBy!: string | null;
  @ApiProperty(NULLABLE_JOURNEY_TRIGGER as never)
  trigger!: Record<string, unknown> | null;
}

@ApiSchema({ name: 'JourneyGraphIssue' })
export class JourneyGraphIssueSchema {
  @ApiProperty({ enum: [...JOURNEY_GRAPH_ISSUE_CODES] }) code!: string;
  @ApiProperty() message!: string;
  @ApiProperty({ required: false }) nodeKey?: string;
  @ApiProperty({ required: false }) path?: string;
}

@ApiSchema({ name: 'JourneyGraphValidationReport' })
export class JourneyGraphValidationReportSchema {
  @ApiProperty() valid!: boolean;
  @ApiProperty({ type: [JourneyGraphIssueSchema] }) errors!: JourneyGraphIssueSchema[];
  @ApiProperty({ type: [JourneyGraphIssueSchema], description: 'Never block publication.' })
  warnings!: JourneyGraphIssueSchema[];
}

// --- Phase 8C PR 8C-2: lifecycle, executions, statistics ----------------------------------

@ApiSchema({ name: 'JourneyExecution' })
export class JourneyExecutionSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(uuid) journeyId!: string;
  @ApiProperty(uuid) journeyVersionId!: string;
  @ApiProperty(uuid) workspaceId!: string;
  @ApiProperty(uuid) contactId!: string;
  @ApiProperty({ enum: [...JOURNEY_EXECUTION_STATUSES] }) status!: string;
  @ApiProperty({ ...nullableString, description: 'The node the execution runs next.' })
  currentNodeKey!: string | null;
  @ApiProperty(nullableTimestamp) wakeAt!: string | null;
  @ApiProperty({ type: 'integer', minimum: 0 }) stateVersion!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) transitions!: number;
  @ApiProperty({ enum: [...JOURNEY_TRIGGER_KINDS] }) entryKind!: string;
  @ApiProperty({ ...nullableUuid, description: 'Null for an API key or an automated entry.' })
  enrolledBy!: string | null;
  @ApiProperty(timestamp) enteredAt!: string;
  @ApiProperty(nullableTimestamp) endedAt!: string | null;
  @ApiProperty(nullableString) endReason!: string | null;
  @ApiProperty(timestamp) updatedAt!: string;
}

@ApiSchema({ name: 'JourneyExecutionStep' })
export class JourneyExecutionStepSchema {
  @ApiProperty({ type: 'integer', minimum: 1 }) seq!: number;
  @ApiProperty() nodeKey!: string;
  @ApiProperty() nodeType!: string;
  @ApiProperty({ enum: [...JOURNEY_STEP_OUTCOMES] }) outcome!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) attempt!: number;
  @ApiProperty(nullableUuid) messageId!: string | null;
  @ApiProperty(nullableString) errorCode!: string | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Bounded; never message content or addresses.',
  })
  details!: Record<string, unknown>;
  @ApiProperty(timestamp) startedAt!: string;
  @ApiProperty(timestamp) finishedAt!: string;
}

@ApiSchema({ name: 'JourneyExecutionDetail' })
export class JourneyExecutionDetailSchema extends JourneyExecutionSchema {
  @ApiProperty({ type: [JourneyExecutionStepSchema], description: 'Ordered by `seq`.' })
  steps!: JourneyExecutionStepSchema[];
}

@ApiSchema({ name: 'JourneyEnrolmentOutcome' })
export class JourneyEnrolmentOutcomeSchema {
  @ApiProperty(uuid) contactId!: string;
  @ApiProperty({ enum: [...JOURNEY_ENROLMENT_OUTCOMES] }) outcome!: string;
  @ApiProperty({
    ...nullableUuid,
    description: "The new execution, or the contact's most recent one when already enrolled.",
  })
  executionId!: string | null;
}

@ApiSchema({ name: 'JourneyEnrolmentResult' })
export class JourneyEnrolmentResultSchema {
  @ApiProperty(uuid) journeyId!: string;
  @ApiProperty(uuid) journeyVersionId!: string;
  @ApiProperty({ type: 'integer', minimum: 0 }) enrolled!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) alreadyEnrolled!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) contactNotFound!: number;
  @ApiProperty({ type: [JourneyEnrolmentOutcomeSchema], description: 'In request order.' })
  results!: JourneyEnrolmentOutcomeSchema[];
}

const statCount = { type: 'integer', minimum: 0 } as const;

@ApiSchema({ name: 'JourneyNodeStats' })
export class JourneyNodeStatsSchema {
  @ApiProperty() nodeKey!: string;
  @ApiProperty() nodeType!: string;
  @ApiProperty({ ...statCount, description: 'Live executions positioned at this node.' })
  running!: number;
  @ApiProperty(statCount) waiting!: number;
  @ApiProperty({
    type: 'object',
    properties: Object.fromEntries(JOURNEY_STEP_OUTCOMES.map((o) => [o, statCount])),
    additionalProperties: false,
    description: 'History rows recorded at this node, by outcome (absent outcomes omitted).',
  })
  outcomes!: Record<string, number>;
}

@ApiSchema({ name: 'JourneyVersionStats' })
export class JourneyVersionStatsSchema {
  @ApiProperty(uuid) versionId!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) versionNumber!: number;
  @ApiProperty({
    type: 'object',
    required: [...JOURNEY_EXECUTION_STATUSES, 'total'],
    properties: Object.fromEntries(
      [...JOURNEY_EXECUTION_STATUSES, 'total'].map((s) => [s, statCount]),
    ),
    additionalProperties: false,
  })
  executions!: Record<string, number>;
  @ApiProperty({ type: [JourneyNodeStatsSchema] }) nodes!: JourneyNodeStatsSchema[];
}

@ApiSchema({ name: 'JourneyStats' })
export class JourneyStatsSchema {
  @ApiProperty(uuid) journeyId!: string;
  @ApiProperty({ type: [JourneyVersionStatsSchema] }) versions!: JourneyVersionStatsSchema[];
}
