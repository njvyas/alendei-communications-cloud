import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { JOURNEY_STATUSES, type JourneyStatus } from '@acc/contracts';

import { ListQueryDto } from '../common/http/list-query.dto';

/** `GET /workspaces/:workspaceId/journeys`. */
export class ListJourneysDto extends ListQueryDto {
  @IsOptional()
  @IsIn(JOURNEY_STATUSES)
  status?: JourneyStatus;

  /** Case-insensitive substring of the name. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  query?: string;
}

/** `POST /workspaces/:workspaceId/journeys`: a journey with version 1 as a minimal draft. */
export class CreateJourneyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

/** `PATCH /workspaces/:workspaceId/journeys/:journeyId`: name and description only. */
export class UpdateJourneyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

/**
 * `PUT …/versions/:versionId/graph`: replaces a draft's graph. The graph's own shape is
 * checked by the shared validator (`validateJourneyGraph`), not here: a draft may be saved
 * while still invalid, and only publication requires a valid graph.
 */
export class ReplaceJourneyGraphDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The journey graph (`packages/contracts/src/journeys.ts`): `{ schemaVersion: 1, entry, nodes }`.',
  })
  @IsObject()
  graph!: Record<string, unknown>;

  /** The draft's current `graphSha256`, as last read: a stale value is `409 JOURNEY_GRAPH_CONFLICT`. */
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  expectedGraphSha256!: string;
}

/** `POST …/versions/:versionId/publish`: the draft's hash, so a publish never freezes an unseen edit. */
export class PublishJourneyVersionDto {
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  expectedGraphSha256!: string;
}
