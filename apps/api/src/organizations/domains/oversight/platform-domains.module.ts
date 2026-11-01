import { Module } from '@nestjs/common';

import { AuthModule } from '../../../auth/auth.module';
import { DatabaseModule } from '../../../database/database.module';
import { DnsDiagnosticsProbe } from './dns-diagnostics.probe';
import { PlatformDomainsController } from './platform-domains.controller';
import { PlatformDomainsService } from './platform-domains.service';

/** Platform domain oversight (Phase 4, U13.3). Read-only. */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [PlatformDomainsController],
  providers: [PlatformDomainsService, DnsDiagnosticsProbe],
  exports: [PlatformDomainsService, DnsDiagnosticsProbe],
})
export class PlatformDomainsModule {}
