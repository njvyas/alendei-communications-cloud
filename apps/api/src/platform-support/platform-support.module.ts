import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { PlatformSupportController } from './platform-support.controller';
import { PlatformSupportService } from './platform-support.service';

@Module({
  imports: [DatabaseModule, AuthModule, AuditModule],
  controllers: [PlatformSupportController],
  providers: [PlatformSupportService],
  exports: [PlatformSupportService],
})
export class PlatformSupportModule {}
