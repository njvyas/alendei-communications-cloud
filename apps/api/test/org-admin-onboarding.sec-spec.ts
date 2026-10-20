import { randomBytes, randomUUID } from 'node:crypto';
import { AUDIT_ACTIONS, ERROR_CODES, TENANT_ROLE_KEYS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';

import { UserLifecycleService } from '../src/iam/user-lifecycle.service';
import { PASSWORD, purgeMessageEvents, startHarness, type Harness } from './auth-harness';
import { RevocationWorld, url } from './revocation-fixtures';

jest.setTimeout(60_000);

/**
 * MVP onboarding (first release): an organization set up only through the API
 * — created by a platform administrator, its administrator appointed with the
 * seeded `org_admin` (R-6 delegation), a provider assigned — can send messages
 * with nothing else granted. Before the MVP the seeded `org_admin` carried no
 * tenant-content key, and no API path could confer `messages.send` to anyone.
 *
 * Least privilege is unchanged for every other tenant role: a `read_only`
 * member of the same organization is refused both sending and reading.
 */
describe('MVP onboarding: the seeded org_admin can send; read_only cannot', () => {
  let h: Harness;
  let w: RevocationWorld;
  let superToken: string;
  let orgId = '';
  let providerId = '';

  beforeAll(async () => {
    h = await startHarness();
    w = new RevocationWorld(h);
    await w.init('onboard');
    const sa = await w.superAdmin('ob-super');
    superToken = await w.login(sa.email);
  });

  afterAll(async () => {
    try {
      if (orgId) {
        await h.admin
          .delete(schema.messageDispatchQueue)
          .where(eq(schema.messageDispatchQueue.orgId, orgId));
        await purgeMessageEvents(h.admin, eq(schema.messageEvents.orgId, orgId));
        await h.admin.delete(schema.messages).where(eq(schema.messages.orgId, orgId));
        await h.admin
          .delete(schema.contactIdentities)
          .where(eq(schema.contactIdentities.orgId, orgId));
        await h.admin.delete(schema.contacts).where(eq(schema.contacts.orgId, orgId));
        await h.admin
          .delete(schema.organizationProviderAssignments)
          .where(eq(schema.organizationProviderAssignments.orgId, orgId));
        w.createdOrgs.push(orgId);
      }
      await w.teardown();
      if (providerId) {
        await h.admin.delete(schema.providers).where(eq(schema.providers.id, providerId));
      }
    } finally {
      await h.close();
    }
  });

  const api = (method: 'get' | 'post', path: string, token: string, org?: string) => {
    const r = request(h.app.getHttpServer())
      [method](url(path))
      .set('Authorization', `Bearer ${token}`);
    return org ? r.set('X-Acc-Organization', org) : r;
  };
  /**
   * `POST /users` creates the identity with its first grant. The product has no
   * invitation-acceptance or set-password route yet (reported with the MVP), so
   * activation runs the real `UserLifecycleService.activate` as the owner would.
   */
  const invite = async (token: string, label: string, roleId: string) => {
    const email = `${label}-${randomBytes(4).toString('hex')}@example.test`;
    const res = await api('post', '/users', token, orgId).send({
      email,
      initialRole: { roleId, scopeType: 'organization', scopeId: orgId },
    });
    expect(res.status).toBe(201);
    const userId = res.body.data.id as string;
    w.createdUsers.push(userId);
    const lifecycle = h.app.get(UserLifecycleService);
    await h.admin.transaction((tx) => lifecycle.activate(tx as never, userId, PASSWORD));
    return { userId, email };
  };

  const send = (token: string) =>
    api('post', '/messages', token, orgId)
      .set('Idempotency-Key', randomUUID())
      .send({ channelCode: 'whatsapp', recipient: '+12025557001', payload: { text: 'onboarded' } });

  it('onboards through the API, then the org admin sends with the default role alone', async () => {
    // 1. The platform administrator creates the organization: roles and the
    //    default workspace are seeded with it.
    const created = await api('post', '/organizations', superToken).send({
      name: 'MVP Onboarding',
      slug: `mvp-onboarding-${randomBytes(4).toString('hex')}`,
      resellerId: w.resellerId,
    });
    expect(created.status).toBe(201);
    orgId = created.body.data.id as string;
    const roles = Object.fromEntries(
      (
        await h.admin
          .select({ id: schema.roles.id, key: schema.roles.key })
          .from(schema.roles)
          .where(and(eq(schema.roles.orgId, orgId), eq(schema.roles.isSystemRole, true)))
      ).map((r) => [r.key, r.id]),
    );

    // 2. It appoints the organization's administrator with the seeded org_admin:
    //    a delegated grant, because it holds none of the content keys itself.
    const admin = await invite(superToken, 'ob-admin', roles[TENANT_ROLE_KEYS.ORG_ADMIN]!);
    const [grant] = await h.admin
      .select({ id: schema.userRoles.id })
      .from(schema.userRoles)
      .where(
        and(
          eq(schema.userRoles.userId, admin.userId),
          eq(schema.userRoles.roleId, roles[TENANT_ROLE_KEYS.ORG_ADMIN]!),
        ),
      );
    const [audit] = await h.admin
      .select({ metadata: schema.auditLogs.metadata })
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.action, AUDIT_ACTIONS.USER_ROLE_GRANTED),
          eq(schema.auditLogs.resourceId, grant!.id),
        ),
      );
    expect(audit?.metadata).toMatchObject({ delegation: true });
    expect((audit?.metadata as { delegatedPermissions: string[] }).delegatedPermissions).toEqual(
      expect.arrayContaining(['messages.send', 'messages.read']),
    );

    // 3. It assigns a simulator provider to the organization's WhatsApp channel.
    const [channel] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'));
    const [provider] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: channel!.id,
        name: `MVP onboarding simulator ${randomBytes(4).toString('hex')}`,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning({ id: schema.providers.id });
    providerId = provider!.id;
    const assigned = await api(
      'post',
      `/organizations/${orgId}/provider-assignments`,
      superToken,
      orgId,
    ).send({
      providerId,
      priority: 1,
    });
    expect(assigned.status).toBe(201);

    // 4. The organization's administrator sends — no custom role, no fixture grant.
    const adminToken = await w.login(admin.email);
    const sent = await send(adminToken);
    expect(sent.status).toBe(202);
    expect(sent.body.data.status).toBe('queued');
    const read = await api('get', `/messages/${sent.body.data.id}`, adminToken, orgId);
    expect(read.status).toBe(200);

    // 5. A read_only member, granted by that administrator, may do neither.
    const reader = await invite(adminToken, 'ob-reader', roles[TENANT_ROLE_KEYS.READ_ONLY]!);
    const readerToken = await w.login(reader.email);
    const refusedSend = await send(readerToken);
    expect([refusedSend.status, refusedSend.body.error?.code]).toEqual([
      403,
      ERROR_CODES.AUTHZ_SCOPE_DENIED,
    ]);
    const refusedRead = await api('get', `/messages/${sent.body.data.id}`, readerToken, orgId);
    expect(refusedRead.status).toBe(403);
    const inOrganization = await h.admin
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.orgId, orgId));
    expect(inOrganization.map((m) => m.id)).toEqual([sent.body.data.id]);
  });
});
