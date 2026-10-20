import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { AUDIT_ACTIONS, PLATFORM_ROLE_KEYS, TENANT_ROLE_KEYS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { CredentialService } from '../src/iam/credential.service';
import { UserLifecycleService } from '../src/iam/user-lifecycle.service';
import { ownerAuditWriter } from '../src/cli/bootstrap';
import {
  ACTIVATION_ACTOR_LABEL,
  ActivationRefusal,
  activateInvitedUser,
} from '../src/cli/user-activation';
import { startHarness, type Harness } from './auth-harness';
import { RevocationWorld, url, type Org } from './revocation-fixtures';

jest.setTimeout(60_000);

const NEW_PASSWORD = 'an-operator-chosen-first-passphrase';
const API_DIR = resolve(__dirname, '..');

/**
 * The operator-run activation command (first release, MVP): the only way an
 * invited tenant user gets a first password, since the product has no
 * invitation-acceptance route. Runs as the schema owner, like bootstrap.
 */
describe('operator-run user activation (MVP)', () => {
  let h: Harness;
  let w: RevocationWorld;
  let users: UserLifecycleService;
  let credentials: CredentialService;
  let a: Org;
  let b: Org;
  let operatorEmail: string;

  beforeAll(async () => {
    h = await startHarness();
    w = new RevocationWorld(h);
    await w.init('activation');
    credentials = h.app.get(CredentialService);
    users = h.app.get(UserLifecycleService);
    a = await w.org('act-a');
    b = await w.org('act-b');
    operatorEmail = (await w.superAdmin('act-operator')).email;
  });

  afterAll(async () => {
    try {
      await w.teardown();
    } finally {
      await h.close();
    }
  });

  const deps = () => ({ users, audit: ownerAuditWriter() });
  const userRow = async (id: string) =>
    (
      await h.admin
        .select({ status: schema.users.status, passwordHash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, id))
    )[0]!;
  const auditOf = async (resourceId: string) =>
    h.admin
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.action, AUDIT_ACTIONS.USER_ACTIVATED),
          eq(schema.auditLogs.resourceId, resourceId),
        ),
      );

  /** An invited user without a credential, holding read_only in `org`. */
  async function invitedIn(org: Org, label: string) {
    const person = await w.person(label, 'invited');
    await w.grant(person.userId, org.roles[TENANT_ROLE_KEYS.READ_ONLY]!, 'organization', org.orgId);
    return person;
  }

  const activate = (
    overrides: Partial<Parameters<typeof activateInvitedUser>[2]> & { userEmail: string },
  ) =>
    activateInvitedUser(h.admin, deps(), {
      operatorEmail,
      organization: a.orgId,
      password: NEW_PASSWORD,
      ...overrides,
    });

  async function expectRefused(
    attempt: Promise<unknown>,
    reason: RegExp,
    userId: string | null,
    audited = true,
  ) {
    const error = await attempt.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActivationRefusal);
    expect((error as ActivationRefusal).reason).toMatch(reason);
    expect((error as Error).message).not.toContain(NEW_PASSWORD);
    if (userId) {
      const denied = (await auditOf(userId)).filter((r) => r.outcome === 'denied');
      expect(denied.length > 0).toBe(audited);
      for (const row of denied) expect(JSON.stringify(row)).not.toContain(NEW_PASSWORD);
    }
  }

  // --- success -----------------------------------------------------------------

  it('activates an invited user in the named organization: status, hash, sign-in, audit', async () => {
    const person = await invitedIn(a, 'act-ok');
    const result = await activate({ userEmail: person.email, organization: a.orgId });
    expect(result).toMatchObject({ userId: person.userId, orgId: a.orgId });

    const row = await userRow(person.userId);
    expect(row.status).toBe('active');
    expect(row.passwordHash).not.toContain(NEW_PASSWORD);
    expect(await credentials.verify(row.passwordHash!, NEW_PASSWORD)).toBe(true);

    await h.clearRateLimits();
    await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: person.email, password: NEW_PASSWORD })
      .expect(200);

    const [audit] = await auditOf(person.userId);
    expect(audit).toMatchObject({
      outcome: 'success',
      actorType: 'user',
      actorLabel: ACTIVATION_ACTOR_LABEL,
      scopeType: 'organization',
      orgId: a.orgId,
      before: { status: 'invited' },
      after: { status: 'active' },
    });
    const [operator] = await h.admin
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, operatorEmail));
    expect(audit!.actorUserId).toBe(operator!.id);
    expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
  });

  it('accepts the organization by slug as well as by id', async () => {
    const person = await invitedIn(a, 'act-slug');
    const [org] = await h.admin
      .select({ slug: schema.organizations.slug })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, a.orgId));
    await activate({ userEmail: person.email, organization: org!.slug });
    expect((await userRow(person.userId)).status).toBe('active');
  });

  // --- invalid user state ------------------------------------------------------------

  it('refuses an active user, a disabled user and an invited user who already has a credential; nothing changes', async () => {
    const active = await invitedIn(a, 'act-active');
    await activate({ userEmail: active.email });
    const before = await userRow(active.userId);
    await expectRefused(
      activate({ userEmail: active.email }),
      /is active, not invited/,
      active.userId,
    );
    expect(await userRow(active.userId)).toEqual(before);

    const disabled = await invitedIn(a, 'act-disabled');
    await h.admin
      .update(schema.users)
      .set({ status: 'disabled' })
      .where(eq(schema.users.id, disabled.userId));
    await expectRefused(
      activate({ userEmail: disabled.email }),
      /is disabled, not invited/,
      disabled.userId,
    );
    expect((await userRow(disabled.userId)).status).toBe('disabled');

    const credentialed = await invitedIn(a, 'act-cred');
    const existing = await credentials.hash('a-credential-set-elsewhere');
    await h.admin
      .update(schema.users)
      .set({ passwordHash: existing })
      .where(eq(schema.users.id, credentialed.userId));
    await expectRefused(
      activate({ userEmail: credentialed.email }),
      /already has a credential/,
      credentialed.userId,
    );
    expect((await userRow(credentialed.userId)).passwordHash).toBe(existing);
  });

  it('refuses an unknown user and an unknown organization', async () => {
    await expectRefused(activate({ userEmail: 'nobody-here@example.test' }), /no user/, null);
    const person = await invitedIn(a, 'act-noorg');
    await expectRefused(
      activate({ userEmail: person.email, organization: 'no-such-organization' }),
      /not found/,
      null,
    );
    expect((await userRow(person.userId)).status).toBe('invited');
  });

  // --- unauthorized ---------------------------------------------------------------

  it('refuses an operator who is not an active platform administrator, and writes no row for an unknown actor', async () => {
    const person = await invitedIn(a, 'act-unauth');
    const tenantAdmin = await w.admin(a, 'act-tenant-admin');
    await expectRefused(
      activate({ userEmail: person.email, operatorEmail: tenantAdmin.email }),
      /operator must be an active platform administrator/,
      person.userId,
      false,
    );
    const disabledOperator = await w.superAdmin('act-op-disabled');
    await h.admin
      .update(schema.users)
      .set({ status: 'disabled' })
      .where(eq(schema.users.id, disabledOperator.userId));
    await expectRefused(
      activate({ userEmail: person.email, operatorEmail: disabledOperator.email }),
      /operator must be an active platform administrator/,
      person.userId,
      false,
    );
    expect((await userRow(person.userId)).status).toBe('invited');
  });

  it('refuses cross-tenant activation: a user of organization B named under organization A', async () => {
    const person = await invitedIn(b, 'act-cross');
    await expectRefused(
      activate({ userEmail: person.email, organization: a.orgId }),
      /holds no grant in organization/,
      person.userId,
    );
    expect((await userRow(person.userId)).status).toBe('invited');
    const [denied] = await auditOf(person.userId);
    expect(denied).toMatchObject({ outcome: 'denied', orgId: a.orgId });
  });

  it('refuses a user holding a platform grant: platform administrators are never activated this way', async () => {
    const person = await invitedIn(a, 'act-platform');
    await w.grant(
      person.userId,
      await w.seededPlatformRole(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT),
      'platform',
      null,
    );
    await expectRefused(
      activate({ userEmail: person.email }),
      /platform or reseller grant/,
      person.userId,
    );
    expect((await userRow(person.userId)).status).toBe('invited');
  });

  it('refuses activation in an organization that is not active', async () => {
    const c = await w.org('act-c');
    const person = await invitedIn(c, 'act-suspended');
    const opToken = await w.login(operatorEmail);
    await request(h.app.getHttpServer())
      .post(url(`/organizations/${c.orgId}/suspend`))
      .set('Authorization', `Bearer ${opToken}`)
      .send({ reason: 'activation test' })
      .expect(200);
    await expectRefused(
      activate({ userEmail: person.email, organization: c.orgId }),
      /is suspended, not active/,
      null,
    );
    // Refused on the organization, before the user is read: the denied row names
    // the organization and no user.
    const denied = await h.admin
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.action, AUDIT_ACTIONS.USER_ACTIVATED),
          eq(schema.auditLogs.outcome, 'denied'),
          eq(schema.auditLogs.orgId, c.orgId),
        ),
      );
    expect(denied).toHaveLength(1);
    expect(denied[0]!.resourceId).toBeNull();
    expect((await userRow(person.userId)).status).toBe('invited');
  });

  // --- password handling -------------------------------------------------------------

  it('refuses a password outside the rule, audits the refusal, and never records the password', async () => {
    const person = await invitedIn(a, 'act-short');
    const short = 'too-short';
    const error = await activate({ userEmail: person.email, password: short }).catch(
      (e: unknown) => e,
    );
    expect((error as ActivationRefusal).reason).toMatch(/at least 12 characters/);
    expect((error as Error).message).not.toContain(short);
    expect((await userRow(person.userId)).status).toBe('invited');
    // Refused before the user was read: the row names no user.
    const rows = await h.admin
      .select()
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.action, AUDIT_ACTIONS.USER_ACTIVATED),
          eq(schema.auditLogs.outcome, 'denied'),
          sql`${schema.auditLogs.metadata}->>'reason' LIKE '%at least 12 characters%'`,
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(JSON.stringify(row)).not.toContain(short);
  });

  it('the command reads the password from stdin only; argv and output never carry it', async () => {
    const run = (args: string[], input: string) =>
      spawnSync(
        process.execPath,
        [
          resolve(API_DIR, '../../node_modules/tsx/dist/cli.mjs'),
          'src/cli/activate-user.ts',
          ...args,
        ],
        {
          cwd: API_DIR,
          input,
          env: process.env,
          encoding: 'utf8',
          timeout: 60_000,
        },
      );

    // A password passed as an argument is refused before anything is read.
    const asArgument = run(
      [
        '--operator',
        operatorEmail,
        '--organization',
        a.orgId,
        '--email',
        'x@example.test',
        '--password',
        NEW_PASSWORD,
      ],
      '',
    );
    expect(asArgument.status).toBe(1);
    expect(asArgument.stderr).toMatch(/unexpected argument --password/);
    expect(`${asArgument.stdout}${asArgument.stderr}`).not.toContain(NEW_PASSWORD);
    {
      const person = await invitedIn(a, 'act-cli');
      const ok = run(
        [
          '--operator',
          operatorEmail,
          '--organization',
          a.orgId,
          '--email',
          person.email,
          '--password-stdin',
        ],
        `${NEW_PASSWORD}\n`,
      );
      expect([ok.status, ok.stderr.trim()]).toEqual([0, '']);
      expect(ok.stdout).toMatch(/User activated: .*act-cli/);
      expect(`${ok.stdout}${ok.stderr}`).not.toContain(NEW_PASSWORD);
      const row = await userRow(person.userId);
      expect(await credentials.verify(row.passwordHash!, NEW_PASSWORD)).toBe(true);

      const again = run(
        [
          '--operator',
          operatorEmail,
          '--organization',
          a.orgId,
          '--email',
          person.email,
          '--password-stdin',
        ],
        `${NEW_PASSWORD}\n`,
      );
      expect(again.status).toBe(1);
      expect(again.stderr).toMatch(/user activation refused: the user is active, not invited/);
    }
  });
});
