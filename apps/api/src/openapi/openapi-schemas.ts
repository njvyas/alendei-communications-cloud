import { ACTOR_TYPES, AUDIT_OUTCOMES, SCOPE_TYPES } from '@acc/contracts';
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
