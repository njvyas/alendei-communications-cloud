import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import {
  DOMAIN_CHALLENGE_STATES,
  DOMAIN_STATUSES,
  DOMAIN_TYPES,
  DOMAIN_VERIFICATION_STATUSES,
  type DomainChallengeState,
  type DomainStatus,
  type DomainType,
  type DomainVerificationStatus,
} from '@acc/contracts';

import { ListQueryDto } from '../../../common/http/list-query.dto';

/** `GET /platform/domains`. Every filter is optional and they combine with AND. */
export class ListPlatformDomainsQueryDto extends ListQueryDto {
  @IsOptional()
  @IsIn(DOMAIN_STATUSES)
  @ApiPropertyOptional({ enum: DOMAIN_STATUSES })
  status?: DomainStatus;

  @IsOptional()
  @IsIn(DOMAIN_TYPES)
  @ApiPropertyOptional({ enum: DOMAIN_TYPES })
  domainType?: DomainType;

  @IsOptional()
  @IsIn(DOMAIN_VERIFICATION_STATUSES)
  @ApiPropertyOptional({ enum: DOMAIN_VERIFICATION_STATUSES })
  verificationStatus?: DomainVerificationStatus;

  @IsOptional()
  @IsIn(DOMAIN_CHALLENGE_STATES)
  @ApiPropertyOptional({ enum: DOMAIN_CHALLENGE_STATES })
  challengeState?: DomainChallengeState;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ format: 'uuid' })
  orgId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ format: 'uuid' })
  resellerId?: string;

  /** Case-insensitive substring of the hostname. Hostname characters only. */
  @IsOptional()
  @IsString()
  @MaxLength(253)
  @Matches(/^[A-Za-z0-9.-]+$/, { message: 'q may contain only letters, digits, dots and hyphens' })
  @ApiPropertyOptional({ maxLength: 253 })
  q?: string;
}
