import { Controller, Get } from '@nestjs/common';
import { SESSION_VARS } from '@acc/db';
import { sql } from 'drizzle-orm';

import { TenantDatabase } from '../src/database/tenant-database.service';

/**
 * A route that exists only to observe, over real HTTP, the tenant context the
 * production `TenantDatabase.withRequestTenant` writes for the authenticated
 * principal (ADR-015 R-7). `AuthGuard`, the scope resolver and the database
 * service are the real ones; only this read-only handler belongs to the test.
 * It reads the seven claims and the tenant-content helper's answer inside the
 * principal's own transaction — no content table and no content route exist.
 */
@Controller('test-content-context')
export class ContentContextProbeController {
  constructor(private readonly db: TenantDatabase) {}

  @Get()
  read() {
    return this.db.withRequestTenant(async (tx) => {
      const names = Object.values(SESSION_VARS);
      const { rows } = await tx.execute<{ name: string; value: string | null }>(sql`
        SELECT n AS name, current_setting(n, true) AS value
        FROM unnest(${`{${names.join(',')}}`}::text[]) AS n`);
      const { rows: valid } = await tx.execute<{ v: boolean }>(
        sql`SELECT app_content_context_valid() AS v`,
      );
      return {
        claims: Object.fromEntries(rows.map((r) => [r.name, r.value])),
        contentContextValid: valid[0]!.v,
      };
    });
  }
}
