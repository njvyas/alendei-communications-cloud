import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { UpdateBrandingDto } from '../domains/domains.dto';

export class OnboardingAdminUserDto {
  @ApiProperty({
    description: 'Corporate email address for the initial organization administrator',
    example: 'admin@customer1.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiProperty({
    description: 'First name of the organization administrator',
    example: 'Sarah',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName!: string;

  @ApiProperty({
    description: 'Last name of the organization administrator',
    example: 'Connor',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName!: string;

  @ApiPropertyOptional({
    description: 'Phone number in E.164 format',
    example: '+14155552671',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;
}

export class DirectCustomerOnboardingDto {
  @ApiProperty({
    description: 'Display name of the customer organization',
    example: 'Customer 1 Corp',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty({
    description: 'Unique URL-safe identifier slug for the organization',
    example: 'customer1',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(63)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Slug must contain only lowercase letters, numbers, and hyphens',
  })
  slug!: string;

  @ApiPropertyOptional({
    description: 'Registered legal business name',
    example: 'Customer One Corporation Inc.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  legalName?: string;

  @ApiPropertyOptional({
    description: 'Tax identifier or GSTIN',
    example: '27AAAAA0000A1Z5',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  gstin?: string;

  @ApiProperty({
    description: 'Primary administrator account for the customer organization',
  })
  @ValidateNested()
  @Type(() => OnboardingAdminUserDto)
  adminUser!: OnboardingAdminUserDto;

  @ApiPropertyOptional({
    description: 'Preferred subdomain under alendei.io (defaults to organization slug)',
    example: 'customer1',
  })
  @IsOptional()
  @IsString()
  @MaxLength(63)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Subdomain must contain only lowercase letters, numbers, and hyphens',
  })
  subdomain?: string;

  @ApiPropertyOptional({
    description: 'Initial brand styling and presentation configuration',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateBrandingDto)
  brandConfig?: UpdateBrandingDto;
}

export class ResellerCustomerOnboardingDto extends DirectCustomerOnboardingDto {
  @ApiProperty({
    description: 'Target reseller identifier under which customer organization is onboarded',
    example: '01955b0a-7b3b-7411-9a4f-000000000001',
  })
  @IsUUID('7')
  @IsNotEmpty()
  resellerId!: string;
}

export class WhiteLabelCustomerOnboardingDto extends DirectCustomerOnboardingDto {
  @ApiPropertyOptional({
    description: 'White-label reseller identifier (optional, defaults to platform default)',
    example: '01955b0a-7b3b-7411-9a4f-000000000002',
  })
  @IsOptional()
  @IsUUID('7')
  resellerId?: string;

  @ApiProperty({
    description:
      'Custom fully-qualified brand domain to configure (e.g. console.customerbrand.com)',
    example: 'console.customerbrand.com',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  customDomain!: string;
}
