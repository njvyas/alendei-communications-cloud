import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import {
  PASSWORD,
  PREFIX,
  createScopedUser,
  createTenant,
  destroyTenant,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';
import { OpenApiValidator } from './openapi-validator';

const url = (p: string) => `/${PREFIX}${p}`;

/** `GET /usage/messages`: correctness, filters, validation, tenancy, privacy, contract. */
describe('Message usage report (GET /usage/messages)', () => {
  let h: Harness;
  let credentials: CredentialService;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let tokenA: string;
  let tokenB: string;
  let noReadToken: string;
  let whatsappId: string;
  let smsId: string;
  let secondWorkspaceId: string;
  const roleIds: string[] = [];

  const FROM = '2026-10-01T00:00:00.000Z';
  const TO = '2026-10-04T00:00:00.000Z';
  const RECIPIENT = '+919812345678';

  async function grantRead(t: TenantFixture) {
    const [perm] = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(eq(schema.permissions.key, PERMISSIONS.MESSAGES_READ));
    const roleId = uuidv7();
    roleIds.push(roleId);
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: t.orgId,
      key: `usage_${randomBytes(4).toString('hex')}`,
      name: 'Usage Reader',
      description: 'messages.read only',
      isSystemRole: false,
      allowedScopeTypes: ['organization'],
    });
    await h.admin
      .insert(schema.rolePermissions)
      .values({ roleId, permissionId: perm!.id, orgId: t.orgId });
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx
        .insert(schema.userRoles)
        .values({ userId: t.userId, roleId, scopeType: 'organization', scopeId: t.orgId });
    });
  }

  async function login(email: string) {
    await h.clearRateLimits();
    return (
      await request(h.app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email, password: PASSWORD })
        .expect(200)
    ).body.data.accessToken as string;
  }

  async function seed(
    t: TenantFixture,
    m: {
      at: string;
      channel: string;
      status: 'accepted' | 'failed' | 'queued' | 'outcome_unknown';
      workspace?: string;
      reason?: string;
    },
  ) {
    const workspaceId = m.workspace ?? t.workspaceId;
    const contactId = uuidv7();
    await h.admin
      .insert(schema.contacts)
      .values({ id: contactId, orgId: t.orgId, workspaceId, displayName: 'Usage' });
    await h.admin.insert(schema.messages).values({
      id: uuidv7(),
      orgId: t.orgId,
      workspaceId,
      contactId,
      channelId: m.channel,
      status: m.status,
      payload: { text: 'body' },
      recipientAddress: RECIPIENT,
      failureReason: m.reason ?? null,
      correlationId: uuidv7(),
      createdAt: new Date(m.at),
    });
  }

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    tenantA = await createTenant(h.admin, 'usage-a', credentials);
    tenantB = await createTenant(h.admin, 'usage-b', credentials);
    await grantRead(tenantA);
    await grantRead(tenantB);

    const channels = await h.admin
      .select({ id: schema.channels.id, code: schema.channels.code })
      .from(schema.channels)
      .where(inArray(schema.channels.code, ['whatsapp', 'sms']));
    whatsappId = channels.find((c) => c.code === 'whatsapp')!.id;
    smsId = channels.find((c) => c.code === 'sms')!.id;

    const [ws] = await h.admin
      .insert(schema.workspaces)
      .values({
        orgId: tenantA.orgId,
        name: 'Usage second',
        slug: `usage-${randomBytes(3).toString('hex')}`,
      })
      .returning({ id: schema.workspaces.id });
    secondWorkspaceId = ws!.id;

    // Tenant A: eight messages over three UTC days, two channels, two workspaces.
    await seed(tenantA, { at: '2026-10-01T05:00:00Z', channel: whatsappId, status: 'accepted' });
    await seed(tenantA, { at: '2026-10-01T06:00:00Z', channel: whatsappId, status: 'accepted' });
    await seed(tenantA, {
      at: '2026-10-01T07:00:00Z',
      channel: whatsappId,
      status: 'failed',
      reason: 'NO_ELIGIBLE_PROVIDER',
    });
    // 20:00 UTC on 01-Oct is 02-Oct in India (UTC+05:30).
    await seed(tenantA, {
      at: '2026-10-01T20:00:00Z',
      channel: smsId,
      status: 'failed',
      reason: `PROVIDER_ERROR: rejected ${RECIPIENT}`,
    });
    await seed(tenantA, {
      at: '2026-10-02T09:00:00Z',
      channel: smsId,
      status: 'failed',
      reason: `Recipient ${RECIPIENT} unreachable`,
    });
    await seed(tenantA, { at: '2026-10-02T10:00:00Z', channel: smsId, status: 'queued' });
    await seed(tenantA, {
      at: '2026-10-03T11:00:00Z',
      channel: whatsappId,
      status: 'outcome_unknown',
      workspace: secondWorkspaceId,
    });
    // Outside the period on both sides (`to` is exclusive).
    await seed(tenantA, { at: '2026-09-30T23:59:59Z', channel: whatsappId, status: 'accepted' });
    await seed(tenantA, { at: TO, channel: whatsappId, status: 'accepted' });
    // Tenant B: must never appear in A's report.
    for (let i = 0; i < 4; i += 1) {
      await seed(tenantB, { at: '2026-10-02T12:00:00Z', channel: whatsappId, status: 'accepted' });
    }

    tokenA = await login(tenantA.email);
    tokenB = await login(tenantB.email);
    const noRead = await createScopedUser(
      h.admin,
      tenantA,
      credentials,
      'organization',
      tenantA.orgId,
      'usage-noread',
    );
    noReadToken = await login(noRead.email);
  }, 90_000);

  afterAll(async () => {
    try {
      const orgIds = [tenantA?.orgId, tenantB?.orgId].filter(Boolean) as string[];
      if (orgIds.length > 0) {
        await h.admin.delete(schema.messages).where(inArray(schema.messages.orgId, orgIds));
        await h.admin.delete(schema.contacts).where(inArray(schema.contacts.orgId, orgIds));
      }
      if (roleIds.length > 0) {
        await h.admin.delete(schema.userRoles).where(inArray(schema.userRoles.roleId, roleIds));
        await h.admin
          .delete(schema.rolePermissions)
          .where(inArray(schema.rolePermissions.roleId, roleIds));
        await h.admin.delete(schema.roles).where(inArray(schema.roles.id, roleIds));
      }
      if (tenantA) await destroyTenant(h.admin, tenantA);
      if (tenantB) await destroyTenant(h.admin, tenantB);
    } finally {
      await h.close();
    }
  });

  const report = (query: string, token = tokenA) =>
    request(h.app.getHttpServer())
      .get(url(`/usage/messages?${query}`))
      .set('Authorization', `Bearer ${token}`);
  const period = `from=${FROM}&to=${TO}`;

  it('1. totals, per-channel and per-day counts for the period ([from, to))', async () => {
    const res = await report(period).expect(200);
    const data = res.body.data;
    expect(data.orgId).toBe(tenantA.orgId);
    expect(data.timeZone).toBe('UTC');
    expect(data.totals).toEqual({
      total: 7,
      accepted: 2,
      failed: 3,
      outcomeUnknown: 1,
      pending: 1,
    });
    expect(data.acceptanceRate).toBe(0.3333);
    expect(data.byChannel).toEqual(
      [
        { channelCode: 'sms', total: 3, accepted: 0, failed: 2, outcomeUnknown: 0, pending: 1 },
        {
          channelCode: 'whatsapp',
          total: 4,
          accepted: 2,
          failed: 1,
          outcomeUnknown: 1,
          pending: 0,
        },
      ].sort((a, b) => b.total - a.total),
    );
    expect(
      data.byDay.map((d: { day: string; channelCode: string; total: number }) => [
        d.day,
        d.channelCode,
        d.total,
      ]),
    ).toEqual([
      ['2026-10-01', 'sms', 1],
      ['2026-10-01', 'whatsapp', 3],
      ['2026-10-02', 'sms', 2],
      ['2026-10-03', 'whatsapp', 1],
    ]);
  });

  it('2. buckets days in the requested time zone', async () => {
    const res = await report(`${period}&timeZone=Asia/Kolkata`).expect(200);
    expect(res.body.data.timeZone).toBe('Asia/Kolkata');
    const sms = res.body.data.byDay.filter((d: { channelCode: string }) => d.channelCode === 'sms');
    expect(sms.map((d: { day: string; total: number }) => [d.day, d.total])).toEqual([
      ['2026-10-02', 3],
    ]);
  });

  it('3. filters by channel and workspace within the organization', async () => {
    const sms = (await report(`${period}&channelCode=sms`).expect(200)).body.data;
    expect(sms.channelCode).toBe('sms');
    expect(sms.totals.total).toBe(3);
    const ws = (await report(`${period}&workspaceId=${secondWorkspaceId}`).expect(200)).body.data;
    expect(ws.totals).toEqual({ total: 1, accepted: 0, failed: 0, outcomeUnknown: 1, pending: 0 });
    const rcs = (await report(`${period}&channelCode=rcs`).expect(200)).body.data;
    expect(rcs.totals.total).toBe(0);
    expect(rcs.acceptanceRate).toBeNull();
  });

  it('4. reports failure reason codes only, never free text or recipient data', async () => {
    const res = await report(period).expect(200);
    expect(res.body.data.topFailureReasons).toEqual([
      { reason: 'NO_ELIGIBLE_PROVIDER', count: 1 },
      { reason: 'OTHER', count: 1 },
      { reason: 'PROVIDER_ERROR', count: 1 },
    ]);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('9812345678');
    expect(body).not.toContain('unreachable');
  });

  it('5. refuses an invalid period, time zone or unknown parameter with 400', async () => {
    for (const query of [
      '',
      `from=${FROM}`,
      `to=${TO}`,
      `from=${TO}&to=${FROM}`,
      `from=${FROM}&to=${FROM}`,
      `from=2025-01-01T00:00:00Z&to=2026-01-03T00:00:00Z`,
      `${period}&timeZone=Mars/Olympus_Mons`,
      `${period}&timeZone=UTC;DROP`,
      `${period}&channelCode=fax`,
      `${period}&workspaceId=nope`,
      `${period}&orgId=${tenantB.orgId}`,
      'from=yesterday&to=today',
    ]) {
      const res = await report(query);
      expect([query, res.status]).toEqual([query, 400]);
    }
  });

  it('6. requires messages.read (403 without it, 401 without a credential)', async () => {
    expect((await report(period, noReadToken)).status).toBe(403);
    await request(h.app.getHttpServer())
      .get(url(`/usage/messages?${period}`))
      .expect(401);
  });

  it('7. never counts another organization, whatever the filters or header', async () => {
    const b = (await report(period, tokenB).expect(200)).body.data;
    expect(b.orgId).toBe(tenantB.orgId);
    expect(b.totals.total).toBe(4);
    // A's workspace id as a filter from B's session counts nothing.
    const crossFilter = (
      await report(`${period}&workspaceId=${tenantA.workspaceId}`, tokenB).expect(200)
    ).body.data;
    expect(crossFilter.totals.total).toBe(0);
    // Selecting A's organization from B's session is refused.
    const forged = await request(h.app.getHttpServer())
      .get(url(`/usage/messages?${period}`))
      .set('Authorization', `Bearer ${tokenB}`)
      .set('X-Acc-Organization', tenantA.orgId);
    expect(forged.status).toBe(403);
  });

  it('8. responses conform to the OpenAPI document', async () => {
    const validator = new OpenApiValidator(
      JSON.parse(readFileSync(join(__dirname, '..', 'openapi', 'openapi.v1.json'), 'utf8')),
    );
    const problems: string[] = [];
    for (const query of [period, `${period}&timeZone=Asia/Kolkata&channelCode=sms`, 'from=x']) {
      problems.push(
        ...validator.check('GET', url(`/usage/messages?${query}`), await report(query)),
      );
    }
    problems.push(
      ...validator.check(
        'GET',
        url(`/usage/messages?${period}`),
        await report(period, noReadToken),
      ),
    );
    expect(problems).toEqual([]);
  });
});
