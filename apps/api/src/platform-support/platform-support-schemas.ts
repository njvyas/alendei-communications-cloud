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
      type: { type: 'string' },
      resellerId: nullableUuid,
      brandConfig: { type: 'object', nullable: true, additionalProperties: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    required: [
      'id',
      'name',
      'slug',
      'status',
      'type',
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
      },
      required: ['id', 'name', 'slug', 'status'],
    },
  })
  readonly customerOrganizations!: object[];

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
        circuitState: { type: 'string' },
        failureCount: { type: 'integer' },
        lastFailureAt: nullableTimestamp,
      },
      required: [
        'providerId',
        'providerName',
        'channel',
        'status',
        'healthState',
        'circuitState',
        'failureCount',
        'lastFailureAt',
      ],
    },
  })
  readonly providerHealth!: object[];
}

@ApiSchema({ name: 'PlatformSupportDispatchDiagnostics' })
export class PlatformSupportDispatchDiagnosticsSchema {
  @ApiProperty({
    type: 'object',
    properties: {
      pendingCount: { type: 'integer' },
      claimedCount: { type: 'integer' },
      delayedCount: { type: 'integer' },
    },
    required: ['pendingCount', 'claimedCount', 'delayedCount'],
  })
  readonly queue!: object;

  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: {
        messageId: uuid,
        channel: { type: 'string' },
        status: { type: 'string' },
        failureReason: { type: 'string', nullable: true },
        failureCategory: { type: 'string', nullable: true },
        attemptCount: { type: 'integer' },
        createdAt: timestamp,
        updatedAt: timestamp,
        lastAttemptAt: nullableTimestamp,
        maskedRecipient: { type: 'string' },
        providerAttempts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              attemptNumber: { type: 'integer' },
              providerId: uuid,
              providerType: { type: 'string' },
              errorType: { type: 'string', nullable: true },
              httpStatus: { type: 'integer', nullable: true },
              latencyMs: { type: 'integer', nullable: true },
              attemptedAt: timestamp,
            },
            required: [
              'attemptNumber',
              'providerId',
              'providerType',
              'errorType',
              'httpStatus',
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
        'failureReason',
        'failureCategory',
        'attemptCount',
        'createdAt',
        'updatedAt',
        'lastAttemptAt',
        'maskedRecipient',
        'providerAttempts',
      ],
    },
  })
  readonly recentFailures!: object[];
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

  @ApiProperty({ type: 'string', nullable: true })
  readonly actorEmail!: string | null;

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

  @ApiProperty({ type: 'object', additionalProperties: true })
  readonly metadata!: Record<string, unknown>;

  @ApiProperty({ type: 'string', nullable: true })
  readonly ip!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  readonly userAgent!: string | null;
}
