import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Optional operator note recorded with a pause or revocation (1–200 characters). */
export class AutomationControlDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  readonly reason?: string;
}
