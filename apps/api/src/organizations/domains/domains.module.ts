import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { AuthModule } from '../../auth/auth.module';
import { DatabaseModule } from '../../database/database.module';
import { DomainsController } from './domains.controller';
import { DomainsService } from './domains.service';
import { PlatformDomainsModule } from './oversight/platform-domains.module';

@Module({
  imports: [DatabaseModule, AuthModule, AuditModule, PlatformDomainsModule],
  controllers: [DomainsController],
  providers: [DomainsService],
  exports: [DomainsService, PlatformDomainsModule],
})
export class DomainsModule {}
