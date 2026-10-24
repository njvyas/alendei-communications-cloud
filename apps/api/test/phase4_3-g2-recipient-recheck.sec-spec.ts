/**
 * Phase 4.3 G-2 (approach B, migration 0037): the database side of the
 * dispatch-time recipient re-check.
 *
 * `app_dispatch_recipient_block()` lets `acc_dispatch` ask whether the message
 * it holds a live claim on may still be sent, without any grant on
 * `suppressions` or `consent_events`. This suite proves:
 *   1. Least privilege — exact definition (SECURITY DEFINER, STABLE, no
 *      arguments, pinned search_path, text result), EXECUTE for `acc_dispatch`
 *      only, `acc_app` refused live, and `acc_dispatch` still without any table
 *      privilege on either table.
 *   2. Claim and lease validation — no dispatch context, a wrong claim token, an
 *      expired lease, another organization's context, or another message's
 *      claim token all raise `insufficient_privilege` instead of answering; a
 *      live claim answers (positive control).
 *   3. Tenant isolation — another organization's suppression of the same
 *      address, and a suppression on another channel, never block; each tenant
 *      sees only its own verdict.
 *   4. Rules — suppression before consent, cleared suppressions ignored, and the
 *      consent "latest group" taken at millisecond precision, as the send path.
 *
 * End-to-end dispatch behaviour and send/dispatch parity are in
 * `phase4_3-g2-dispatch-recheck.int-spec.ts`. Run through
 * `scripts/with-db-clone.mjs`.
 */
import { randomUUID } from 'node:crypto';
import { schema } from '@acc/db';
import { inArray, sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { uuidv7 } from 'uuidv7';

import { DISPATCH_POOL } from '../src/database/database.tokens';
import { CredentialService } from '../src/iam/credential.service';
import {
  createTenant,
  destroyTenant,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

interface Planted {
  readonly tenant: TenantFixture;
  readonly messageId: string;
  readonly contactId: string;
  readonly channelId: string;
  readonly token: string;
}

describe('Phase 4.3 G-2: app_dispatch_recipient_block() privileges, claim validation and isolation', () => {
  let h: Harness;
  let dispatchPool: Pool;
  let appPool: Pool;
  const channelIds: Record<string, string> = {};
  let a: TenantFixture;
  let b: TenantFixture;
  let seq = 0;

  beforeAll(async () => {
    h = await startHarness();
    const credentials = h.app.get(CredentialService);
    dispatchPool = h.app.get(DISPATCH_POOL);
    appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    const rows = await h.admin
      .select({ id: schema.channels.id, code: schema.channels.code })
      .from(schema.channels)
      .where(inArray(schema.channels.code, ['sms', 'whatsapp']));
    for (const row of rows) channelIds[row.code] = row.id;
    a = await createTenant(h.admin, 'g2-sec-a', credentials);
    b = await createTenant(h.admin, 'g2-sec-b', credentials);
  }, 60_000);

  beforeEach(async () => {
    await h.admin.delete(schema.messageDispatchQueue);
  });

  afterAll(async () => {
    try {
      if (appPool) await appPool.end();
      if (dispatchPool) await dispatchPool.end();
      const orgIds = [a, b].filter(Boolean).map((t) => t.orgId);
      if (orgIds.length > 0) {
        await h.admin.delete(schema.messageDispatchQueue).catch(() => {});
        await h.admin
          .delete(schema.messages)
          .where(inArray(schema.messages.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.consentEvents)
          .where(inArray(schema.consentEvents.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.suppressions)
          .where(inArray(schema.suppressions.orgId, orgIds))
          .catch(() => {});
        await h.admin
          .delete(schema.contacts)
          .where(inArray(schema.contacts.orgId, orgIds))
          .catch(() => {});
      }
      for (const t of [a, b]) if (t) await destroyTenant(h.admin, t).catch(() => {});
    } finally {
      await h.close();
    }
  });

  // --- fixtures ---------------------------------------------------------------

  function nextAddress(): string {
    seq += 1;
    return `+1202555${String(7000 + seq).padStart(4, '0')}`;
  }

  /** A queued message with a claim on its queue row: live by default, or already expired. */
  async function planted(
    t: TenantFixture,
    address: string,
    { channel = 'sms', lease = 'live' }: { channel?: string; lease?: 'live' | 'expired' } = {},
  ): Promise<Planted> {
    const contactId = uuidv7();
    await h.admin.insert(schema.contacts).values({
      id: contactId,
      orgId: t.orgId,
      workspaceId: t.workspaceId,
      displayName: 'G-2 recipient',
    });
    const messageId = uuidv7();
    await h.admin.insert(schema.messages).values({
      id: messageId,
      orgId: t.orgId,
      workspaceId: t.workspaceId,
      contactId,
      channelId: channelIds[channel]!,
      recipientAddress: address,
      status: 'queued',
      payload: { text: 'G-2' },
      correlationId: uuidv7(),
    });
    const token = randomUUID();
    await h.admin.insert(schema.messageDispatchQueue).values({
      messageId,
      orgId: t.orgId,
      priority: 1,
      dispatchEpoch: 1,
      claimToken: token,
      claimedBy: 'g2-sec-spec',
      claimedUntil: new Date(Date.now() + (lease === 'live' ? 30_000 : -1_000)),
    });
    return { tenant: t, messageId, contactId, channelId: channelIds[channel]!, token };
  }

  async function suppress(
    t: TenantFixture,
    address: string,
    channel: string | null,
    status: 'active' | 'cleared' = 'active',
  ): Promise<void> {
    await h.admin.insert(schema.suppressions).values({
      orgId: t.orgId,
      channelId: channel ? channelIds[channel]! : null,
      rawAddress: address,
      normalizedAddress: address,
      reason: 'G-2 test',
      status,
      ...(status === 'cleared' ? { clearedAt: new Date(), clearedReason: 'G-2 test' } : {}),
    });
  }

  /** One consent event at an exact timestamp (microseconds kept: a literal, not a Date). */
  async function consent(p: Planted, event: 'grant' | 'revoke', occurredAt: string): Promise<void> {
    await h.admin.execute(sql`
      INSERT INTO consent_events (id, org_id, workspace_id, contact_id, channel_id, consent_type, event, occurred_at, source)
      VALUES (${uuidv7()}, ${p.tenant.orgId}, ${p.tenant.workspaceId}, ${p.contactId}, ${p.channelId},
              'transactional', ${event}, ${occurredAt}::timestamptz, 'g2-sec-spec')`);
  }

  /** Runs `fn` as acc_dispatch in one transaction with the given dispatch context, then rolls back. */
  async function asDispatch<T>(
    ctx: { orgId: string; messageId: string; token: string } | null,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await dispatchPool.connect();
    try {
      await client.query('BEGIN');
      if (ctx) {
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.dispatch_message_id', $2, true),
                  set_config('app.dispatch_claim_token', $3, true)`,
          [ctx.orgId, ctx.messageId, ctx.token],
        );
      }
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  const verdictOf = (p: Planted) =>
    asDispatch(
      { orgId: p.tenant.orgId, messageId: p.messageId, token: p.token },
      async (c) =>
        (await c.query<{ v: string | null }>('SELECT app_dispatch_recipient_block() AS v')).rows[0]!
          .v,
    );

  const refusal = { code: '42501' };

  // --- 1. least privilege -----------------------------------------------------

  describe('1. least privilege', () => {
    it('is SECURITY DEFINER, STABLE, argument-free, text-returning, with a pinned search_path and EXECUTE for acc_dispatch only', async () => {
      const { rows } = await h.admin.execute<{
        owner: string;
        secdef: boolean;
        volatility: string;
        nargs: number;
        rettype: string;
        retset: boolean;
        config: string[] | null;
        acl: string;
        exec: boolean[];
      }>(sql`
        SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef,
               p.provolatile AS volatility, p.pronargs AS nargs,
               format_type(p.prorettype, NULL) AS rettype, p.proretset AS retset,
               p.proconfig AS config, p.proacl::text AS acl,
               ARRAY[has_function_privilege('public', p.oid, 'EXECUTE'),
                     has_function_privilege('acc_app', p.oid, 'EXECUTE'),
                     has_function_privilege('acc_auth', p.oid, 'EXECUTE'),
                     has_function_privilege('acc_relay', p.oid, 'EXECUTE'),
                     has_function_privilege('acc_dispatch', p.oid, 'EXECUTE')] AS exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'app_dispatch_recipient_block'`);
      expect(rows).toEqual([
        {
          owner: 'postgres',
          secdef: true,
          volatility: 's',
          nargs: 0,
          rettype: 'text',
          retset: false,
          config: ['search_path=public, pg_temp'],
          acl: '{postgres=X/postgres,acc_dispatch=X/postgres}',
          exec: [false, false, false, false, true],
        },
      ]);
    });

    it('acc_app cannot call it, even with a live claim in its context', async () => {
      const p = await planted(a, nextAddress());
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT set_config('app.current_org_id', $1, true),
                  set_config('app.dispatch_message_id', $2, true),
                  set_config('app.dispatch_claim_token', $3, true)`,
          [a.orgId, p.messageId, p.token],
        );
        await expect(client.query('SELECT app_dispatch_recipient_block()')).rejects.toMatchObject(
          refusal,
        );
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

    it('acc_dispatch still holds no privilege on suppressions or consent_events, and cannot read either under a live claim', async () => {
      const { rows } = await h.admin.execute<{ tbl: string; privs: boolean[] }>(sql`
        SELECT t AS tbl,
               ARRAY[has_table_privilege('acc_dispatch', t, 'SELECT'),
                     has_table_privilege('acc_dispatch', t, 'INSERT'),
                     has_table_privilege('acc_dispatch', t, 'UPDATE'),
                     has_table_privilege('acc_dispatch', t, 'DELETE'),
                     has_any_column_privilege('acc_dispatch', t, 'SELECT')] AS privs
        FROM unnest(ARRAY['suppressions', 'consent_events']) AS t ORDER BY t`);
      expect(rows).toEqual([
        { tbl: 'consent_events', privs: [false, false, false, false, false] },
        { tbl: 'suppressions', privs: [false, false, false, false, false] },
      ]);

      const p = await planted(a, nextAddress());
      await asDispatch({ orgId: a.orgId, messageId: p.messageId, token: p.token }, async (c) => {
        for (const table of ['suppressions', 'consent_events']) {
          await c.query('SAVEPOINT probe');
          await expect(c.query(`SELECT 1 FROM ${table} LIMIT 1`)).rejects.toMatchObject(refusal);
          await c.query('ROLLBACK TO SAVEPOINT probe');
        }
      });
    });
  });

  // --- 2. claim and lease validation ------------------------------------------

  describe('2. claim and lease validation', () => {
    it('a live claim answers (positive control): NULL when clear, the code once suppressed', async () => {
      const address = nextAddress();
      const p = await planted(a, address);
      expect(await verdictOf(p)).toBeNull();
      await suppress(a, address, 'sms');
      expect(await verdictOf(p)).toBe('RECIPIENT_SUPPRESSED');
    });

    it('refuses to answer without a live claim on the message in its own context', async () => {
      const address = nextAddress();
      const p = await planted(a, address);
      const expired = await planted(a, address, { lease: 'expired' });
      const other = await planted(b, nextAddress());
      // Something to report if any of these were wrongly answered.
      await suppress(a, address, null);

      const contexts: Array<[string, { orgId: string; messageId: string; token: string } | null]> =
        [
          ['no dispatch context', null],
          ['wrong claim token', { orgId: a.orgId, messageId: p.messageId, token: randomUUID() }],
          ['expired lease', { orgId: a.orgId, messageId: expired.messageId, token: expired.token }],
          [
            'another organization’s context',
            { orgId: b.orgId, messageId: p.messageId, token: p.token },
          ],
          [
            'another message’s claim token',
            { orgId: a.orgId, messageId: p.messageId, token: other.token },
          ],
          [
            'another tenant’s message under this tenant’s context',
            { orgId: a.orgId, messageId: other.messageId, token: other.token },
          ],
        ];
      for (const [label, ctx] of contexts) {
        await expect(
          asDispatch(ctx, (c) => c.query('SELECT app_dispatch_recipient_block()')).then(
            () => `${label}: answered`,
          ),
        ).rejects.toMatchObject(refusal);
      }
    });

    it('a claim released after a fallback (token cleared) is not a live claim', async () => {
      const p = await planted(a, nextAddress());
      await h.admin.execute(
        sql`UPDATE message_dispatch_queue SET claim_token = NULL, claimed_until = NULL WHERE message_id = ${p.messageId}`,
      );
      await expect(verdictOf(p)).rejects.toMatchObject(refusal);
    });
  });

  // --- 3. tenant isolation ----------------------------------------------------

  describe('3. tenant isolation', () => {
    it('another organization’s suppression of the same address does not block, and each tenant gets only its own verdict', async () => {
      const address = nextAddress();
      const pa = await planted(a, address);
      const pb = await planted(b, address);
      await suppress(b, address, null);
      await suppress(b, address, 'sms');

      expect(await verdictOf(pa)).toBeNull();
      expect(await verdictOf(pb)).toBe('RECIPIENT_SUPPRESSED');
    });

    it('another organization’s revoke for its own contact does not block this tenant', async () => {
      const address = nextAddress();
      const pa = await planted(a, address);
      const pb = await planted(b, address);
      await consent(pb, 'revoke', '2026-10-24T10:00:00.000Z');

      expect(await verdictOf(pa)).toBeNull();
      expect(await verdictOf(pb)).toBe('CONSENT_REVOKED');
    });
  });

  // --- 4. rules ---------------------------------------------------------------

  describe('4. rules', () => {
    it('ignores a suppression on another channel and a cleared suppression', async () => {
      const address = nextAddress();
      const p = await planted(a, address);
      await suppress(a, address, 'whatsapp');
      await suppress(a, address, 'sms', 'cleared');
      await suppress(a, address, null, 'cleared');
      expect(await verdictOf(p)).toBeNull();
    });

    it('reports suppression before consent, as the send path checks it first', async () => {
      const address = nextAddress();
      const p = await planted(a, address);
      await consent(p, 'revoke', '2026-10-24T10:00:00.000Z');
      expect(await verdictOf(p)).toBe('CONSENT_REVOKED');
      await suppress(a, address, null);
      expect(await verdictOf(p)).toBe('RECIPIENT_SUPPRESSED');
    });

    it('consent: only the latest group counts, grouped at millisecond precision', async () => {
      const revokedThenGranted = await planted(a, nextAddress());
      await consent(revokedThenGranted, 'revoke', '2026-10-24T10:00:00.000Z');
      await consent(revokedThenGranted, 'grant', '2026-10-24T10:00:01.000Z');
      expect(await verdictOf(revokedThenGranted)).toBeNull();

      const grantedThenRevoked = await planted(a, nextAddress());
      await consent(grantedThenRevoked, 'grant', '2026-10-24T10:00:00.000Z');
      await consent(grantedThenRevoked, 'revoke', '2026-10-24T10:00:01.000Z');
      expect(await verdictOf(grantedThenRevoked)).toBe('CONSENT_REVOKED');

      // Revoke 500 µs before the grant, in the same millisecond: one group for
      // the send path (JavaScript Date precision), so it is revoked here too.
      const sameMillisecond = await planted(a, nextAddress());
      await consent(sameMillisecond, 'revoke', '2026-10-24T10:00:00.123400Z');
      await consent(sameMillisecond, 'grant', '2026-10-24T10:00:00.123900Z');
      expect(await verdictOf(sameMillisecond)).toBe('CONSENT_REVOKED');

      // One millisecond apart: two groups, the later grant wins.
      const nextMillisecond = await planted(a, nextAddress());
      await consent(nextMillisecond, 'revoke', '2026-10-24T10:00:00.123900Z');
      await consent(nextMillisecond, 'grant', '2026-10-24T10:00:00.124000Z');
      expect(await verdictOf(nextMillisecond)).toBeNull();

      // A revoke on another channel is not this message's consent.
      const otherChannel = await planted(a, nextAddress());
      await consent(
        { ...otherChannel, channelId: channelIds.whatsapp! },
        'revoke',
        '2026-10-24T10:00:00.000Z',
      );
      expect(await verdictOf(otherChannel)).toBeNull();
    });
  });
});
