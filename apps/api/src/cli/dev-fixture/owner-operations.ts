/**
 * The fixture's only owner-level writes (Phase 1C.4a, D2 and D3).
 *
 * Everything else the fixture creates — organizations, workspaces, teams,
 * users and every role grant — goes through the real HTTP API as a signed-in
 * platform administrator. These two operations exist because the current
 * architecture has **no** application path for them:
 *
 *  1. **Reseller B.** Reseller CRUD is deferred to Phase 9; there is no route,
 *     service or permission that creates a reseller. `seed.ts` creates only the
 *     platform-default reseller. One `INSERT` into `resellers` (`name`, `slug`;
 *     `status` and `is_platform_default` take their defaults, `active` and
 *     `false`), and only when no reseller with the fixture slug exists — it
 *     never updates an existing reseller. There is no reseller audit action, so
 *     no audit row is written, exactly as for the seeded reseller.
 *
 *  2. **Credential activation.** `POST /users` creates an `invited` identity
 *     with no credential, and how an invited user comes to hold one is not
 *     specified (`UserLifecycleService`; no invitation-acceptance route
 *     exists). The fixture sets the password with the same
 *     `UserLifecycleService.activate` the bootstrap CLI uses: `users.password_hash`,
 *     `users.password_updated_at` and `users.status` (`invited` → `active`) for
 *     one fixture identity that is still `invited` and has no credential.
 *     There is no activation audit action either; the identity's creation is
 *     audited (`user.invited`) by the API.
 *
 * Both run as the schema owner (`DATABASE_ADMIN_URL`) in their own short
 * transaction, touch no other table or column, set no tenant or platform
 * session variable, and are unreachable from the application: this file is
 * imported only by the fixture CLI.
 */
import type { Database } from '@acc/db';
import { sql } from 'drizzle-orm';

import type { UserLifecycleService } from '../../iam/user-lifecycle.service';
import { FixtureRefusal } from './environment';
import { FIXTURE_EMAIL_DOMAIN, RESELLERS } from './topology';

export async function createFixtureReseller(db: Database): Promise<string> {
  const spec = RESELLERS.B;
  return db.transaction(async (tx) => {
    const inserted = await tx.execute(
      sql`INSERT INTO resellers (name, slug) VALUES (${spec.name}, ${spec.slug})
          ON CONFLICT (slug) DO NOTHING RETURNING id`,
    );
    const row = inserted.rows[0] as { id: string } | undefined;
    if (!row) {
      // Created concurrently since inspection: refuse rather than adopt it.
      throw new FixtureRefusal(
        `reseller ${spec.slug} appeared during the run; re-run to re-inspect`,
      );
    }
    return row.id;
  });
}

export async function activateFixtureUser(
  db: Database,
  users: UserLifecycleService,
  userId: string,
  password: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT email, status::text AS status, password_hash IS NOT NULL AS "hasCredential"
            FROM users WHERE id = ${userId} FOR UPDATE`,
    );
    const row = locked.rows[0] as
      { email: string; status: string; hasCredential: boolean } | undefined;
    if (!row || !row.email.toLowerCase().endsWith(`@${FIXTURE_EMAIL_DOMAIN}`)) {
      throw new FixtureRefusal(`user ${userId} is not a fixture identity`);
    }
    if (row.status !== 'invited' || row.hasCredential) {
      throw new FixtureRefusal(
        `fixture user ${row.email} is no longer invited and credential-less; refusing to overwrite`,
      );
    }
    await users.activate(tx, userId, password);
  });
}
