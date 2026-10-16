import { IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class SendMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  channelCode!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(100)
  recipient!: string;

  @IsOptional()
  @IsUUID()
  templateId?: string;

  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsObject()
  payload!: Record<string, unknown>;
}
