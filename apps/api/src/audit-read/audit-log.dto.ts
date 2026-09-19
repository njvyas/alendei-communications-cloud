import { Type } from 'class-transformer';
import { IsDate, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { ACTOR_TYPES, AUDIT_OUTCOMES, SCOPE_TYPES } from '@acc/contracts';

import { ListQueryDto } from '../common/http/list-query.dto';

/**
 * `GET /audit-logs` query (`API.md` §8b, §3f).
 *
 * Every filter narrows **within** what the caller may already see. None of them
 * is an isolation mechanism: `audit_logs_select` decides visibility from the
 * transaction's tenant context, and a filter naming another tenant's
 * organization matches nothing rather than reaching it. That ordering matters —
 * if a filter were the boundary, forgetting one would be a leak; here
 * forgetting one only returns more of the caller's own trail.
 */
export class ListAuditLogsQueryDto extends ListQueryDto {
  /** Exact action key, e.g. `user_role.granted`. Not a prefix or pattern. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[a-z][a-z0-9_.]*$/, {
    message: 'action must be a lowercase dotted action key',
  })
  action?: string;

  @IsOptional()
  @IsIn(ACTOR_TYPES)
  actorType?: (typeof ACTOR_TYPES)[number];

  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @IsIn(AUDIT_OUTCOMES)
  outcome?: (typeof AUDIT_OUTCOMES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z][A-Za-z0-9_]*$/, { message: 'resourceType must be an identifier' })
  resourceType?: string;

  @IsOptional()
  @IsUUID()
  resourceId?: string;

  /**
   * The scope level a row was recorded at.
   *
   * Accepts all five levels — unlike the grant and API-key surfaces, which
   * restrict what may be *created*. Here the caller is describing rows that
   * already exist, and `platform`-scoped rows are real and readable by a
   * platform administrator, so excluding the level would hide records rather
   * than prevent anything.
   */
  @IsOptional()
  @IsIn(SCOPE_TYPES)
  scopeType?: (typeof SCOPE_TYPES)[number];

  @IsOptional()
  @IsUUID()
  scopeId?: string;

  /**
   * The end-to-end identifier shared by every row one request produced.
   *
   * The most useful filter on this endpoint and the reason it is here: an
   * investigation almost always starts from one correlation id and wants the
   * whole causal fan-out, which no combination of the other filters expresses.
   */
  @IsOptional()
  @IsUUID()
  correlationId?: string;

  /** Inclusive lower bound on `occurredAt`. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  occurredFrom?: Date;

  /** Exclusive upper bound on `occurredAt`. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  occurredTo?: Date;
}
