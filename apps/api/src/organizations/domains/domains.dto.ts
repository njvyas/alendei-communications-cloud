import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { DOMAIN_TYPES, type DomainType } from '@acc/contracts';

export class ResolveDomainQueryDto {
  @ApiProperty({
    description: 'The incoming HTTP hostname to resolve branding and portal configuration for',
    example: 'customer1.alendei.io',
  })
  @IsString()
  @IsNotEmpty()
  hostname!: string;
}

export class RegisterDomainDto {
  @ApiProperty({
    description: 'The fully-qualified domain name or subdomain to register',
    example: 'customer1.alendei.io',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  domain!: string;

  @ApiPropertyOptional({
    description: 'Domain type: subdomain (*.alendei.io) or custom FQDN',
    enum: DOMAIN_TYPES,
    example: 'subdomain',
  })
  @IsOptional()
  @IsIn(DOMAIN_TYPES)
  domainType?: DomainType;

  @ApiPropertyOptional({
    description: 'Whether to designate this domain as the primary domain for the organization',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class UpdateBrandingDto {
  @ApiPropertyOptional({
    description: 'Human-readable brand or company display name',
    example: 'Acme Telecommunications',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  brandName?: string;

  @ApiPropertyOptional({
    description: 'Public URL to brand logo image',
    example: 'https://cdn.example.com/logo.png',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  logoUrl?: string;

  @ApiPropertyOptional({
    description: 'Public URL to brand favicon',
    example: 'https://cdn.example.com/favicon.ico',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  faviconUrl?: string;

  @ApiPropertyOptional({
    description: 'Primary brand accent color in hex format (#rrggbb or #rgb)',
    example: '#0ea5e9',
  })
  @IsOptional()
  @IsString()
  @Matches(/^#(?:[0-9a-fA-F]{3}){1,2}$/, {
    message: 'primaryColor must be a valid hex color string (e.g. #0ea5e9)',
  })
  primaryColor?: string;

  @ApiPropertyOptional({
    description: 'Secondary brand accent color in hex format (#rrggbb or #rgb)',
    example: '#38bdf8',
  })
  @IsOptional()
  @IsString()
  @Matches(/^#(?:[0-9a-fA-F]{3}){1,2}$/, {
    message: 'accentColor must be a valid hex color string',
  })
  accentColor?: string;

  @ApiPropertyOptional({
    description: 'Customer-facing support contact email address',
    example: 'support@acme.com',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  supportEmail?: string;

  @ApiPropertyOptional({
    description: 'Customer-facing support contact phone number',
    example: '+18005550199',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  supportPhone?: string;

  @ApiPropertyOptional({
    description: 'URL to privacy policy document',
    example: 'https://acme.com/privacy',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  privacyPolicyUrl?: string;

  @ApiPropertyOptional({
    description: 'URL to terms of service document',
    example: 'https://acme.com/terms',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  termsOfServiceUrl?: string;

  @ApiPropertyOptional({
    description: 'Custom CSS rules for branded portal styling',
    example: ':root { --custom-radius: 8px; }',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  customCss?: string;
}

export class DomainTransitionDto {
  @ApiPropertyOptional({
    description: 'Operator reason for domain state transition',
    example: 'Routine maintenance',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
