/**
 * Session, credential and user-lifecycle integration tests (Phase 1B.2).
 *
 * Against a real database because the guarantees under test are the database's:
 * the conditional rotation UPDATE, the unique successor constraint, the rotation
 * shape check, RLS on `sessions`, and the atomicity of a mutation with its audit
 * row.
 */
import {
  AUDIT_ACTIONS,
  ANONYMOUS_LOGIN_ACTOR_LABEL,
  anonymousLoginFailureActor,
} from '@acc/contracts';
import {
  createDatabase,
  createPool,
  schema,
  withTenantTransaction,
  type Database,
  type Transaction,
} from '@acc/db';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { AppModule } from '../src/app.module';
import { AuditWriter } from '../src/audit/audit-writer.service';
import { CredentialService } from '../src/iam/credential.service';
import { SessionService } from '../src/iam/session.service';
import { UserLifecycleService } from '../src/iam/user-lifecycle.service';
import { hashRefreshToken } from '../src/iam/refresh-token';
import { APP_DB, AUTH_DB } from '../src/database/database.tokens';
import { connectAdmin, expectRejected, purgeAudit, type AdminHandle } from './audit-fixtures';

describe('IAM foundation', () => {
  let admin: AdminHandle;
  let authDb: Database;
  let appDb: Database;
  let sessions: SessionService;
  let users: UserLifecycleService;
  let credentials: CredentialService;
  let audit: AuditWriter;
  let close: () => Promise<void>;
  let userId: string;
  const createdUserIds: string[] = [];

  /** A second, independent connection pool, for genuine concurrency. */
  let rivalPool: ReturnType<typeof createPool>;
  let rivalDb: Database;

  beforeAll(async () => {
    admin = connectAdmin();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    sessions = app.get(SessionService);
    users = app.get(UserLifecycleService);
    credentials = app.get(CredentialService);
    audit = app.get(AuditWriter);
    authDb = app.get<Database>(AUTH_DB);
    appDb = app.get<Database>(APP_DB);
    close = () => app.close();

    rivalPool = createPool({
      connectionString: process.env.DATABASE_AUTH_URL!,
      max: 2,
      applicationName: 'acc-test-rival',
    });
    rivalDb = createDatabase(rivalPool);

    const user = await withTenantTransaction(appDb, { isPlatformAdmin: true }, (tx) =>
      users.invite(tx, `iam-${uuidv7().replace(/-/g, '').slice(-12)}@example.test`),
    );
    userId = user.id;
    createdUserIds.push(user.id);
  }, 30_000);

  afterAll(async () => {
    await purgeAudit(admin.db, sql`true`);
    for (const id of createdUserIds) {
      await admin.db.execute(sql`DELETE FROM sessions WHERE user_id = ${id}`);
      await admin.db.execute(sql`DELETE FROM users WHERE id = ${id}`);
    }
    await rivalPool.end();
    await close?.();
    await admin.close();
  }, 30_000);

  /**
   * Creates an invited user through `acc_app` under platform context — the
   * principal that actually owns user creation. `acc_auth` deliberately holds no
   * INSERT on `users` (asserted below); it resolves identities, it does not mint
   * them.
   */
  const newUser = async (label: string): Promise<string> => {
    const user = await withTenantTransaction(appDb, { isPlatformAdmin: true }, (tx) =>
      users.invite(tx, `${label}-${uuidv7().replace(/-/g, '').slice(-12)}@example.test`),
    );
    createdUserIds.push(user.id);
    return user.id;
  };

  /** Runs lifecycle work as acc_app with platform context. */
  const asPlatform = <T>(work: (tx: Transaction) => Promise<T>): Promise<T> =>
    withTenantTransaction(appDb, { isPlatformAdmin: true }, work);

  // ---------------------------------------------------------------------------
  // User lifecycle
  // ---------------------------------------------------------------------------
  describe('user lifecycle', () => {
    it('creates an invited user with no credential', async () => {
      const id = await newUser('invited');
      const [row] = (
        await admin.db.execute<{ status: string; password_hash: string | null }>(
          sql`SELECT status, password_hash FROM users WHERE id = ${id}`,
        )
      ).rows;
      expect(row!.status).toBe('invited');
      expect(row!.password_hash).toBeNull();
    });

    it('an invited user cannot authenticate', async () => {
      const id = await newUser('cannot-auth');
      const user = await asPlatform((tx) => users.findById(tx, id));
      expect(users.canAuthenticate(user!)).toBe(false);
    });

    it('activation sets a credential and moves the user to active', async () => {
      const id = await newUser('activate');
      const activated = await asPlatform((tx) =>
        users.activate(tx, id, 'a-sufficiently-long-password'),
      );
      expect(activated.status).toBe('active');
      expect(users.canAuthenticate(activated)).toBe(true);

      const digest = await asPlatform((tx) => users.passwordDigest(tx, id));
      expect(digest!.startsWith('$argon2id$')).toBe(true);
      await expect(credentials.verify(digest!, 'a-sufficiently-long-password')).resolves.toBe(true);
      await expect(credentials.verify(digest!, 'wrong')).resolves.toBe(false);
    });

    it('a disabled user cannot authenticate even with a valid password', async () => {
      const id = await newUser('disabled');
      await asPlatform((tx) => users.activate(tx, id, 'valid-password-here'));
      const disabled = await asPlatform((tx) => users.disable(tx, id));

      expect(disabled.status).toBe('disabled');
      expect(users.canAuthenticate(disabled)).toBe(false);

      // The digest still verifies — which is exactly why status must be checked
      // separately, and why this test exists.
      const digest = await asPlatform((tx) => users.passwordDigest(tx, id));
      await expect(credentials.verify(digest!, 'valid-password-here')).resolves.toBe(true);
    });

    it('refuses to activate a user that does not exist', async () => {
      await expectRejected(
        asPlatform((tx) => users.activate(tx, uuidv7(), 'password-value')),
        /not found for activation/,
      );
    });

    it('the database forbids an active user with no credential at all', async () => {
      const id = await newUser('no-credential');
      await expectRejected(
        admin.db.execute(sql`UPDATE users SET status = 'active' WHERE id = ${id}`),
        /users_active_requires_credential/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------
  describe('sessions', () => {
    it('creates a session storing only the refresh-token hash', async () => {
      const { session, refresh } = await authDb.transaction((tx) =>
        sessions.create(tx as Transaction, { userId, ip: '198.51.100.4', userAgent: 'jest' }),
      );

      const [row] = (
        await admin.db.execute<{ refresh_token_hash: string; family_id: string }>(
          sql`SELECT refresh_token_hash, family_id FROM sessions WHERE id = ${session.id}`,
        )
      ).rows;

      expect(row!.refresh_token_hash).toBe(hashRefreshToken(refresh.token));
      expect(row!.refresh_token_hash).not.toBe(refresh.token);
      expect(row!.family_id).toBe(session.familyId);
      expect(sessions.isPresentable(session)).toBe(true);
    });

    it('no raw refresh token is stored anywhere in the row', async () => {
      const { session, refresh } = await authDb.transaction((tx) =>
        sessions.create(tx as Transaction, { userId }),
      );
      const [row] = (
        await admin.db.execute<Record<string, unknown>>(
          sql`SELECT * FROM sessions WHERE id = ${session.id}`,
        )
      ).rows;
      expect(JSON.stringify(row)).not.toContain(refresh.token);
    });

    it('finds a session by the hash of a presented token', async () => {
      const { session, refresh } = await authDb.transaction((tx) =>
        sessions.create(tx as Transaction, { userId }),
      );
      const found = await authDb.transaction((tx) =>
        sessions.findByRefreshTokenHash(tx as Transaction, hashRefreshToken(refresh.token)),
      );
      expect(found!.id).toBe(session.id);

      const missing = await authDb.transaction((tx) =>
        sessions.findByRefreshTokenHash(tx as Transaction, hashRefreshToken('not-the-token')),
      );
      expect(missing).toBeNull();
    });

    it('revokes a single session, idempotently', async () => {
      const { session } = await authDb.transaction((tx) =>
        sessions.create(tx as Transaction, { userId }),
      );
      const first = await authDb.transaction((tx) =>
        sessions.revoke(tx as Transaction, session.id, 'logout'),
      );
      const second = await authDb.transaction((tx) =>
        sessions.revoke(tx as Transaction, session.id, 'logout-again'),
      );
      expect([first, second]).toEqual([1, 0]);

      const [row] = (
        await admin.db.execute<{ revoked_reason: string }>(
          sql`SELECT revoked_reason FROM sessions WHERE id = ${session.id}`,
        )
      ).rows;
      // The original reason survives — a second revoke does not rewrite history.
      expect(row!.revoked_reason).toBe('logout');
    });

    it('revokes every live session for a user', async () => {
      const id = await newUser('revoke-all');
      await authDb.transaction(async (tx) => {
        await sessions.create(tx as Transaction, { userId: id });
        await sessions.create(tx as Transaction, { userId: id });
        await sessions.create(tx as Transaction, { userId: id });
      });
      const revoked = await authDb.transaction((tx) =>
        sessions.revokeAllForUser(tx as Transaction, id, 'sign_out_everywhere'),
      );
      expect(revoked).toBe(3);

      const again = await authDb.transaction((tx) =>
        sessions.revokeAllForUser(tx as Transaction, id, 'again'),
      );
      expect(again).toBe(0);
    });

    it('treats a revoked or expired session as not presentable', async () => {
      const { session } = await authDb.transaction((tx) =>
        sessions.create(tx as Transaction, { userId }),
      );
      expect(sessions.isPresentable(session)).toBe(true);
      expect(sessions.isPresentable({ ...session, revokedAt: new Date() })).toBe(false);
      expect(sessions.isPresentable({ ...session, expiresAt: new Date(Date.now() - 1000) })).toBe(
        false,
      );
      // A rotated session is spent even though it is neither revoked nor expired.
      expect(sessions.isPresentable({ ...session, rotatedAt: new Date() })).toBe(false);
    });

    it('refuses to rotate an expired or revoked session', async () => {
      const { session: expired } = await authDb.transaction((tx) =>
        sessions.create(tx as Transaction, { userId }),
      );
      await admin.db.execute(
        sql`UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE id = ${expired.id}`,
      );
      const expiredOutcome = await authDb.transaction((tx) =>
        sessions.rotate(tx as Transaction, expired.id, { userId }),
      );
      expect(expiredOutcome).toEqual({ status: 'not_rotatable', reason: 'expired' });

      const { session: revoked } = await authDb.transaction((tx) =>
        sessions.create(tx as Transaction, { userId }),
      );
      await authDb.transaction((tx) => sessions.revoke(tx as Transaction, revoked.id, 'test'));
      const revokedOutcome = await authDb.transaction((tx) =>
        sessions.rotate(tx as Transaction, revoked.id, { userId }),
      );
      expect(revokedOutcome).toEqual({ status: 'not_rotatable', reason: 'revoked' });

      const unknown = await authDb.transaction((tx) =>
        sessions.rotate(tx as Transaction, uuidv7(), { userId }),
      );
      expect(unknown).toEqual({ status: 'not_rotatable', reason: 'unknown' });
    });
  });

  // ---------------------------------------------------------------------------
  // Refresh rotation
  // ---------------------------------------------------------------------------
  describe('refresh rotation', () => {
    it('rotates into a successor that inherits the family', async () => {
      const id = await newUser('rotate');
      const { session: first } = await authDb.transaction((tx) =>
        sessions.create(tx as Transaction, { userId: id }),
      );

      const outcome = await authDb.transaction((tx) =>
        sessions.rotate(tx as Transaction, first.id, { userId: id }),
      );
      expect(outcome.status).toBe('rotated');
      if (outcome.status !== 'rotated') return;

      expect(outcome.session.familyId).toBe(first.familyId);
      expect(outcome.session.id).not.toBe(first.id);

      const [predecessor] = (
        await admin.db.execute<{ rotated_at: string | null; replaced_by_session_id: string }>(
          sql`SELECT rotated_at, replaced_by_session_id FROM sessions WHERE id = ${first.id}`,
        )
      ).rows;
      expect(predecessor!.rotated_at).not.toBeNull();
      expect(predecessor!.replaced_by_session_id).toBe(outcome.session.id);
    });

    it('issues a different refresh token on each rotation', async () => {
      const id = await newUser('rotate-token');
      const { session, refresh } = await authDb.transaction((tx) =>
        sessions.create(tx as Transaction, { userId: id }),
      );
      const outcome = await authDb.transaction((tx) =>
        sessions.rotate(tx as Transaction, session.id, { userId: id }),
      );
      if (outcome.status !== 'rotated') throw new Error('expected rotation');
      expect(outcome.refresh.token).not.toBe(refresh.token);
      expect(outcome.refresh.hash).not.toBe(refresh.hash);
    });

    it('detects reuse of an already-rotated token and revokes the whole family', async () => {
      const id = await newUser('reuse');
      const { session: first } = await authDb.transaction((tx) =>
        sessions.create(tx as Transaction, { userId: id }),
      );
      const rotated = await authDb.transaction((tx) =>
        sessions.rotate(tx as Transaction, first.id, { userId: id }),
      );
      if (rotated.status !== 'rotated') throw new Error('expected rotation');

      // The attacker replays the original token.
      const replay = await authDb.transaction((tx) =>
        sessions.rotate(tx as Transaction, first.id, { userId: id }),
      );
      expect(replay.status).toBe('reuse_detected');

      const live = await admin.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM sessions
            WHERE family_id = ${first.familyId} AND revoked_at IS NULL`,
      );
      expect(Number(live.rows[0]!.count)).toBe(0);

      const [flagged] = (
        await admin.db.execute<{ reuse_detected_at: string | null }>(
          sql`SELECT reuse_detected_at FROM sessions WHERE id = ${first.id}`,
        )
      ).rows;
      expect(flagged!.reuse_detected_at).not.toBeNull();
    });

    /**
     * The invariant this whole lineage design exists for:
     *
     *   Two concurrent refresh requests presenting the SAME valid refresh token
     *   must not both rotate it.
     *
     * Run on two independent connections with real overlapping transactions, so
     * the guarantee is the database's row lock and conditional predicate — not an
     * application check that a single-threaded test would satisfy vacuously.
     */
    it('lets exactly one of two concurrent rotations of the same token win', async () => {
      const id = await newUser('concurrent');
      const { session } = await authDb.transaction((tx) =>
        sessions.create(tx as Transaction, { userId: id }),
      );

      const attempt = (db: Database) =>
        db
          .transaction((tx) => sessions.rotate(tx as Transaction, session.id, { userId: id }))
          .then(
            (outcome) => outcome.status,
            (error: unknown) => `error:${(error as Error).message.slice(0, 40)}`,
          );

      const [a, b] = await Promise.all([attempt(authDb), attempt(rivalDb)]);
      const results = [a, b].sort();

      // Exactly one rotation, and the loser must not be a silent success.
      expect(results.filter((r) => r === 'rotated')).toHaveLength(1);
      expect(results.filter((r) => r === 'rotated')).not.toHaveLength(2);

      const [predecessor] = (
        await admin.db.execute<{ replaced_by_session_id: string | null }>(
          sql`SELECT replaced_by_session_id FROM sessions WHERE id = ${session.id}`,
        )
      ).rows;
      expect(predecessor!.replaced_by_session_id).not.toBeNull();
    });

    it('the database refuses two successors replacing the same predecessor', async () => {
      // Belt-and-braces beneath the conditional update: even with the trigger of
      // that logic bypassed entirely, the unique constraint refuses the state.
      const id = await newUser('unique-successor');
      const { session: victim } = await authDb.transaction((tx) =>
        sessions.create(tx as Transaction, { userId: id }),
      );
      const { session: a } = await authDb.transaction((tx) =>
        sessions.create(tx as Transaction, { userId: id }),
      );
      const { session: b } = await authDb.transaction((tx) =>
        sessions.create(tx as Transaction, { userId: id }),
      );

      await admin.db.execute(
        sql`UPDATE sessions SET rotated_at = now(), replaced_by_session_id = ${a.id} WHERE id = ${victim.id}`,
      );
      await expectRejected(
        admin.db.execute(
          sql`UPDATE sessions SET rotated_at = now(), replaced_by_session_id = ${a.id} WHERE id = ${b.id}`,
        ),
        /sessions_replaced_by_session_id_key/,
      );
    });

    it('the database refuses lineage columns that contradict each other', async () => {
      const id = await newUser('shape');
      const { session } = await authDb.transaction((tx) =>
        sessions.create(tx as Transaction, { userId: id }),
      );
      const { session: other } = await authDb.transaction((tx) =>
        sessions.create(tx as Transaction, { userId: id }),
      );

      await expectRejected(
        admin.db.execute(
          sql`UPDATE sessions SET replaced_by_session_id = ${other.id} WHERE id = ${session.id}`,
        ),
        /sessions_rotation_shape/,
      );
      await expectRejected(
        admin.db.execute(
          sql`UPDATE sessions SET reuse_detected_at = now() WHERE id = ${session.id}`,
        ),
        /sessions_rotation_shape/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Audit integration
  // ---------------------------------------------------------------------------
  describe('audit integration', () => {
    afterEach(() => purgeAudit(admin.db, sql`true`));

    it('commits a session mutation and its audit row together', async () => {
      const id = await newUser('audit-ok');
      const correlationId = uuidv7();

      const { session } = await authDb.transaction(async (tx) => {
        const created = await sessions.create(tx as Transaction, { userId: id });
        await audit.record(
          {
            scopeType: 'platform',
            scopeId: null,
            actorType: 'user',
            actorUserId: id,
            actorApiKeyId: null,
            actorLabel: null,
            action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
            resourceType: 'session',
            resourceId: created.session.id,
            outcome: 'success',
            before: null,
            after: { sessionId: created.session.id },
            metadata: {},
            correlationId,
          },
          tx as Transaction,
        );
        return created;
      });

      const audited = await admin.db.execute(
        sql`SELECT id FROM audit_logs WHERE correlation_id = ${correlationId}`,
      );
      const persisted = await admin.db.execute(
        sql`SELECT id FROM sessions WHERE id = ${session.id}`,
      );
      expect(audited.rows).toHaveLength(1);
      expect(persisted.rows).toHaveLength(1);
    });

    it('rolls the session back when its audit row is refused', async () => {
      const id = await newUser('audit-fail');
      let createdId = '';

      await expectRejected(
        authDb.transaction(async (tx) => {
          const created = await sessions.create(tx as Transaction, { userId: id });
          createdId = created.session.id;
          // Refused: the anonymous label is only valid for auth.login.failed.
          await audit.record(
            {
              scopeType: 'platform',
              scopeId: null,
              ...anonymousLoginFailureActor(),
              action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
              resourceType: 'session',
              resourceId: null,
              outcome: 'success',
              before: null,
              after: null,
              metadata: {},
              correlationId: uuidv7(),
            },
            tx as Transaction,
          );
        }),
        /row-level security/,
      );

      const persisted = await admin.db.execute(
        sql`SELECT id FROM sessions WHERE id = ${createdId}`,
      );
      expect(persisted.rows).toHaveLength(0);
    });

    it('records an unknown-identity login failure with the anonymous actor', async () => {
      const correlationId = uuidv7();
      await audit.record({
        scopeType: 'platform',
        scopeId: null,
        ...anonymousLoginFailureActor(),
        action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        resourceType: 'auth',
        resourceId: null,
        outcome: 'failure',
        before: null,
        after: null,
        metadata: { reason: 'unknown_email' },
        correlationId,
      });

      const [row] = (
        await admin.db.execute<{ actor_type: string; actor_label: string; actor_user_id: null }>(
          sql`SELECT actor_type, actor_label, actor_user_id FROM audit_logs WHERE correlation_id = ${correlationId}`,
        )
      ).rows;
      expect(row!.actor_type).toBe('system');
      expect(row!.actor_label).toBe(ANONYMOUS_LOGIN_ACTOR_LABEL);
      expect(row!.actor_user_id).toBeNull();
    });

    it('never lets credential material reach an audit row', async () => {
      const id = await newUser('audit-redact');
      const correlationId = uuidv7();
      const digest = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$VERY-SECRET-DIGEST';
      const token = 'a-raw-refresh-token-value';

      await authDb.transaction((tx) =>
        audit.record(
          {
            scopeType: 'platform',
            scopeId: null,
            actorType: 'user',
            actorUserId: id,
            actorApiKeyId: null,
            actorLabel: null,
            action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
            resourceType: 'session',
            resourceId: null,
            outcome: 'success',
            before: { password_hash: digest, email: 'visible@example.test' },
            after: { refreshToken: token, nested: { password: 'plaintext!' } },
            metadata: { refresh_token_hash: 'deadbeef', keys: [{ key_hash: 'kh' }] },
            correlationId,
          },
          tx as Transaction,
        ),
      );

      const [row] = (
        await admin.db.execute<Record<string, unknown>>(
          sql`SELECT before, after, metadata FROM audit_logs WHERE correlation_id = ${correlationId}`,
        )
      ).rows;
      const serialized = JSON.stringify(row);
      for (const secret of [digest, token, 'plaintext!', 'deadbeef', 'kh', 'VERY-SECRET-DIGEST']) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).toContain('visible@example.test');
    });
  });

  // ---------------------------------------------------------------------------
  // RLS on sessions, unchanged by the new columns
  // ---------------------------------------------------------------------------
  describe('sessions RLS after the lineage migration', () => {
    it('still carries RLS and both policies', async () => {
      const [security] = (
        await admin.db.execute<{ rowsecurity: boolean }>(
          sql`SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='sessions'`,
        )
      ).rows;
      expect(security!.rowsecurity).toBe(true);

      const policies = await admin.db.execute<{ policyname: string }>(
        sql`SELECT policyname FROM pg_policies WHERE tablename = 'sessions'`,
      );
      const names = new Set(policies.rows.map((r) => r.policyname));
      expect(names.has('sessions_self')).toBe(true);
      expect(names.has('sessions_auth')).toBe(true);
    });

    it('grants acc_auth no DELETE on sessions — revocation is an update', async () => {
      const privileges = await admin.db.execute<{ privilege_type: string }>(
        sql`SELECT privilege_type FROM information_schema.table_privileges
            WHERE table_name='sessions' AND grantee='acc_auth'`,
      );
      const held = privileges.rows.map((r) => r.privilege_type).sort();
      expect(held).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    });

    it('refuses to let acc_auth create a user at all', async () => {
      // The identity role resolves identities; it does not mint them. This is
      // the boundary that keeps a compromised credential-verification path from
      // provisioning itself an account.
      await expectRejected(
        authDb.transaction((tx) =>
          (tx as Transaction)
            .insert(schema.users)
            .values({ email: `forged-${uuidv7()}@example.test`, status: 'invited' }),
        ),
        /permission denied for table users/,
      );
    });

    it('lets a user see only their own sessions through acc_app', async () => {
      const mine = await newUser('rls-mine');
      const theirs = await newUser('rls-theirs');
      await authDb.transaction(async (tx) => {
        await sessions.create(tx as Transaction, { userId: mine });
        await sessions.create(tx as Transaction, { userId: theirs });
      });

      // `sessions_self` admits the caller's own rows, plus rows of users the
      // caller can administer. With only a user id in context and no grants,
      // that is exactly self.
      const visible = await withTenantTransaction(appDb, { userId: mine }, async (tx) => {
        const { rows } = await tx.execute<{ user_id: string }>(sql`SELECT user_id FROM sessions`);
        return rows;
      });

      expect(visible.length).toBeGreaterThan(0);
      expect(visible.every((r) => r.user_id === mine)).toBe(true);
      expect(visible.some((r) => r.user_id === theirs)).toBe(false);
    });

    it('would fail if the sessions policy were weakened', async () => {
      const mine = await newUser('rls-control-mine');
      const theirs = await newUser('rls-control-theirs');
      await authDb.transaction(async (tx) => {
        await sessions.create(tx as Transaction, { userId: theirs });
      });

      const countTheirs = () =>
        withTenantTransaction(appDb, { userId: mine }, async (tx) => {
          const { rows } = await tx.execute<{ count: string }>(
            sql`SELECT count(*)::text AS count FROM sessions WHERE user_id = ${theirs}`,
          );
          return Number(rows[0]!.count);
        });

      expect(await countTheirs()).toBe(0);

      await admin.db.execute(sql`ALTER POLICY sessions_self ON sessions USING (true)`);
      try {
        expect(await countTheirs()).toBeGreaterThan(0);
      } finally {
        await admin.db.execute(
          sql`ALTER POLICY sessions_self ON sessions USING (
                app_is_platform_admin()
                OR user_id = app_current_user_id()
                OR EXISTS (
                  SELECT 1 FROM user_roles ur
                  WHERE ur.user_id = sessions.user_id AND app_org_in_scope(ur.org_id)
                )
              )`,
        );
      }

      expect(await countTheirs()).toBe(0);
    });
  });

  it('exposes no schema column holding a raw credential', async () => {
    const columns = await admin.db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name IN ('users','sessions','api_keys')`,
    );
    const names = columns.rows.map((r) => r.column_name);
    for (const forbidden of ['password', 'refresh_token', 'api_key_secret', 'secret']) {
      expect(names).not.toContain(forbidden);
    }
    expect(names).toContain('password_hash');
    expect(names).toContain('refresh_token_hash');
    expect(names).toContain('key_hash');
  });
});
