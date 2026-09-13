import { Global, Module } from '@nestjs/common';

import { AuditWriter } from './audit-writer.service';

/**
 * The audit module (`ARCHITECTURE.md` §4: `audit`, a write-only dependency of
 * every other module).
 *
 * Global because every module writes audit records and none should have to
 * re-import it — and, more to the point, because there must be exactly one
 * writer. A second instance would be a second audit path, which is the thing
 * ADR-002 and ADR-003 both exist to prevent.
 *
 * `DatabaseModule` is itself `@Global()`, so `TenantDatabase` is injectable here
 * without an explicit import.
 */
@Global()
@Module({
  providers: [AuditWriter],
  exports: [AuditWriter],
})
export class AuditModule {}
