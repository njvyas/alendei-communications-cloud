import { Module } from '@nestjs/common';

import { AuditLogsController } from './audit-logs.controller';
import { AuditReadService } from './audit-read.service';

/**
 * Audit read (Phase 1B.6.3).
 *
 * Separate from `AuditModule`, which is `@Global()` and owns the **write** path
 * (`AuditWriter` and the redactor). Keeping the read surface out of it preserves
 * a property worth having: every module in the application can write an audit
 * record, and exactly one can read one. Folding the reader into the global
 * module would make `AuditReadService` injectable everywhere, which is precisely
 * the reach a read surface for this table should not have.
 *
 * `AuthorizationService`, `TenantDatabase` and `ListQuery` all arrive from
 * `@Global()` modules and are deliberately not re-imported.
 */
@Module({
  controllers: [AuditLogsController],
  providers: [AuditReadService],
  exports: [AuditReadService],
})
export class AuditReadModule {}
