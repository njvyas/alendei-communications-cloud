import { randomBytes, randomUUID } from 'node:crypto';
import { PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { DispatchWorker } from '../src/messages/dispatch/dispatch.worker';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  purgeMessageEvents,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

// Signs a user in (Argon2) and then waits 3 s of poll intervals.
jest.setTimeout(30_000);

/**
 * B1: `DISPATCH_WORKER_ENABLED=false` (set for every suite by `setup-env.ts`)
 * leaves an instance able to accept messages but sending none — an API-only
 * replica. The message stays queued, untouched, for an instance that dispatches.
 */
describe('Dispatch worker disabled (B1)', () => {
  let h: Harness;
  let tenant: TenantFixture;
  let providerId: string;
  let roleId: string;

  beforeAll(async () => {
    h = await startHarness();
    tenant = await createTenant(h.admin, 'dw-off', h.app.get(CredentialService));
  }, 60_000);

  afterAll(async () => {
    try {
      await h.admin
        .delete(schema.messageDispatchQueue)
        .where(eq(schema.messageDispatchQueue.orgId, tenant.orgId));
      await purgeMessageEvents(h.admin, eq(schema.messageEvents.orgId, tenant.orgId));
      await h.admin.delete(schema.messages).where(eq(schema.messages.orgId, tenant.orgId));
      await h.admin
        .delete(schema.contactIdentities)
        .where(eq(schema.contactIdentities.orgId, tenant.orgId));
      await h.admin.delete(schema.contacts).where(eq(schema.contacts.orgId, tenant.orgId));
      await h.admin
        .delete(schema.organizationProviderAssignments)
        .where(eq(schema.organizationProviderAssignments.orgId, tenant.orgId));
      if (providerId)
        await h.admin.delete(schema.providers).where(eq(schema.providers.id, providerId));
      if (roleId) {
        await h.admin.delete(schema.userRoles).where(eq(schema.userRoles.roleId, roleId));
        await h.admin
          .delete(schema.rolePermissions)
          .where(eq(schema.rolePermissions.roleId, roleId));
        await h.admin.delete(schema.roles).where(eq(schema.roles.id, roleId));
      }
      await destroyTenant(h.admin, tenant);
    } finally {
      await h.close();
    }
  }, 60_000);

  it('the loop is not running, and an accepted message stays queued and unclaimed', async () => {
    expect(h.app.get(DispatchWorker).isRunning()).toBe(false);

    const [channel] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'))
      .limit(1);
    const slug = `dw-off-${randomBytes(4).toString('hex')}`;
    const [prov] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channel!.id,
        name: `WhatsApp Simulator ${slug}`,
        slug,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providerId = prov!.id;
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId: tenant.orgId,
      channelId: channel!.id,
      providerId,
      priority: 1,
      status: 'active',
    });

    roleId = uuidv7();
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: tenant.orgId,
      key: `dw_off_${randomBytes(4).toString('hex')}`,
      name: 'Messages Role',
      description: 'Allows messages send and read',
      isSystemRole: false,
      allowedScopeTypes: ['organization'],
    });
    const perms = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(
        inArray(schema.permissions.key, [PERMISSIONS.MESSAGES_SEND, PERMISSIONS.MESSAGES_READ]),
      );
    for (const p of perms) {
      await h.admin
        .insert(schema.rolePermissions)
        .values({ roleId, permissionId: p.id, orgId: tenant.orgId });
    }
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx.insert(schema.userRoles).values({
        userId: tenant.userId,
        roleId,
        scopeType: 'organization',
        scopeId: tenant.orgId,
      });
    });
    await h.clearRateLimits();
    const login = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: tenant.email, password: PASSWORD })
      .expect(200);
    const token = login.body.data.accessToken as string;

    const res = await request(h.app.getHttpServer())
      .post(url('/messages'))
      .set('Authorization', `Bearer ${token}`)
      .set('X-Acc-Organization', tenant.orgId)
      .set('Idempotency-Key', randomUUID())
      .send({ channelCode: 'whatsapp', recipient: '+12025550199', payload: { text: 'off' } })
      .expect(202);
    const messageId = res.body.data.id as string;

    // Several default poll intervals (1 s ±20 %) pass with nothing happening.
    await new Promise((r) => setTimeout(r, 3_000));

    const [message] = await h.admin
      .select({ status: schema.messages.status })
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId));
    expect(message!.status).toBe('queued');
    const [queueRow] = await h.admin
      .select()
      .from(schema.messageDispatchQueue)
      .where(eq(schema.messageDispatchQueue.messageId, messageId));
    expect(queueRow).toMatchObject({ claimToken: null, claimedUntil: null, dispatchEpoch: 0 });
    const attempts = await h.admin
      .select()
      .from(schema.messageAttempts)
      .where(eq(schema.messageAttempts.messageId, messageId));
    expect(attempts).toHaveLength(0);
  });
});
