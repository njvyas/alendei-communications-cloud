/**
 * Phase 4.3 (Gate F.3), batch F.3-1: the send path refuses channels with no
 * authorized send path.
 *
 * `email` and `voice` are catalogued and active, and in this suite each even
 * has an active provider assignment, so the channel gate is the only thing that
 * refuses them (owner decision 24-Oct-2026). The refusal must:
 *   - be a typed `422 CHANNEL_NOT_SUPPORTED`, disclosing nothing but the channel;
 *   - store nothing: no message, queue row, contact, identity or idempotency record;
 *   - come after authorization, so a principal without `messages.send` learns
 *     nothing about channel support;
 *   - leave WhatsApp, SMS and RCS sends unaffected.
 *
 * Run through `scripts/with-db-clone.mjs`.
 */
import { randomBytes } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

type GatedChannel = 'email' | 'voice';

const GATED: Record<GatedChannel, { recipient: string; payload: Record<string, unknown> }> = {
  email: {
    recipient: 'gated.recipient@example.test',
    payload: { subject: 'Hello', text: 'Must not be stored' },
  },
  voice: { recipient: '+12025550183', payload: { text: 'Must not be stored' } },
};

describe('Phase 4.3 F.3-1: the send path refuses email and voice', () => {
  let h: Harness;
  let credentials: CredentialService;
  let sender: TenantFixture;
  let noSend: TenantFixture;
  let senderToken: string;
  let noSendToken: string;
  const channelIds: Record<string, string> = {};
  const providers: string[] = [];

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    sender = await createTenant(h.admin, 'p43-gate-send', credentials);
    noSend = await createTenant(h.admin, 'p43-gate-nosend', credentials);

    // `messages.send` for the sender only; the other tenant's admin lacks it.
    const [perm] = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(eq(schema.permissions.key, PERMISSIONS.MESSAGES_SEND));
    const roleId = uuidv7();
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: sender.orgId,
      key: `p43_gate_${randomBytes(4).toString('hex')}`,
      name: 'Phase 4.3 channel gating sender',
      description: 'Grants messages.send',
      isSystemRole: false,
      allowedScopeTypes: ['organization'],
    });
    await h.admin
      .insert(schema.rolePermissions)
      .values({ roleId, permissionId: perm!.id, orgId: sender.orgId });
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
      await tx.insert(schema.userRoles).values({
        userId: sender.userId,
        roleId,
        scopeType: 'organization',
        scopeId: sender.orgId,
      });
    });

    const rows = await h.admin
      .select({
        id: schema.channels.id,
        code: schema.channels.code,
        status: schema.channels.status,
      })
      .from(schema.channels)
      .where(inArray(schema.channels.code, ['email', 'voice', 'whatsapp']));
    for (const row of rows) {
      // The gate, not a disabled channel, must be what refuses.
      expect(row.status).toBe('active');
      channelIds[row.code] = row.id;
    }

    // An active assignment on every channel used, so no other preflight refuses.
    for (const code of ['email', 'voice', 'whatsapp']) {
      const slug = `p43-gate-${code}-${randomBytes(4).toString('hex')}`;
      const [p] = await h.admin
        .insert(schema.providers)
        .values({
          channelId: channelIds[code]!,
          name: `Channel gating ${slug}`,
          slug,
          adapterKey: 'simulator',
          status: 'active',
          healthState: 'healthy',
          circuitState: 'closed',
        })
        .returning();
      providers.push(p!.id);
      await h.admin.insert(schema.organizationProviderAssignments).values({
        orgId: sender.orgId,
        channelId: channelIds[code]!,
        providerId: p!.id,
        priority: 1,
        status: 'active',
      });
    }

    await h.clearRateLimits();
    senderToken = (
      await request(h.app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email: sender.email, password: PASSWORD })
        .expect(200)
    ).body.data.accessToken;
    await h.clearRateLimits();
    noSendToken = (
      await request(h.app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email: noSend.email, password: PASSWORD })
        .expect(200)
    ).body.data.accessToken;
  }, 60_000);

  afterAll(async () => {
    try {
      // destroyTenant removes each tenant's messages, contacts, assignments,
      // idempotency records and (with the organization) its custom role.
      for (const t of [sender, noSend]) {
        if (t) await destroyTenant(h.admin, t).catch(() => {});
      }
      if (providers.length > 0) {
        await h.admin
          .delete(schema.providers)
          .where(inArray(schema.providers.id, providers))
          .catch(() => {});
      }
    } finally {
      await h.close();
    }
  });

  function send(token: string, orgId: string, body: Record<string, unknown>, key?: string) {
    const req = request(h.app.getHttpServer())
      .post(url('/messages'))
      .set('Authorization', `Bearer ${token}`)
      .set('X-Acc-Organization', orgId);
    if (key) req.set('Idempotency-Key', key);
    return req.send(body);
  }

  async function countFor(orgId: string) {
    const count = async (table: string) => {
      const { rows } = await h.admin.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM ${sql.raw(table)} WHERE org_id = ${orgId}`,
      );
      return Number(rows[0]!.n);
    };
    return {
      messages: await count('messages'),
      queue: await count('message_dispatch_queue'),
      contacts: await count('contacts'),
      identities: await count('contact_identities'),
      idempotency: await count('idempotency_keys'),
    };
  }

  it.each(['email', 'voice'] as const)(
    '%s: 422 CHANNEL_NOT_SUPPORTED, nothing stored, no idempotency record, a retry refused alike',
    async (channel: GatedChannel) => {
      const before = await countFor(sender.orgId);
      const key = `p43-gate-${channel}-${randomBytes(6).toString('hex')}`;
      const body = { channelCode: channel, ...GATED[channel] };

      for (let i = 0; i < 2; i += 1) {
        const res = await send(senderToken, sender.orgId, body, key).expect(422);
        expect(res.body.error.code).toBe(ERROR_CODES.CHANNEL_NOT_SUPPORTED);
        expect(res.body.error.message).toBe(
          `Channel '${channel}' does not support sending messages`,
        );
        // Discloses the channel only: not the recipient, payload, tenant or provider.
        const raw = JSON.stringify(res.body);
        for (const secret of [
          GATED[channel].recipient,
          'Must not be stored',
          sender.orgId,
          ...providers,
        ]) {
          expect(raw).not.toContain(secret);
        }
      }

      expect(await countFor(sender.orgId)).toEqual(before);
    },
  );

  it('a principal without messages.send is refused 403 before the channel is considered', async () => {
    for (const channel of ['email', 'voice'] as const) {
      const res = await send(noSendToken, noSend.orgId, {
        channelCode: channel,
        ...GATED[channel],
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).not.toBe(ERROR_CODES.CHANNEL_NOT_SUPPORTED);
    }
  });

  it('an unknown channel is still 404, not CHANNEL_NOT_SUPPORTED', async () => {
    const res = await send(senderToken, sender.orgId, {
      channelCode: 'fax',
      recipient: '+12025550184',
      payload: { text: 'x' },
    }).expect(404);
    expect(res.body.error.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
  });

  it('WhatsApp sends are unaffected: 202 and queued', async () => {
    const res = await send(senderToken, sender.orgId, {
      channelCode: 'whatsapp',
      recipient: '+12025550185',
      payload: { text: 'Hello' },
    }).expect(202);
    const [m] = await h.admin
      .select({ status: schema.messages.status, orgId: schema.messages.orgId })
      .from(schema.messages)
      .where(
        and(eq(schema.messages.id, res.body.data.id), eq(schema.messages.orgId, sender.orgId)),
      );
    expect(m).toEqual({ status: 'queued', orgId: sender.orgId });
  });
});
