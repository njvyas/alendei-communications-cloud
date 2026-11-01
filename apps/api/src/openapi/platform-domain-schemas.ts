/**
 * OpenAPI response schemas for platform domain oversight (Phase 4, U13.3).
 *
 * Kept apart from `openapi-schemas.ts` so the U13 workstreams do not edit the
 * same block. Each mirrors a type in `@acc/contracts` `domain-oversight.ts`
 * field for field; none carries a challenge value.
 */
import {
  DNS_LOOKUP_OUTCOMES,
  DNS_PROPAGATION_STATES,
  DOMAIN_CHALLENGE_STATES,
  DOMAIN_STATUSES,
  DOMAIN_TYPES,
  DOMAIN_VERIFICATION_METHODS,
  DOMAIN_VERIFICATION_STATUSES,
} from '@acc/contracts';
import { ApiProperty, ApiSchema } from '@nestjs/swagger';

const uuid = { type: 'string', format: 'uuid' } as const;
const timestamp = { type: 'string', format: 'date-time' } as const;
const nullableTimestamp = { type: 'string', format: 'date-time', nullable: true } as const;
const nullableString = { type: 'string', nullable: true } as const;
const nullableUuid = { type: 'string', format: 'uuid', nullable: true } as const;
const count = { type: 'integer', minimum: 0 } as const;

const countsOf = (keys: readonly string[]) => ({
  type: 'object' as const,
  properties: Object.fromEntries(keys.map((k) => [k, count])),
  required: [...keys],
  additionalProperties: false,
});

@ApiSchema({ name: 'DomainChallengeSummary' })
export class DomainChallengeSummarySchema {
  @ApiProperty({ enum: DOMAIN_CHALLENGE_STATES }) state!: string;
  @ApiProperty(nullableTimestamp) issuedAt!: string | null;
  @ApiProperty(nullableTimestamp) expiresAt!: string | null;
}

@ApiSchema({ name: 'PlatformDomainOrganization' })
export class PlatformDomainOrganizationSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() status!: string;
}

@ApiSchema({ name: 'PlatformDomainReseller' })
export class PlatformDomainResellerSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() isPlatformDefault!: boolean;
}

@ApiSchema({ name: 'PlatformDomain' })
export class PlatformDomainSchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty() domain!: string;
  @ApiProperty({ enum: DOMAIN_TYPES }) domainType!: string;
  @ApiProperty({ enum: DOMAIN_STATUSES }) status!: string;
  @ApiProperty({ enum: DOMAIN_VERIFICATION_METHODS }) verificationMethod!: string;
  @ApiProperty({ enum: DOMAIN_VERIFICATION_STATUSES }) verificationStatus!: string;
  @ApiProperty(nullableTimestamp) verifiedAt!: string | null;
  @ApiProperty() isPrimary!: boolean;
  @ApiProperty(timestamp) createdAt!: string;
  @ApiProperty(timestamp) updatedAt!: string;
  @ApiProperty({ type: DomainChallengeSummarySchema }) challenge!: DomainChallengeSummarySchema;
  @ApiProperty({ type: PlatformDomainOrganizationSchema })
  organization!: PlatformDomainOrganizationSchema;
  @ApiProperty({ type: PlatformDomainResellerSchema, nullable: true })
  reseller!: PlatformDomainResellerSchema | null;
}

@ApiSchema({ name: 'PlatformDomainSummary' })
export class PlatformDomainSummarySchema {
  @ApiProperty(count) total!: number;
  @ApiProperty(countsOf(DOMAIN_STATUSES)) byStatus!: Record<string, number>;
  @ApiProperty(countsOf(DOMAIN_CHALLENGE_STATES)) byChallengeState!: Record<string, number>;
  @ApiProperty(countsOf(DOMAIN_TYPES)) byType!: Record<string, number>;
  @ApiProperty(count) needsAttention!: number;
}

@ApiSchema({ name: 'DnsResolverResult' })
export class DnsResolverResultSchema {
  @ApiProperty() resolver!: string;
  @ApiProperty({ enum: DNS_LOOKUP_OUTCOMES }) outcome!: string;
  @ApiProperty(count) recordCount!: number;
  @ApiProperty(nullableString) errorCode!: string | null;
  @ApiProperty(count) durationMs!: number;
}

@ApiSchema({ name: 'DomainDnsDiagnostics' })
export class DomainDnsDiagnosticsSchema {
  @ApiProperty(uuid) domainId!: string;
  @ApiProperty() domain!: string;
  @ApiProperty() challengeHost!: string;
  @ApiProperty(timestamp) checkedAt!: string;
  @ApiProperty({ enum: DNS_PROPAGATION_STATES }) propagation!: string;
  @ApiProperty({ type: DnsResolverResultSchema, isArray: true })
  results!: DnsResolverResultSchema[];
  @ApiProperty() guidance!: string;
  @ApiProperty({ type: DomainChallengeSummarySchema }) challenge!: DomainChallengeSummarySchema;
}

@ApiSchema({ name: 'DomainHistoryEntry' })
export class DomainHistoryEntrySchema {
  @ApiProperty(uuid) id!: string;
  @ApiProperty(timestamp) occurredAt!: string;
  @ApiProperty() action!: string;
  @ApiProperty() outcome!: string;
  @ApiProperty() actorType!: string;
  @ApiProperty(nullableUuid) actorUserId!: string | null;
  @ApiProperty(nullableString) fromStatus!: string | null;
  @ApiProperty(nullableString) toStatus!: string | null;
  @ApiProperty(nullableString) fromVerificationStatus!: string | null;
  @ApiProperty(nullableString) toVerificationStatus!: string | null;
  @ApiProperty(nullableString) reason!: string | null;
}
