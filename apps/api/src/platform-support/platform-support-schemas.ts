import { PLATFORM_SUPPORT_FAILURE_CODES } from '@acc/contracts';
import { ApiProperty, ApiSchema } from '@nestjs/swagger';

const uuid = { type: 'string', format: 'uuid' } as const;
const nullableUuid = { type: 'string', format: 'uuid', nullable: true } as const;
const timestamp = { type: 'string', format: 'date-time' } as const;
const nullableTimestamp = { type: 'string', format: 'date-time', nullable: true } as const;

@ApiSchema({ name: 'PlatformSupportOrgOverview' })
export class PlatformSupportOrgOverviewSchema {
  @ApiProperty({
    type: 'object',
    properties: {
      id: uuid,
      name: { type: 'string' },
      slug: { type: 'string' },
      status: { type: 'string' },
      resellerId: nullableUuid,
      brandConfig: { type: 'object', additionalProperties: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    required: [
      'id',
      'name',
      'slug',
      'status',
      'resellerId',
      'brandConfig',
      'createdAt',
      'updatedAt',
    ],
  })
  readonly organization!: object;

  @ApiProperty({
    type: 'object',
    nullable: true,
    properties: {
      id: uuid,
      name: { type: 'string' },
      slug: { type: 'string' },
    },
    required: ['id', 'name', 'slug'],
  })
  readonly parentReseller!: object | null;

  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: uuid,
        name: { type: 'string' },
        slug: { type: 'string' },
        status: { type: 'string' },
        createdAt: timestamp,
      },
      required: ['id', 'name', 'slug', 'status', 'createdAt'],
    },
  })
  readonly workspaces!: object[];

  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: uuid,
        name: { type: 'string' },
        workspaceId: uuid,
        createdAt: timestamp,
      },
      required: ['id', 'name', 'workspaceId', 'createdAt'],
    },
  })
  readonly teams!: object[];

  @ApiProperty({
    type: 'object',
    properties: {
      totalUsers: { type: 'integer' },
      activeUsers: { type: 'integer' },
      disabledUsers: { type: 'integer' },
      activeApiKeys: { type: 'integer' },
      activeSessions: { type: 'integer' },
      verifiedDomains: { type: 'integer' },
    },
    required: [
      'totalUsers',
      'activeUsers',
      'disabledUsers',
      'activeApiKeys',
      'activeSessions',
      'verifiedDomains',
    ],
  })
  readonly metrics!: object;
}

@ApiSchema({ name: 'PlatformSupportRoutingDiagnostics' })
export class PlatformSupportRoutingDiagnosticsSchema {
  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: uuid,
        code: { type: 'string' },
        name: { type: 'string' },
        status: { type: 'string' },
        defaultProviderId: nullableUuid,
        fallbackProviderId: nullableUuid,
      },
      required: ['id', 'code', 'name', 'status', 'defaultProviderId', 'fallbackProviderId'],
    },
  })
  readonly channels!: object[];

  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: uuid,
        channel: { type: 'string' },
        providerId: uuid,
        providerName: { type: 'string' },
        providerType: { type: 'string' },
        status: { type: 'string' },
        priority: { type: 'integer' },
        isFallback: { type: 'boolean' },
        assignedAt: timestamp,
      },
      required: [
        'id',
        'channel',
        'providerId',
        'providerName',
        'providerType',
        'status',
        'priority',
        'isFallback',
        'assignedAt',
      ],
    },
  })
  readonly assignments!: object[];

  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: {
        providerId: uuid,
        providerName: { type: 'string' },
        channel: { type: 'string' },
        status: { type: 'string' },
        healthState: { type: 'string' },
        healthChangedAt: nullableTimestamp,
        circuitState: { type: 'string' },
        circuitGeneration: { type: 'integer' },
        circuitChangedAt: nullableTimestamp,
      },
      required: [
        'providerId',
        'providerName',
        'channel',
        'status',
        'healthState',
        'healthChangedAt',
        'circuitState',
        'circuitGeneration',
        'circuitChangedAt',
      ],
    },
  })
  readonly providerHealth!: object[];
}

const failureCode = {
  type: 'string' as const,
  enum: [...PLATFORM_SUPPORT_FAILURE_CODES],
  nullable: true,
  description:
    'A fixed failure code (migration 0040, app_support_failure_code); OTHER for any unrecognised reason. Failure text is never returned.',
};

@ApiSchema({
  name: 'PlatformSupportDispatchDiagnostics',
  description:
    'Dispatch metadata only (ADR-015 R-8): no recipient, payload, template, contact or failure text.',
})
export class PlatformSupportDispatchDiagnosticsSchema {
  @ApiProperty({
    type: 'object',
    additionalProperties: false,
    properties: {
      pendingCount: { type: 'integer', description: 'Ready to be claimed by the dispatcher.' },
      delayedCount: { type: 'integer', description: 'Waiting for a retry/backoff time.' },
      claimedCount: { type: 'integer', description: 'Under a live dispatcher claim.' },
    },
    required: ['pendingCount', 'delayedCount', 'claimedCount'],
  })
  readonly queue!: object;

  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        messageId: uuid,
        channel: { type: 'string' },
        status: { type: 'string' },
        failureCode,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: nullableTimestamp,
        attemptCount: { type: 'integer' },
        attempts: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attemptNumber: { type: 'integer' },
              providerId: uuid,
              adapterKey: { type: 'string' },
              status: { type: 'string' },
              failureCode,
              latencyMs: { type: 'integer', nullable: true },
              attemptedAt: timestamp,
            },
            required: [
              'attemptNumber',
              'providerId',
              'adapterKey',
              'status',
              'failureCode',
              'latencyMs',
              'attemptedAt',
            ],
          },
        },
      },
      required: [
        'messageId',
        'channel',
        'status',
        'failureCode',
        'createdAt',
        'updatedAt',
        'completedAt',
        'attemptCount',
        'attempts',
      ],
    },
  })
  readonly recentMessages!: object[];
}

@ApiSchema({ name: 'PlatformSupportAuditItem' })
export class PlatformSupportAuditItemSchema {
  @ApiProperty(uuid)
  readonly id!: string;

  @ApiProperty(timestamp)
  readonly occurredAt!: string;

  @ApiProperty({ type: 'string' })
  readonly action!: string;

  @ApiProperty({ type: 'string' })
  readonly outcome!: string;

  @ApiProperty({ type: 'string' })
  readonly actorType!: string;

  @ApiProperty(nullableUuid)
  readonly actorUserId!: string | null;

  @ApiProperty({ type: 'string' })
  readonly resourceType!: string;

  @ApiProperty({ type: 'string', nullable: true })
  readonly resourceId!: string | null;

  @ApiProperty({ type: 'string' })
  readonly scopeType!: string;

  @ApiProperty(nullableUuid)
  readonly scopeId!: string | null;

  @ApiProperty(nullableUuid)
  readonly orgId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly orgName!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Redacted. IP address, user agent and actor email are not returned.',
  })
  readonly metadata!: Record<string, unknown>;
}
