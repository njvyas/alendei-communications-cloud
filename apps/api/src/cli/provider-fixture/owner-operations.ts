/**
 * The provider-console fixture's only owner-level writes (Phase 2.6 support).
 *
 * Providers go through the real HTTP API. These two operations exist because
 * the architecture has, deliberately, **no** application path for them:
 *
 *  1. **Fixture platform roles.** Platform roles are created only by migration
 *     or seed (D22; the role API is tenant-scoped). One `INSERT` into `roles`
 *     (`org_id` NULL, not a system role, `allowed_scope_types = {platform}`)
 *     and its `role_permissions` rows, with exactly the permissions in
 *     `topology.ts` — never `providers.manage` — and a `role.created` audit row.
 *
 *  2. **Platform personas.** A platform-scope grant is made only by the
 *     bootstrap CLI under its documented elevation (`RBAC.md` §5b); role
 *     assignment cannot represent `platform`. Each persona is created exactly as
 *     the bootstrap creates the platform administrator — `UserLifecycleService`
 *     invite and activate, one `INSERT` into `user_roles` at platform scope,
 *     and `user.invited` and `user_role.granted` audit rows through the
 *     committed `AuditWriter` — but with a fixture role or `alendei_support`,
 *     never `alendei_super_admin`.
 *
 * Each runs as the schema owner in its own transaction, elevated only by the
 * transaction-local `app.is_platform_admin` the bootstrap and the seed use;
 * no trigger is disabled and no policy is changed. Unreachable from the
 * application: imported only by the provider-fixture CLI.
 */
import { AUDIT_ACTIONS } from '@acc/contracts';
import type { Database, Transaction } from '@acc/db';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import type { AuditWriter } from '../../audit/audit-writer.service';
import type { UserLifecycleService } from '../../iam/user-lifecycle.service';
import { FixtureRefusal } from '../dev-fixture/environment';
import {
  PERSONAS,
  PLATFORM_ROLES,
  PROVIDER_FIXTURE_ACTOR_LABEL,
  personaRoleKey,
  type FixtureRoleRef,
  type PersonaRef,
} from './topology';

const ACTOR = {
  actorType: 'system' as const,
  actorUserId: null,
  actorApiKeyId: null,
  actorLabel: PROVIDER_FIXTURE_ACTOR_LABEL,
};
const METADATA = { via: 'provider-fixture-cli' };

async function elevate(tx: Transaction): Promise<void> {
  await tx.execute(sql`select set_config('app.is_platform_admin', 'on', true)`);
}

export async function createFixturePlatformRole(
  db: Database,
  audit: AuditWriter,
  ref: FixtureRoleRef,
): Promise<string> {
  const spec = PLATFORM_ROLES[ref];
  return db.transaction(async (tx) => {
    await elevate(tx);
    const inserted = await tx.execute(
      sql`INSERT INTO roles (org_id, key, name, is_system_role, allowed_scope_types)
          VALUES (NULL, ${spec.key}, ${spec.name}, false, ARRAY['platform']::role_scope_type[])
          ON CONFLICT DO NOTHING RETURNING id`,
    );
    const row = inserted.rows[0] as { id: string } | undefined;
    if (!row) {
      throw new FixtureRefusal(`platform role ${spec.key} appeared during the run; re-run`);
    }
    const permissions = await tx.execute(
      sql`INSERT INTO role_permissions (role_id, permission_id)
          SELECT ${row.id}, id FROM permissions
           WHERE key IN (${sql.join(
             spec.permissions.map((p) => sql`${p}`),
             sql`, `,
           )})
          RETURNING permission_id`,
    );
    if (permissions.rows.length !== spec.permissions.length) {
      throw new FixtureRefusal(`a permission of ${spec.key} is missing from the catalogue`);
    }
    await audit.record(
      {
        ...ACTOR,
        scopeType: 'platform',
        scopeId: null,
        action: AUDIT_ACTIONS.ROLE_CREATED,
        resourceType: 'Role',
        resourceId: row.id,
        outcome: 'success',
        before: null,
        after: {
          key: spec.key,
          name: spec.name,
          allowedScopeTypes: ['platform'],
          permissions: [...spec.permissions],
        },
        metadata: METADATA,
        correlationId: uuidv7(),
      },
      tx,
    );
    return row.id;
  });
}

export async function createPlatformPersona(
  db: Database,
  users: UserLifecycleService,
  audit: AuditWriter,
  ref: PersonaRef,
  roleId: string,
  password: string,
): Promise<string> {
  const email = PERSONAS[ref].email;
  return db.transaction(async (tx) => {
    await elevate(tx);
    if (await users.findByEmail(tx, email)) {
      throw new FixtureRefusal(`persona ${email} appeared during the run; re-run`);
    }
    const invited = await users.invite(tx, email);
    const activated = await users.activate(tx, invited.id, password);
    await tx.execute(
      sql`INSERT INTO user_roles (user_id, role_id, scope_type, scope_id)
          VALUES (${activated.id}, ${roleId}, 'platform', NULL)`,
    );
    const correlationId = uuidv7();
    await audit.record(
      {
        ...ACTOR,
        scopeType: 'platform',
        scopeId: null,
        action: AUDIT_ACTIONS.USER_INVITED,
        resourceType: 'user',
        resourceId: activated.id,
        outcome: 'success',
        before: null,
        after: { email: activated.email, status: activated.status },
        metadata: METADATA,
        correlationId,
      },
      tx,
    );
    await audit.record(
      {
        ...ACTOR,
        scopeType: 'platform',
        scopeId: null,
        action: AUDIT_ACTIONS.USER_ROLE_GRANTED,
        resourceType: 'user_role',
        resourceId: activated.id,
        outcome: 'success',
        before: null,
        after: { roleKey: personaRoleKey(ref), scopeType: 'platform' },
        metadata: METADATA,
        correlationId,
      },
      tx,
    );
    return activated.id;
  });
}
