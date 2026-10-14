import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Min } from 'class-validator';
import { ASSIGNMENT_STATUS, type AssignmentStatus } from '@acc/contracts';
import { ListQueryDto } from '../common/http/list-query.dto';

export const ASSIGNMENT_STATUSES = [ASSIGNMENT_STATUS.ACTIVE, ASSIGNMENT_STATUS.DISABLED] as const;

/**
 * `POST /organizations/:orgId/provider-assignments` input.
 */
export class CreateOrganizationProviderAssignmentDto {
  @ApiProperty({ description: 'The platform provider UUID to assign', format: 'uuid' })
  @IsUUID()
  providerId!: string;

  @ApiProperty({
    description: 'Candidate priority (>= 1, lower numbers evaluated first)',
    minimum: 1,
    example: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  priority!: number;

  @ApiPropertyOptional({ enum: ASSIGNMENT_STATUSES, default: ASSIGNMENT_STATUS.ACTIVE })
  @IsOptional()
  @IsIn(ASSIGNMENT_STATUSES)
  status?: AssignmentStatus;
}

/**
 * `PATCH /organizations/:orgId/provider-assignments/:id` input.
 */
export class UpdateOrganizationProviderAssignmentDto {
  @ApiPropertyOptional({ description: 'Updated candidate priority (>= 1)', minimum: 1, example: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  priority?: number;

  @ApiPropertyOptional({ enum: ASSIGNMENT_STATUSES })
  @IsOptional()
  @IsIn(ASSIGNMENT_STATUSES)
  status?: AssignmentStatus;
}

/**
 * `GET /organizations/:orgId/provider-assignments` query filters.
 */
export class ListOrganizationProviderAssignmentsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ description: 'Filter by channel UUID', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  channelId?: string;

  @ApiPropertyOptional({ enum: ASSIGNMENT_STATUSES, description: 'Filter by assignment status' })
  @IsOptional()
  @IsIn(ASSIGNMENT_STATUSES)
  status?: AssignmentStatus;
}
