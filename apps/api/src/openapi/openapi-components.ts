import { ERROR_CODES, PAGE_LIMITS } from '@acc/contracts';
import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';

/**
 * Documentation-only schemas for the shared envelopes (`API.md` §7–§8). These
 * classes are never instantiated: they describe, for OpenAPI, the shapes the
 * runtime already produces (`AllExceptionsFilter`, the per-controller
 * `{data}` / `{data, page}` envelopes, `ValidationIssue`, `PageInfo`).
 */

@ApiSchema({ name: 'ValidationIssue' })
export class ValidationIssueSchema {
  @ApiProperty({ description: 'Dotted path from the request root, e.g. `permissions.0`.' })
  field!: string;

  @ApiProperty({ description: 'Stable screaming-snake rule, e.g. `IS_UUID`, `MAX_LENGTH`.' })
  rule!: string;

  @ApiProperty()
  message!: string;
}

@ApiSchema({ name: 'ErrorBody' })
export class ErrorBodySchema {
  @ApiProperty({ enum: Object.values(ERROR_CODES), description: 'Stable, machine-readable code.' })
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty({ description: 'The request correlation id, also sent as `X-Correlation-Id`.' })
  correlationId!: string;

  @ApiProperty({
    description:
      'True only where an identical retry is safe and may succeed; clients must check it before retrying.',
  })
  retryable!: boolean;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Code-specific detail. `VALIDATION_FAILED` carries `issues: ValidationIssue[]`; lifecycle conflicts carry `status`; `RATE_LIMIT_EXCEEDED` from the general limiter carries `retryAfterSeconds`.',
  })
  details?: Record<string, unknown>;
}

@ApiSchema({ name: 'ErrorEnvelope' })
export class ErrorEnvelopeSchema {
  @ApiProperty({ type: ErrorBodySchema })
  error!: ErrorBodySchema;
}

@ApiSchema({ name: 'PageInfo' })
export class PageInfoSchema {
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Opaque, integrity-protected cursor for the next page, or null at the end.',
  })
  nextCursor!: string | null;

  @ApiProperty()
  hasMore!: boolean;

  @ApiProperty({
    minimum: PAGE_LIMITS.MIN,
    maximum: PAGE_LIMITS.MAX,
    description: 'The page size actually applied.',
  })
  limit!: number;
}

/** The schemas every document registers, whether or not an operation uses them directly. */
export const SHARED_SCHEMAS = [
  ValidationIssueSchema,
  ErrorBodySchema,
  ErrorEnvelopeSchema,
  PageInfoSchema,
] as const;
