/**
 * Audit write path integration tests (Phase 1B.1, ADR-002/ADR-003).
 *
 * Exercised against a real database because everything under test lives there:
 * the scope-derivation trigger, the `acc_auth` confinement policy, RLS, and the
 * append-only guard. None of it can be demonstrated against a mock.
 */
import {
  ANONYMOUS_LOGIN_ACTOR_LABEL,
  AUDIT_ACTIONS,
  AUTH_ROLE_AUDIT_ACTIONS,
  anonymousLoginFailureActor,
  isSecuritySensitiveAction,
  type AuditRecordInput,
} from '@acc/contracts';
import { schema, withTenantTransaction, type Database, type TenantSession } from '@acc/db';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { AppModule } from '../src/app.module';
import { AuditWriter, type AuditWriteInput } from '../src/audit/audit-writer.service';
import { APP_DB, AUTH_DB } from '../src/database/database.tokens';
import { RequestContext } from '../src/common/context/request-context';
import {
  connectAdmin,
  createTenant,
  destroyTenant,
  expectRejected,
  purgeAudit,
  type AdminHandle,
  type TenantFixture,
} from './audit-fixtures';

/** A complete, valid record; individual tests override only what they test. */
function record(over: Partial<AuditRecordInput> = {}): AuditWriteInput {
  return {
    scopeType: 'platform',
    scopeId: null,
    actorType: 'system',
    actorUserId: null,
    actorApiKeyId: null,
    actorLabel: 'phase-1b-1-test',
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    resourceType: 'organization',
    resourceId: null,
    outcome: 'success',
    before: null,
    after: null,
    metadata: {},
    correlationId: uuidv7(),
    causationId: null,
    ip: null,
    userAgent: null,
    ...over,
  };
}

describe('AuditWriter', () => {
  let admin: AdminHandle;
  let writer: AuditWriter;
  let appDb: Database;
  let authDb: Database;
  let close: () => Promise<void>;
  let orgA: TenantFixture;
  let orgB: TenantFixture;

  const asTenant = <T>(session: TenantSession, work: Parameters<typeof withTenantTransaction>[2]) =>
    withTenantTransaction(appDb, session, work) as Promise<T>;

  beforeAll(async () => {
    admin = connectAdmin();
    orgA = await createTenant(admin.db, 'aw-a');
    orgB = await createTenant(admin.db, 'aw-b');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    writer = app.get(AuditWriter);
    appDb = app.get<Database>(APP_DB);
    authDb = app.get<Database>(AUTH_DB);
    close = () => app.close();
  }, 30_000);

  afterAll(async () => {
    await destroyTenant(admin.db, orgA);
    await destroyTenant(admin.db, orgB);
    await close?.();
    await admin.close();
  }, 30_000);

  const rowsFor = async (correlationId: string) => {
    const { rows } = await admin.db.execute<Record<string, unknown>>(
      sql`SELECT * FROM audit_logs WHERE correlation_id = ${correlationId}`,
    );
    return rows;
  };

  // ---------------------------------------------------------------------------
  // Action routing
  // ---------------------------------------------------------------------------
  describe('action routing', () => {
    afterEach(() => purgeAudit(admin.db, sql`action LIKE 'auth.%' OR action LIKE 'api_key.%'`));

    it.each([...AUTH_ROLE_AUDIT_ACTIONS])('routes %s through acc_auth', async (action) => {
      const correlationId = uuidv7();
      // No tenant transaction is opened: acc_auth runs before one exists. A
      // write that succeeded here through acc_app would need a principal.
      await writer.record(
        record({
          action,
          correlationId,
          actorType: 'user',
          actorUserId: orgA.userId,
          actorLabel: null,
          resourceType: 'auth',
          outcome: 'success',
        }),
      );

      const rows = await rowsFor(correlationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.scope_type).toBe('platform');
      expect(rows[0]!.org_id).toBeNull();
    });

    it('routes an ordinary tenant action through acc_app inside the caller transaction', async () => {
      const correlationId = uuidv7();
      await asTenant({ orgId: orgA.orgId }, async (tx) => {
        await writer.record(
          record({
            scopeType: 'organization',
            scopeId: orgA.orgId,
            correlationId,
          }),
          tx,
        );
      });

      const rows = await rowsFor(correlationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.org_id).toBe(orgA.orgId);
      await purgeAudit(admin.db, sql`correlation_id = ${correlationId}`);
    });

    it('refuses a tenant action through acc_auth', async () => {
      // Proves the confinement is the database's, not the writer's routing:
      // going directly to the acc_auth principal must still be refused.
      await expectRejected(
        authDb.insert(schema.auditLogs).values({
          scopeType: 'organization',
          scopeId: orgA.orgId,
          actorType: 'user',
          actorUserId: orgA.userId,
          action: AUDIT_ACTIONS.USER_ROLE_GRANTED,
          resourceType: 'role',
          outcome: 'success',
          correlationId: uuidv7(),
        }),
        /row-level security/,
      );
    });

    it('refuses a non-auth action through acc_auth even at platform scope', async () => {
      await expectRejected(
        authDb.insert(schema.auditLogs).values({
          scopeType: 'platform',
          actorType: 'user',
          actorUserId: orgA.userId,
          action: AUDIT_ACTIONS.USER_ROLE_GRANTED,
          resourceType: 'role',
          outcome: 'success',
          correlationId: uuidv7(),
        }),
        /row-level security/,
      );
    });

    it('keeps the security-sensitive classification usable without branching on it', () => {
      // ADR-003 D-2: the classification is retained as metadata for Phase 2's
      // outbox routing; in Phase 1B it must not create a second execution path.
      expect(isSecuritySensitiveAction(AUDIT_ACTIONS.USER_ROLE_GRANTED)).toBe(true);
      expect(isSecuritySensitiveAction(AUDIT_ACTIONS.ORGANIZATION_UPDATED)).toBe(false);
    });

    it('refuses to write a security-sensitive action outside a transaction', async () => {
      await expectRejected(
        writer.record(
          record({
            scopeType: 'organization',
            scopeId: orgA.orgId,
            action: AUDIT_ACTIONS.USER_ROLE_GRANTED,
            resourceType: 'role',
          }),
        ),
        /must be recorded inside the transaction/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // R4 — the anonymous login-failure actor
  // ---------------------------------------------------------------------------
  describe('anonymous login failure (R4)', () => {
    afterEach(() => purgeAudit(admin.db, sql`action = 'auth.login.failed'`));

    const anonymous = (over: Partial<AuditRecordInput> = {}): AuditWriteInput =>
      record({
        ...anonymousLoginFailureActor(),
        action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        resourceType: 'auth',
        outcome: 'failure',
        ...over,
      });

    it('1. accepts system + anonymous_login_attempt + auth.login.failed at platform scope', async () => {
      const correlationId = uuidv7();
      await writer.record(anonymous({ correlationId }));

      const rows = await rowsFor(correlationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_type).toBe('system');
      expect(rows[0]!.actor_label).toBe(ANONYMOUS_LOGIN_ACTOR_LABEL);
      expect(rows[0]!.actor_user_id).toBeNull();
      expect(rows[0]!.actor_api_key_id).toBeNull();
      expect(rows[0]!.scope_type).toBe('platform');
      expect(rows[0]!.org_id).toBeNull();
      expect(rows[0]!.outcome).toBe('failure');
    });

    it('2. denies system with an arbitrary label', async () => {
      await expectRejected(
        writer.record(anonymous({ actorLabel: 'not_the_approved_label' })),
        /row-level security/,
      );
    });

    it('2b. denies system with no label at all', async () => {
      await expectRejected(writer.record(anonymous({ actorLabel: null })), /row-level security/);
    });

    it('3. denies system + anonymous label on a different auth action', async () => {
      await expectRejected(
        writer.record(anonymous({ action: AUDIT_ACTIONS.AUTH_LOGOUT, outcome: 'success' })),
        /row-level security/,
      );
    });

    it.each([
      ['organization', () => orgA.orgId],
      ['workspace', () => orgA.workspaceId],
      ['team', () => orgA.teamId],
    ])('4-6. denies the anonymous actor at %s scope', async (scopeType, scopeId) => {
      await expectRejected(
        writer.record(
          anonymous({
            scopeType: scopeType as AuditRecordInput['scopeType'],
            scopeId: scopeId(),
          }),
        ),
        /row-level security/,
      );
    });

    it('7. denies the system actor writing an arbitrary action through acc_auth', async () => {
      await expectRejected(
        authDb.insert(schema.auditLogs).values({
          scopeType: 'platform',
          actorType: 'system',
          actorLabel: ANONYMOUS_LOGIN_ACTOR_LABEL,
          action: AUDIT_ACTIONS.USER_ROLE_GRANTED,
          resourceType: 'role',
          outcome: 'success',
          correlationId: uuidv7(),
        }),
        /row-level security/,
      );
    });

    it('records a known-user failure with the real identity, not the anonymous form', async () => {
      const correlationId = uuidv7();
      await writer.record(
        record({
          action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
          actorType: 'user',
          actorUserId: orgA.userId,
          actorLabel: null,
          resourceType: 'auth',
          outcome: 'failure',
          correlationId,
        }),
      );

      const rows = await rowsFor(correlationId);
      expect(rows[0]!.actor_type).toBe('user');
      expect(rows[0]!.actor_user_id).toBe(orgA.userId);
      expect(rows[0]!.actor_label).toBeNull();
    });

    it('keeps the contract constant and the database policy in agreement', async () => {
      // The policy hard-codes the label. If the contract value is changed
      // without the matching migration, the anonymous path silently stops
      // working — this fails first instead.
      const { rows } = await admin.db.execute<{ with_check: string }>(
        sql`SELECT with_check FROM pg_policies
            WHERE tablename = 'audit_logs' AND policyname = 'audit_logs_auth_insert'`,
      );
      expect(rows[0]!.with_check).toContain(ANONYMOUS_LOGIN_ACTOR_LABEL);
      expect(rows[0]!.with_check).toContain(AUDIT_ACTIONS.AUTH_LOGIN_FAILED);
    });
  });

  // ---------------------------------------------------------------------------
  // Scope derivation
  // ---------------------------------------------------------------------------
  describe('scope derivation', () => {
    afterEach(() => purgeAudit(admin.db, sql`true`));

    it('derives nothing at platform scope', async () => {
      const correlationId = uuidv7();
      await asTenant({ isPlatformAdmin: true }, (tx) =>
        writer.record(record({ correlationId }), tx),
      );
      const row = (await rowsFor(correlationId))[0]!;
      expect([row.reseller_id, row.org_id, row.workspace_id, row.team_id]).toEqual([
        null,
        null,
        null,
        null,
      ]);
    });

    it('derives reseller_id at reseller scope', async () => {
      const correlationId = uuidv7();
      await asTenant({ resellerId: orgA.resellerId }, (tx) =>
        writer.record(
          record({ scopeType: 'reseller', scopeId: orgA.resellerId, correlationId }),
          tx,
        ),
      );
      const row = (await rowsFor(correlationId))[0]!;
      expect(row.reseller_id).toBe(orgA.resellerId);
      expect([row.org_id, row.workspace_id, row.team_id]).toEqual([null, null, null]);
    });

    it('derives org_id at organization scope', async () => {
      const correlationId = uuidv7();
      await asTenant({ orgId: orgA.orgId }, (tx) =>
        writer.record(
          record({ scopeType: 'organization', scopeId: orgA.orgId, correlationId }),
          tx,
        ),
      );
      const row = (await rowsFor(correlationId))[0]!;
      expect(row.org_id).toBe(orgA.orgId);
      expect([row.reseller_id, row.workspace_id, row.team_id]).toEqual([null, null, null]);
    });

    it('derives the org chain at workspace scope', async () => {
      const correlationId = uuidv7();
      await asTenant({ orgId: orgA.orgId }, (tx) =>
        writer.record(
          record({ scopeType: 'workspace', scopeId: orgA.workspaceId, correlationId }),
          tx,
        ),
      );
      const row = (await rowsFor(correlationId))[0]!;
      expect(row.org_id).toBe(orgA.orgId);
      expect(row.workspace_id).toBe(orgA.workspaceId);
      expect(row.team_id).toBeNull();
    });

    it('derives the full chain at team scope', async () => {
      const correlationId = uuidv7();
      await asTenant({ orgId: orgA.orgId }, (tx) =>
        writer.record(record({ scopeType: 'team', scopeId: orgA.teamId, correlationId }), tx),
      );
      const row = (await rowsFor(correlationId))[0]!;
      expect(row.org_id).toBe(orgA.orgId);
      expect(row.workspace_id).toBe(orgA.workspaceId);
      expect(row.team_id).toBe(orgA.teamId);
    });

    it('gives a caller no way to state tenancy at all', () => {
      // The structural guarantee behind the test below: the contract the writer
      // accepts has no tenancy field to populate.
      const keys = Object.keys(record());
      for (const forbidden of ['orgId', 'workspaceId', 'teamId', 'resellerId']) {
        expect(keys).not.toContain(forbidden);
      }
    });

    it('ignores tenancy columns smuggled past the type system', async () => {
      const correlationId = uuidv7();
      const smuggled = {
        ...record({ scopeType: 'workspace', scopeId: orgA.workspaceId, correlationId }),
        orgId: orgB.orgId,
        workspaceId: orgB.workspaceId,
        teamId: orgB.teamId,
        resellerId: orgB.resellerId,
      } as AuditWriteInput;

      await asTenant({ orgId: orgA.orgId }, (tx) => writer.record(smuggled, tx));

      const row = (await rowsFor(correlationId))[0]!;
      expect(row.org_id).toBe(orgA.orgId);
      expect(row.workspace_id).toBe(orgA.workspaceId);
      expect(row.reseller_id).toBeNull();
      expect(row.team_id).toBeNull();
    });

    it('refuses to record against a tenant the writer is not acting in', async () => {
      await expectRejected(
        asTenant({ orgId: orgA.orgId }, (tx) =>
          writer.record(record({ scopeType: 'organization', scopeId: orgB.orgId }), tx),
        ),
        /row-level security/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Redaction, applied through the writer
  // ---------------------------------------------------------------------------
  describe('redaction through the writer', () => {
    afterEach(() => purgeAudit(admin.db, sql`true`));

    it('redacts before, after and metadata alike', async () => {
      const correlationId = uuidv7();
      await asTenant({ orgId: orgA.orgId }, (tx) =>
        writer.record(
          record({
            scopeType: 'organization',
            scopeId: orgA.orgId,
            correlationId,
            before: { email: 'a@b.test', password_hash: 'argon2id$before' },
            after: { email: 'a@b.test', password_hash: 'argon2id$after' },
            metadata: { keys: [{ key_hash: 'kh' }], nested: { refreshToken: 'rt' } },
          }),
          tx,
        ),
      );

      const row = (await rowsFor(correlationId))[0]!;
      const serialized = JSON.stringify([row.before, row.after, row.metadata]);
      for (const secret of ['argon2id$before', 'argon2id$after', 'kh', 'rt']) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).toContain('a@b.test');
      expect(serialized).toContain('[redacted]');
    });
  });

  // ---------------------------------------------------------------------------
  // Request context
  // ---------------------------------------------------------------------------
  describe('request context', () => {
    afterEach(() => purgeAudit(admin.db, sql`true`));

    it('takes correlation, causation, ip and user-agent from the ambient request', async () => {
      const correlationId = uuidv7();
      const causationId = uuidv7();

      await RequestContext.run(
        {
          correlationId,
          requestId: uuidv7(),
          causationId,
          traceId: null,
          principal: null,
          ip: '198.51.100.7',
          userAgent: 'acc-tests/1.0',
        },
        async () => {
          await asTenant({ orgId: orgA.orgId }, (tx) =>
            writer.record(
              // Deliberately omits all four: the writer must resolve them.
              {
                scopeType: 'organization',
                scopeId: orgA.orgId,
                actorType: 'system',
                actorUserId: null,
                actorApiKeyId: null,
                actorLabel: 'ctx',
                action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
                resourceType: 'organization',
                resourceId: null,
                outcome: 'success',
                before: null,
                after: null,
                metadata: {},
              },
              tx,
            ),
          );
        },
      );

      const row = (await rowsFor(correlationId))[0]!;
      expect(row.causation_id).toBe(causationId);
      expect(row.ip).toBe('198.51.100.7');
      expect(row.user_agent).toBe('acc-tests/1.0');
    });

    it('fails loudly rather than inventing a correlation id outside a request', async () => {
      await expectRejected(
        asTenant({ orgId: orgA.orgId }, (tx) =>
          writer.record(
            {
              scopeType: 'organization',
              scopeId: orgA.orgId,
              actorType: 'system',
              actorUserId: null,
              actorApiKeyId: null,
              actorLabel: 'no-correlation',
              action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
              resourceType: 'organization',
              resourceId: null,
              outcome: 'success',
              before: null,
              after: null,
              metadata: {},
            },
            tx,
          ),
        ),
        /no correlationId/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Transaction atomicity — the guarantee ADR-003 D-2 exists for
  // ---------------------------------------------------------------------------
  describe('transaction atomicity', () => {
    it('rolls the business mutation back when the audit insert fails', async () => {
      const newName = `Renamed ${uuidv7().slice(0, 8)}`;
      const [{ name: originalName }] = (
        await admin.db.execute<{ name: string }>(
          sql`SELECT name FROM organizations WHERE id = ${orgA.orgId}`,
        )
      ).rows as [{ name: string }];

      await expectRejected(
        asTenant({ orgId: orgA.orgId }, async (tx) => {
          // 1. the business mutation
          await tx.execute(
            sql`UPDATE organizations SET name = ${newName} WHERE id = ${orgA.orgId}`,
          );
          // 2. the audit write, forced to fail — a scope belonging to another
          //    tenant, refused by the INSERT policy.
          await writer.record(
            record({
              scopeType: 'organization',
              scopeId: orgB.orgId,
              action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
            }),
            tx,
          );
        }),
        /row-level security/,
      );

      const { rows } = await admin.db.execute<{ name: string }>(
        sql`SELECT name FROM organizations WHERE id = ${orgA.orgId}`,
      );
      expect(rows[0]!.name).toBe(originalName);
      expect(rows[0]!.name).not.toBe(newName);

      const leaked = await admin.db.execute(
        sql`SELECT id FROM audit_logs WHERE org_id = ${orgB.orgId}`,
      );
      expect(leaked.rows).toHaveLength(0);
    });
  });

  describe('transaction atomicity — the reverse direction', () => {
    afterEach(() => purgeAudit(admin.db, sql`true`));

    it('discards a successful audit row when the business mutation later fails', async () => {
      // The first atomicity test proves audit failure kills the mutation. This
      // proves the other direction: an audit row that inserted cleanly must not
      // survive the transaction it belongs to rolling back afterwards. If the
      // writer ever wrote on its own connection, this row would commit
      // independently and the trail would assert something that never happened.
      const correlationId = uuidv7();

      await expectRejected(
        asTenant({ orgId: orgA.orgId }, async (tx) => {
          await writer.record(
            record({ scopeType: 'organization', scopeId: orgA.orgId, correlationId }),
            tx,
          );

          // Audit row is visible inside the transaction...
          const inside = await tx.execute(
            sql`SELECT id FROM audit_logs WHERE correlation_id = ${correlationId}`,
          );
          expect(inside.rows).toHaveLength(1);

          // ...then the business step fails.
          await tx.execute(sql`UPDATE organizations SET name = NULL WHERE id = ${orgA.orgId}`);
        }),
      );

      expect(await rowsFor(correlationId)).toHaveLength(0);
    });

    it('keeps an acc_auth session mutation and its audit row in one fate', async () => {
      // `auth.login.succeeded` routes through acc_auth AND accompanies an
      // acc_auth business mutation (the `sessions` insert). Both must live or
      // die together, which is only possible because the writer joins the
      // caller's transaction rather than writing beside it.
      const correlationId = uuidv7();
      const refreshHash = `not-a-real-hash-${uuidv7()}`;

      await expectRejected(
        authDb.transaction(async (tx) => {
          await tx.execute(
            sql`INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
                VALUES (${orgA.userId}, ${refreshHash}, now() + interval '30 days')`,
          );

          await writer.record(
            record({
              action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
              actorType: 'user',
              actorUserId: orgA.userId,
              actorLabel: null,
              resourceType: 'auth',
              correlationId,
            }),
            tx as never,
          );

          // Force the transaction to fail after both writes have succeeded.
          throw new Error('forced failure after login and audit');
        }),
        /forced failure/,
      );

      const sessions = await admin.db.execute(
        sql`SELECT id FROM sessions WHERE refresh_token_hash = ${refreshHash}`,
      );
      expect(sessions.rows).toHaveLength(0);
      expect(await rowsFor(correlationId)).toHaveLength(0);
    });

    it('rolls the acc_auth session mutation back when its audit row is refused', async () => {
      const refreshHash = `not-a-real-hash-${uuidv7()}`;

      await expectRejected(
        authDb.transaction(async (tx) => {
          await tx.execute(
            sql`INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
                VALUES (${orgA.userId}, ${refreshHash}, now() + interval '30 days')`,
          );

          // Refused by the acc_auth policy: the anonymous label is not valid for
          // auth.login.succeeded.
          await writer.record(
            record({
              action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
              ...anonymousLoginFailureActor(),
              resourceType: 'auth',
            }),
            tx as never,
          );
        }),
        /row-level security/,
      );

      const sessions = await admin.db.execute(
        sql`SELECT id FROM sessions WHERE refresh_token_hash = ${refreshHash}`,
      );
      expect(sessions.rows).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Append-only, through the application principals
  // ---------------------------------------------------------------------------
  describe('append-only via the application principals', () => {
    let rowId: string;

    beforeAll(async () => {
      const { rows } = await admin.db.execute<{ id: string }>(
        sql`INSERT INTO audit_logs (scope_type, actor_type, action, resource_type, outcome, correlation_id)
            VALUES ('platform','system','auth.logout','auth','success', ${uuidv7()})
            RETURNING id`,
      );
      rowId = rows[0]!.id;
    });

    afterAll(() => purgeAudit(admin.db, sql`id = ${rowId}`));

    it('gives acc_app no way to UPDATE, DELETE or TRUNCATE', async () => {
      await expectRejected(
        asTenant({ orgId: orgA.orgId }, (tx) =>
          tx.execute(sql`UPDATE audit_logs SET action = 'tampered' WHERE id = ${rowId}`),
        ),
      );
      await expectRejected(
        asTenant({ orgId: orgA.orgId }, (tx) =>
          tx.execute(sql`DELETE FROM audit_logs WHERE id = ${rowId}`),
        ),
      );
      await expectRejected(
        asTenant({ orgId: orgA.orgId }, (tx) => tx.execute(sql`TRUNCATE audit_logs`)),
      );
    });

    it('gives acc_auth no read access at all', async () => {
      await expectRejected(authDb.execute(sql`SELECT id FROM audit_logs`), /permission denied/);
    });

    it('leaves the row exactly as written', async () => {
      const { rows } = await admin.db.execute<{ action: string }>(
        sql`SELECT action FROM audit_logs WHERE id = ${rowId}`,
      );
      expect(rows[0]!.action).toBe('auth.logout');
    });
  });
});
