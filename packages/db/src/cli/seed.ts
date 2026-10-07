/**
 * Seeds platform-level reference data. Idempotent: safe to run repeatedly.
 *
 *   1. the permission catalogue (`RBAC.md` §1), with each key's classification
 *      and allowed-scope set (ADR-015 R-5)
 *   2. the fixed platform roles and their permissions (`RBAC.md` §3)
 *   3. the "Alendei Direct" reseller (`TENANCY.md` §1)
 *
 * Tenant-configurable roles are not seeded here: they are created per
 * organization when that organization is provisioned (`RBAC.md` §4).
 */
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import {
  ALL_PERMISSION_KEYS,
  PERMISSION_ALLOWED_SCOPES,
  PERMISSION_CLASS,
  PLATFORM_ROLE_DEFINITIONS,
  splitPermissionKey,
} from '@acc/contracts';
import { PLATFORM_DEFAULT_RESELLER_SLUG } from '../constants';
import * as schema from '../schema';
import { loadCliEnv, requireEnv } from './_env';

async function main(): Promise<void> {
  loadCliEnv();
  const pool = new Pool({
    connectionString: requireEnv('DATABASE_ADMIN_URL'),
    max: 1,
    application_name: 'acc-seed',
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });

  try {
    await db.transaction(async (tx) => {
      // Seeding platform roles trips `fn_validate_user_role_scope`'s
      // platform-admin requirement, so the bootstrap declares itself as such.
      // This is the schema owner performing a documented bootstrap, not a
      // request-derived privilege.
      await tx.execute(sql`select set_config('app.is_platform_admin', 'on', true)`);

      // Classification and allowed scopes come from packages/contracts, on
      // insert and on every re-run (ADR-015 R-5). A wrong definition fails
      // loudly here: the permissions CHECKs refuse an impossible
      // classification, and `fn_permissions_guard_scope_eligibility` refuses a
      // scope set that a role already carrying the key would be ineligible for.
      for (const key of ALL_PERMISSION_KEYS) {
        const { domain, action } = splitPermissionKey(key);
        const classification = PERMISSION_CLASS[key];
        const allowedScopeTypes = [...PERMISSION_ALLOWED_SCOPES[key]];
        await tx
          .insert(schema.permissions)
          .values({ key, domain, action, classification, allowedScopeTypes })
          .onConflictDoUpdate({
            target: schema.permissions.key,
            set: { domain, action, classification, allowedScopeTypes },
          });
      }
      console.log(`Permissions seeded: ${ALL_PERMISSION_KEYS.length}`);

      for (const definition of PLATFORM_ROLE_DEFINITIONS) {
        const [role] = await tx
          .insert(schema.roles)
          .values({
            orgId: null,
            key: definition.key,
            name: definition.name,
            description: definition.description,
            isSystemRole: true,
            allowedScopeTypes: [...definition.allowedScopeTypes],
          })
          .onConflictDoUpdate({
            target: schema.roles.key,
            targetWhere: sql`${schema.roles.orgId} IS NULL`,
            set: {
              name: definition.name,
              description: definition.description,
              allowedScopeTypes: [...definition.allowedScopeTypes],
            },
          })
          .returning({ id: schema.roles.id });

        if (!role) {
          throw new Error(`failed to upsert platform role ${definition.key}`);
        }

        // Rebuild the grant set so a removed permission is actually removed.
        await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, role.id));
        for (const permissionKey of definition.permissions) {
          const permission = await tx.query.permissions.findFirst({
            where: eq(schema.permissions.key, permissionKey),
            columns: { id: true },
          });
          if (!permission) {
            throw new Error(`permission ${permissionKey} missing from catalogue`);
          }
          await tx
            .insert(schema.rolePermissions)
            .values({ roleId: role.id, permissionId: permission.id })
            .onConflictDoNothing();
        }
        console.log(
          `Platform role seeded: ${definition.key} (${definition.permissions.length} permissions)`,
        );
      }

      await tx
        .insert(schema.resellers)
        .values({
          name: 'Alendei Direct',
          slug: PLATFORM_DEFAULT_RESELLER_SLUG,
          isPlatformDefault: true,
          status: 'active',
        })
        .onConflictDoNothing({ target: schema.resellers.slug });
      console.log('Default reseller seeded: Alendei Direct');
    });
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exitCode = 1;
});
