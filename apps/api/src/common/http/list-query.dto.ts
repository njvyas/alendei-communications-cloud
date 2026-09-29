import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { PAGE_LIMITS } from '@acc/contracts';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The pagination and ordering parameters every list endpoint accepts
 * (`API.md` §8).
 *
 * Endpoint-specific filters extend this, so a client learns the paging
 * convention once rather than per resource.
 */
export class ListQueryDto {
  /** Opaque; passed back verbatim from a previous page's `page.nextCursor`. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(PAGE_LIMITS.MIN)
  @Max(PAGE_LIMITS.MAX)
  @ApiPropertyOptional({ type: 'integer', minimum: PAGE_LIMITS.MIN, maximum: PAGE_LIMITS.MAX })
  limit?: number;

  /**
   * `field` ascending, `-field` descending.
   *
   * The pattern bounds the shape; the *allow-list* of fields is enforced by
   * `ListQuery` against the endpoint's spec, because only the endpoint knows
   * which of its columns are sortable.
   */
  @IsOptional()
  @IsString()
  @Matches(/^-?[a-zA-Z][a-zA-Z0-9]{0,40}$/, {
    message: 'sort must be a field name, optionally prefixed with - for descending',
  })
  sort?: string;
}
