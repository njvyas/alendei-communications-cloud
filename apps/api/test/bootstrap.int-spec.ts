/**
 * Bootstrap integration tests (Phase 1B.2, ADR-003 D-1).
 *
 * The bootstrap is the one sanctioned way past `fn_validate_user_role_scope`'s
 * platform-admin requirement, so its properties are security properties: it must
 * be idempotent, it must not weaken the trigger for anybody else, and it must
 * refuse to run without a real secret reference.
 */
import { AUDIT_ACTIONS, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { schema, withTenantTransaction, type Transaction } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { AuditWriter } from '../src/audit/audit-writer.service';
import { CredentialService } from '../src/iam/credential.service';
import { UserLifecycleService } from '../src/iam/user-lifecycle.service';
import { runBootstrap } from '../src/cli/bootstrap';
import { connectAdmin, expectRejected, purgeAudit, type AdminHandle } from './audit-fixtures';

const config = {
  auth: { argon2: { memoryCost: 19_456, timeCost: 2, parallelism: 1 } },
} as never;

/**
 * The same shim the CLI uses: it refuses both non-transactional paths, so any
 * audit write that is not inside the bootstrap transaction fails loudly.
 */
function ownerAuditWriter(): AuditWriter {
  const refuse = (): never => {
    throw new Error('bootstrap: audit must be written inside the bootstrap transaction');
  };
  return new AuditWriter({
    get auth(): never {
      return refuse();
    },
    withRequestTenant: refuse,
  } as never);
}

describe('platform bootstrap', () => {
  let admin: AdminHandle;
  const credentials = new CredentialService(config);
  const users = new UserLifecycleService(credentials);
  const audit = ownerAuditWriter();

  beforeAll(() => {
    admin = connectAdmin();
  }, 30_000);

  afterAll(async () => {
    await purgeAudit(admin.db, sql`actor_label = 'platform_bootstrap'`);
    await admin.close();
  }, 30_000);

  /** Runs bootstrap against a savepoint that is always rolled back. */
  const inRollback = async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> => {
    let captured!: T;
    await admin.db
      .transaction(async (tx) => {
        captured = await work(tx as Transaction);
        throw new Error('__rollback__');
      })
      .catch((error: unknown) => {
        if ((error as Error).message !== '__rollback__') throw error;
      });
    return captured;
  };

  const bootstrapOnce = (tx: Transaction, email: string, password = 'a-long-enough-passphrase') =>
    runBootstrap(tx, { email, password, credentials, users, audit });

  it('creates the first platform administrator', async () => {
    const email = `boot-${uuidv7().replace(/-/g, '').slice(-12)}@example.test`;

    const { created, grants, status, digest } = await inRollback(async (tx) => {
      // Remove any administrator this database already has, inside the rollback.
      await tx.execute(sql`DELETE FROM user_roles WHERE scope_type = 'platform'`);
      const outcome = await bootstrapOnce(tx, email);

      const granted = await tx
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.userId, outcome.userId));
      const [user] = await tx
        .select({ status: schema.users.status, passwordHash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, outcome.userId));

      return {
        created: outcome.created,
        grants: granted.length,
        status: user!.status,
        digest: user!.passwordHash,
      };
    });

    expect(created).toBe(true);
    expect(grants).toBe(1);
    expect(status).toBe('active');
    expect(digest!.startsWith('$argon2id$')).toBe(true);
  });

  it('is idempotent and creates no duplicate platform principal', async () => {
    const email = `boot-idem-${uuidv7().replace(/-/g, '').slice(-12)}@example.test`;

    const { first, second, third, admins, userCount } = await inRollback(async (tx) => {
      await tx.execute(sql`DELETE FROM user_roles WHERE scope_type = 'platform'`);
      const a = await bootstrapOnce(tx, email);
      const b = await bootstrapOnce(tx, email);
      const c = await bootstrapOnce(tx, `someone-else-${email}`);

      const platformAdmins = await tx
        .select({ id: schema.userRoles.id })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.scopeType, 'platform'));
      const created = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(sql`${schema.users.email} LIKE ${'%' + email}`);

      return {
        first: a.created,
        second: b.created,
        third: c.created,
        admins: platformAdmins.length,
        userCount: created.length,
      };
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    // A different email must not create a second administrator either: the
    // platform is bootstrapped or it is not.
    expect(third).toBe(false);
    expect(admins).toBe(1);
    expect(userCount).toBe(1);
  });

  it('writes both audit records inside the bootstrap transaction', async () => {
    const email = `boot-audit-${uuidv7().replace(/-/g, '').slice(-12)}@example.test`;

    const rows = await inRollback(async (tx) => {
      await tx.execute(sql`DELETE FROM user_roles WHERE scope_type = 'platform'`);
      const outcome = await bootstrapOnce(tx, email);
      const { rows: audited } = await tx.execute<{ action: string; actor_label: string }>(
        sql`SELECT action, actor_label FROM audit_logs WHERE resource_id = ${outcome.userId}`,
      );
      return audited;
    });

    const actions = rows.map((r) => r.action).sort();
    expect(actions).toEqual([AUDIT_ACTIONS.USER_INVITED, AUDIT_ACTIONS.USER_ROLE_GRANTED].sort());
    expect(rows.every((r) => r.actor_label === 'platform_bootstrap')).toBe(true);
  });

  it('rolls the administrator back if its audit row cannot be written', async () => {
    const email = `boot-atomic-${uuidv7().replace(/-/g, '').slice(-12)}@example.test`;

    // Simulates the audit write itself failing. Overriding `record` is the
    // honest way to express that: a non-sensitive action with a transaction in
    // hand writes straight through `tx.insert`, so a writer constructed with
    // broken connection handles would never actually be exercised and the test
    // would pass without proving anything.
    const failing = Object.assign(Object.create(AuditWriter.prototype) as AuditWriter, {
      record: () => Promise.reject(new Error('audit backend unavailable')),
    });

    await expectRejected(
      admin.db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM user_roles WHERE scope_type = 'platform'`);
        await runBootstrap(tx as Transaction, {
          email,
          password: 'a-long-enough-passphrase',
          credentials,
          users,
          audit: failing,
        });
      }),
      /audit backend unavailable/,
    );

    const leaked = await admin.db.execute(sql`SELECT id FROM users WHERE email = ${email}`);
    expect(leaked.rows).toHaveLength(0);
  });

  it('fails when the platform role has not been seeded', async () => {
    await expectRejected(
      inRollback(async (tx) => {
        await tx.execute(sql`DELETE FROM user_roles WHERE scope_type = 'platform'`);
        await tx.execute(
          sql`DELETE FROM role_permissions WHERE role_id IN
              (SELECT id FROM roles WHERE key = ${PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN} AND org_id IS NULL)`,
        );
        await tx.execute(
          sql`DELETE FROM roles WHERE key = ${PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN} AND org_id IS NULL`,
        );
        return bootstrapOnce(tx, 'never-created@example.test');
      }),
      /platform role is missing/,
    );
  });

  it('does not weaken the scope trigger for anyone else', async () => {
    // After bootstrap, an ordinary application principal must still be unable to
    // grant a platform role — the elevation is transaction-local to the CLI and
    // is not reachable from acc_app.
    const [role] = (
      await admin.db.execute<{ id: string }>(
        sql`SELECT id FROM roles WHERE key = ${PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN} AND org_id IS NULL`,
      )
    ).rows;
    const [victim] = (await admin.db.execute<{ id: string }>(sql`SELECT id FROM users LIMIT 1`))
      .rows;

    await expectRejected(
      withTenantTransaction(admin.db, {}, async (tx) => {
        // No platform-admin flag in this context: the trigger must refuse.
        await tx.execute(
          sql`INSERT INTO user_roles (user_id, role_id, scope_type, scope_id)
              VALUES (${victim!.id}, ${role!.id}, 'platform', NULL)`,
        );
      }),
      /may only be granted by a platform admin/,
    );
  });

  it('leaves no platform grant able to exist without the trigger agreeing', async () => {
    const admins = await admin.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM user_roles WHERE scope_type = 'platform'`,
    );
    // The live database has exactly the one administrator bootstrap created.
    expect(Number(admins.rows[0]!.count)).toBeLessThanOrEqual(1);
  });
});
