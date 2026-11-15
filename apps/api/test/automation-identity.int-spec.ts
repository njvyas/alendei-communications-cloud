/**
 * Phase 8B PR 8B-3a — the shared automation sending identity and campaign attribution
 * (PHASE-8B-3-HANDOVER-Rev2 §§3–5; owner decisions OD-8B3-1..6; clarifications C-1..C-8).
 * Disposable clones only (`scripts/with-db-clone.mjs`).
 *
 * TEST-ONLY CALLER. There is no campaign executor in 8B-3a (it is 8B-3b, disabled by default).
 * This suite drives the send transaction (T-send, Rev 2 §6.2) by hand on a pool whose every
 * connection is `SET ROLE acc_campaign`, exactly as the executor will: the claim fence, the
 * capability mint, `authorizeAutomationSubmission`, the shared core with a campaign origin, the
 * recipient update, one COMMIT. Provider dispatch is never reached (the dispatch worker is off).
 *
 * Proves:
 *   - the campaign message is attributed, queued and evented exactly as a direct message;
 *   - K1/K3/the composite FK/CHECKs/write-once/the recipient and lifecycle guards;
 *   - capability mint refusals and validity (wall-clock expiry, revocation, campaign pause,
 *     organisation pause, claim) enforced at the DATABASE: RLS and the reservation refuse;
 *   - owner condition 2: after a pause or revocation commits, no subsequent send is authorised,
 *     and a send in flight is serialised before it;
 *   - C-1: organisation-wide controls need campaigns.manage at ORGANIZATION scope (a workspace
 *     grant is refused), user sessions only; the database rule matches the application's;
 *   - C-5: the journey subject is unavailable; acc_journey can reach none of it;
 *   - the owner-run automation:control CLI path.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS, PLATFORM_ROLE_KEYS } from '@acc/contracts';
import { createDatabase, createPool, schema, type Database, type Transaction } from '@acc/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  purgeAudit,
  purgeMessageEvents,
  removeIdentities,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';
import { applyAutomationControl, AutomationControlRefusal } from '../src/cli/automation-control';
import { ownerAuditWriter } from '../src/cli/bootstrap';
import { CredentialService } from '../src/iam/credential.service';
import { MessageSubmissionCore } from '../src/messages/submission/message-submission.core';
import { authorizeAutomationSubmission } from '../src/messages/submission/submission-authorization';

jest.setTimeout(90_000);

const url = (p: string) => `/${PREFIX}${p}`;
const hex = (n: number) => randomBytes(n).toString('hex');

type PgError = { code?: string; constraint?: string; detail?: string; message?: string };
const pgError = (e: unknown): PgError => {
  for (let x: unknown = e, i = 0; x && i < 4; i++) {
    const c = x as PgError & { cause?: unknown };
    if (typeof c.code === 'string' && /^[0-9A-Z]{5}$/.test(c.code)) return c;
    x = c.cause;
  }
  return { message: e instanceof Error ? e.message : String(e) };
};
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => {
      const g = pgError(e);
      return { code: g.code ?? 'none', constraint: g.constraint ?? null, detail: g.detail ?? null };
    },
  );

interface Fixture {
  readonly tenant: TenantFixture;
  readonly campaignId: string;
  readonly templateId: string;
  readonly recipients: { id: string; contactId: string; address: string }[];
  claimToken: string;
  epoch: number;
}

describe('Phase 8B PR 8B-3a: shared automation identity and campaign attribution', () => {
  let h: Harness;
  let A: TenantFixture;
  let B: TenantFixture;
  let credentials: CredentialService;
  let campaignPool: Pool;
  let campaignDb: Database;
  let appPool: Pool;
  let core: MessageSubmissionCore;
  let waChannel: string;
  let automationRole: string;
  const providers: string[] = [];
  const users: string[] = [];
  const tokens = new Map<string, string>();
  const apiKeys: string[] = [];
  let seq = 0;

  const http = () => request(h.app.getHttpServer());
  const login = async (email: string) =>
    (await http().post(url('/auth/login')).send({ email, password: PASSWORD })).body.data
      .accessToken as string;

  // --- fixtures ---------------------------------------------------------------------------------

  /** A user holding `role` at the given scope of tenant A. */
  async function userWith(
    label: string,
    roleId: string,
    scopeType: 'organization' | 'workspace',
    scopeId: string,
  ) {
    const email = `p8b3-${label}-${hex(5)}@example.test`;
    const [u] = await h.admin
      .insert(schema.users)
      .values({
        email,
        status: 'active',
        passwordHash: await credentials.hash(PASSWORD),
        passwordUpdatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    users.push(u!.id);
    await h.admin.insert(schema.userRoles).values({ userId: u!.id, roleId, scopeType, scopeId });
    return { userId: u!.id, email, token: await login(email) };
  }

  async function provider(t: TenantFixture) {
    const slug = `p8b3-${hex(4)}`;
    const [prov] = await h.admin
      .insert(schema.providers)
      .values({
        channelId: waChannel,
        name: `WA Simulator ${slug}`,
        slug,
        adapterKey: 'simulator',
        status: 'active',
        healthState: 'healthy',
        circuitState: 'closed',
      })
      .returning();
    providers.push(prov!.id);
    await h.admin.insert(schema.organizationProviderAssignments).values({
      orgId: t.orgId,
      channelId: waChannel,
      providerId: prov!.id,
      priority: 1,
      status: 'active',
    });
  }

  /** A RUNNING campaign with `n` pending recipients and a live claim (as app_campaign_claim leaves it). */
  async function runningCampaign(
    t: TenantFixture,
    n: number,
    startedBy = t.userId,
  ): Promise<Fixture> {
    const [tpl] = await h.admin
      .insert(schema.templates)
      .values({
        orgId: t.orgId,
        channelId: waChannel,
        name: `t-${uuidv7()}`,
        body: 'Hello',
        variables: [],
        approvalStatus: 'approved',
      })
      .returning({ id: schema.templates.id });
    const [c] = await h.admin
      .insert(schema.campaigns)
      .values({
        orgId: t.orgId,
        workspaceId: t.workspaceId,
        name: `c-${uuidv7()}`,
        channelId: waChannel,
        templateId: tpl!.id,
        recipientSource: { type: 'all_contacts' },
        status: 'running',
        startedBy,
        startedAt: new Date(),
      })
      .returning({ id: schema.campaigns.id });
    const recipients: Fixture['recipients'] = [];
    for (let i = 0; i < n; i++) {
      const address = `+1202555${String(1000 + ++seq).padStart(4, '0')}`;
      const [contact] = await h.admin
        .insert(schema.contacts)
        .values({ orgId: t.orgId, workspaceId: t.workspaceId, firstName: `r${seq}` })
        .returning({ id: schema.contacts.id });
      const [identity] = await h.admin
        .insert(schema.contactIdentities)
        .values({
          orgId: t.orgId,
          workspaceId: t.workspaceId,
          contactId: contact!.id,
          channelId: waChannel,
          rawAddress: address,
          normalizedAddress: address,
          isPrimary: true,
        })
        .returning({ id: schema.contactIdentities.id });
      const [r] = await h.admin
        .insert(schema.campaignRecipients)
        .values({
          campaignId: c!.id,
          orgId: t.orgId,
          workspaceId: t.workspaceId,
          contactId: contact!.id,
          identityId: identity!.id,
          status: 'pending',
        })
        .returning({ id: schema.campaignRecipients.id });
      recipients.push({ id: r!.id, contactId: contact!.id, address });
    }
    const claimToken = randomUUID();
    await h.admin.execute(
      sql`INSERT INTO campaign_dispatch (campaign_id, org_id, epoch, claim_token, claimed_until, claimed_by)
          VALUES (${c!.id}, ${t.orgId}, 1, ${claimToken}, now() + interval '5 minutes', 'test')`,
    );
    return { tenant: t, campaignId: c!.id, templateId: tpl!.id, recipients, claimToken, epoch: 1 };
  }

  /** Sets the executor session for one recipient (transaction-local), on the acc_campaign connection. */
  const session = (tx: Transaction, f: Fixture, recipientId: string, token = f.claimToken) =>
    tx.execute(sql`SELECT set_config('app.current_org_id', ${f.tenant.orgId}, true),
                          set_config('app.campaign_id', ${f.campaignId}, true),
                          set_config('app.campaign_claim_token', ${token}, true),
                          set_config('app.campaign_recipient_id', ${recipientId}, true),
                          set_config('lock_timeout', '10s', true)`);
  const mint = async (tx: Transaction, recipientId: string, kind = 'campaign_recipient') => {
    const { rows } = await tx.execute<{ t: string }>(
      sql`SELECT app_automation_capability_mint(${kind}::automation_subject_kind, ${recipientId}::uuid) AS t`,
    );
    const token = rows[0]!.t;
    await tx.execute(sql`SELECT set_config('app.automation_capability', ${token}, true)`);
    return token;
  };

  /**
   * T-send (Rev 2 §6.2), test-only caller: fence, mint, proof, core with a campaign origin,
   * recipient sent, COMMIT. `hold` runs after the mint (the FOR SHARE locks are held).
   */
  async function send(
    f: Fixture,
    index: number,
    opts: { hold?: () => Promise<void>; token?: string } = {},
  ): Promise<{ messageId: string; capability: string }> {
    const r = f.recipients[index]!;
    return campaignDb.transaction(async (tx) => {
      await session(tx, f, r.id);
      const fence = await tx.execute(
        sql`SELECT epoch FROM campaign_dispatch WHERE campaign_id = ${f.campaignId} AND claim_token = ${f.claimToken} AND claimed_until > clock_timestamp() FOR UPDATE`,
      );
      if (fence.rows.length !== 1) throw new Error('fenced');
      const capability = opts.token ?? (await mint(tx, r.id));
      if (opts.token)
        await tx.execute(sql`SELECT set_config('app.automation_capability', ${opts.token}, true)`);
      if (opts.hold) await opts.hold();
      const authorization = await authorizeAutomationSubmission(tx, f.tenant.orgId);
      const result = await core.submit(
        tx,
        {
          orgId: f.tenant.orgId,
          correlationId: `campaign:${r.id}`,
          authorization,
          origin: { kind: 'campaign', campaignId: f.campaignId, campaignRecipientId: r.id },
        },
        {
          channelCode: 'whatsapp',
          recipient: r.address,
          templateId: f.templateId,
          workspaceId: f.tenant.workspaceId,
          payload: {},
        },
      );
      await tx.execute(
        sql`UPDATE campaign_recipients SET status = 'sent', message_id = ${result.messageId}, updated_at = now() WHERE id = ${r.id}`,
      );
      return { messageId: result.messageId, capability };
    });
  }
  const sendRefusal = (
    f: Fixture,
    index: number,
    opts: { hold?: () => Promise<void>; token?: string } = {},
  ) => outcome(send(f, index, opts));

  /** A transaction on the acc_campaign pool that is always rolled back. */
  async function asExecutor<T>(
    f: Fixture,
    recipientId: string,
    work: (c: PoolClient) => Promise<T>,
    token = f.claimToken,
  ): Promise<T> {
    const c = await campaignPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.current_org_id', $1, true), set_config('app.campaign_id', $2, true),
                set_config('app.campaign_claim_token', $3, true), set_config('app.campaign_recipient_id', $4, true)`,
        [f.tenant.orgId, f.campaignId, token, recipientId],
      );
      return await work(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }
  const mintIn = async (c: PoolClient, recipientId: string, kind = 'campaign_recipient') => {
    const { rows } = await c.query(
      `SELECT app_automation_capability_mint($1::automation_subject_kind, $2::uuid) AS t`,
      [kind, recipientId],
    );
    await c.query(`SELECT set_config('app.automation_capability', $1, true)`, [rows[0].t]);
    return rows[0].t as string;
  };
  const mintRefusal = (c: PoolClient, recipientId: string, kind = 'campaign_recipient') =>
    outcome(mintIn(c, recipientId, kind));

  /** An owner transaction that is always rolled back. */
  async function rolledBack<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      return await work(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }
  const copyMessage = (c: PoolClient, from: string, changes: Record<string, unknown>) =>
    c.query(
      `INSERT INTO messages SELECT (jsonb_populate_record(NULL::messages, to_jsonb(m) || jsonb_build_object('id', uuidv7()) || $2::jsonb)).* FROM messages m WHERE m.id = $1`,
      [from, JSON.stringify(changes)],
    );
  const row = async (table: string, id: string) =>
    (
      await h.admin.execute<Record<string, unknown>>(
        sql`SELECT to_jsonb(t) AS r FROM ${sql.identifier(table)} t WHERE id = ${id}`,
      )
    ).rows[0]?.r as Record<string, unknown> | undefined;
  const orgMessages = async (orgId: string) =>
    Number(
      (
        await h.admin.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM messages WHERE org_id = ${orgId}`,
        )
      ).rows[0]!.n,
    );
  const setControls = (orgId: string, paused: boolean) =>
    h.admin.execute(
      paused
        ? sql`INSERT INTO automation_controls (org_id, sending_paused, paused_at) VALUES (${orgId}, true, now())
              ON CONFLICT (org_id) DO UPDATE SET sending_paused = true, paused_at = now()`
        : sql`UPDATE automation_controls SET sending_paused = false, paused_at = NULL, paused_by_user_id = NULL, paused_by_label = NULL, pause_reason = NULL, revoked_before = NULL WHERE org_id = ${orgId}`,
    );

  beforeAll(async () => {
    h = await startHarness();
    await h.clearRateLimits();
    credentials = h.app.get(CredentialService);
    A = await createTenant(h.admin, 'p8b3-a', credentials);
    B = await createTenant(h.admin, 'p8b3-b', credentials);
    waChannel = (
      await h.admin
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(eq(schema.channels.code, 'whatsapp'))
    )[0]!.id;
    for (const t of [A, B]) await provider(t);
    // A role carrying the campaign and send permissions, admitted at organization and workspace.
    automationRole = uuidv7();
    await h.admin.insert(schema.roles).values({
      id: automationRole,
      orgId: A.orgId,
      key: `p8b3_automation_${hex(3)}`,
      name: 'Automation managers (8B-3a test)',
      description: 'campaigns.read, campaigns.manage, messages.send, messages.read',
      isSystemRole: false,
      allowedScopeTypes: ['organization', 'workspace'],
    });
    const perms = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(
        inArray(schema.permissions.key, [
          PERMISSIONS.CAMPAIGNS_READ,
          PERMISSIONS.CAMPAIGNS_MANAGE,
          PERMISSIONS.MESSAGES_SEND,
          PERMISSIONS.MESSAGES_READ,
        ]),
      );
    for (const p of perms)
      await h.admin
        .insert(schema.rolePermissions)
        .values({ roleId: automationRole, permissionId: p.id, orgId: A.orgId });
    const orgManager = await userWith('org', automationRole, 'organization', A.orgId);
    const wsManager = await userWith('ws', automationRole, 'workspace', A.workspaceId);
    tokens.set('org', orgManager.token);
    tokens.set('ws', wsManager.token);
    tokens.set('orgAdminNoCampaigns', await login(A.email)); // the harness org_admin: no campaigns.manage
    tokens.set('orgUserId', orgManager.userId);
    tokens.set('wsUserId', wsManager.userId);
    campaignPool = createPool({
      connectionString: process.env.DATABASE_ADMIN_URL!,
      max: 6,
      applicationName: 'acc-test-acc-campaign',
    });
    campaignPool.on('connect', (client) => {
      void client.query('SET ROLE acc_campaign');
    });
    campaignDb = createDatabase(campaignPool);
    appPool = createPool({
      connectionString: process.env.DATABASE_ADMIN_URL!,
      max: 4,
      applicationName: 'acc-test-8b3-owner',
    });
    core = h.app.get(MessageSubmissionCore, { strict: false });
  }, 120_000);

  beforeEach(async () => {
    await h.clearRateLimits();
  });

  afterEach(async () => {
    for (const t of [A, B].filter(Boolean)) await setControls(t.orgId, false);
  });

  afterAll(async () => {
    if (!h) return;
    try {
      await campaignPool?.end();
      await appPool?.end();
      for (const t of [A, B].filter(Boolean)) {
        await purgeMessageEvents(h.admin, eq(schema.messageEvents.orgId, t.orgId));
        await h.admin.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL session_replication_role = replica`);
          for (const table of [
            'automation_capabilities',
            'automation_controls',
            'message_dispatch_queue',
            'campaign_dispatch',
            'messages',
            'campaign_recipients',
            'campaigns',
            'templates',
            'contact_identities',
            'contacts',
            'organization_provider_assignments',
          ])
            await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${t.orgId}`);
          await tx.execute(sql`DELETE FROM role_permissions WHERE role_id = ${automationRole}`);
        });
      }
      for (const id of apiKeys) {
        await purgeAudit(h.admin, sql`actor_api_key_id = ${id}`);
        await h.admin.delete(schema.apiKeys).where(eq(schema.apiKeys.id, id));
      }
      await removeIdentities(h.admin, users);
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        await tx.execute(sql`DELETE FROM roles WHERE id = ${automationRole}`);
      });
      for (const t of [A, B].filter(Boolean)) await destroyTenant(h.admin, t);
      for (const id of providers)
        await h.admin.delete(schema.providers).where(eq(schema.providers.id, id));
    } finally {
      await h.close();
    }
  }, 120_000);

  // ===============================================================================================
  describe('the send transaction under a capability (test-only caller)', () => {
    it('attributes, queues and events the message exactly as a direct one; the capability is recorded by hash only', async () => {
      const f = await runningCampaign(A, 1);
      const r = f.recipients[0]!;
      const { messageId, capability } = await send(f, 0);
      const m = (await row('messages', messageId))!;
      expect(m).toMatchObject({
        campaign_id: f.campaignId,
        campaign_recipient_id: r.id,
        journey_id: null,
        journey_execution_id: null,
        contact_id: r.contactId,
        status: 'queued',
        recipient_address: r.address,
      });
      const queue = await h.admin.execute(
        sql`SELECT dispatch_epoch, claim_token FROM message_dispatch_queue WHERE message_id = ${messageId}`,
      );
      expect(queue.rows).toEqual([{ dispatch_epoch: 0, claim_token: null }]);
      const events = await h.admin.execute<{ payload: unknown }>(
        sql`SELECT payload FROM message_events WHERE message_id = ${messageId} AND event_type = 'message.queued'`,
      );
      expect(events.rows.map((e) => e.payload)).toEqual([
        { channelCode: 'whatsapp', recipient: r.address },
      ]);
      expect(await row('campaign_recipients', r.id)).toMatchObject({
        status: 'sent',
        message_id: messageId,
      });
      const caps = await h.admin.execute<Record<string, unknown>>(
        sql`SELECT subject_kind, subject_id, automation_id, claim_epoch, initiator_user_id, encode(token_hash, 'hex') AS h,
                   expires_at <= issued_at + interval '30 seconds' AS bounded, revoked_at FROM automation_capabilities WHERE subject_id = ${r.id}`,
      );
      expect(caps.rows).toEqual([
        {
          subject_kind: 'campaign_recipient',
          subject_id: r.id,
          automation_id: f.campaignId,
          claim_epoch: 1,
          initiator_user_id: A.userId,
          h: createHash('sha256').update(capability).digest('hex'),
          bounded: true,
          revoked_at: null,
        },
      ]);
      // The token itself is stored nowhere.
      const leak = await h.admin.execute(
        sql`SELECT 1 FROM automation_capabilities WHERE encode(token_hash, 'escape') LIKE ${'%' + capability + '%'}`,
      );
      expect(leak.rows).toEqual([]);
    });

    it('parity: every column equals a direct POST /messages for the same request, except ids, timestamps, correlation and attribution', async () => {
      const f = await runningCampaign(A, 1);
      const { messageId } = await send(f, 0);
      const direct = await http()
        .post(url('/messages'))
        .set('authorization', `Bearer ${tokens.get('org')}`)
        .set('X-Acc-Organization', A.orgId)
        .set('Idempotency-Key', randomUUID())
        .send({
          channelCode: 'whatsapp',
          recipient: f.recipients[0]!.address,
          templateId: f.templateId,
          workspaceId: A.workspaceId,
          payload: {},
        });
      expect(direct.status).toBe(202);
      const skip = [
        'id',
        'created_at',
        'updated_at',
        'correlation_id',
        'campaign_id',
        'campaign_recipient_id',
      ];
      const strip = (x: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(x).filter(([k]) => !skip.includes(k)));
      const d = (await row('messages', direct.body.data.id))!;
      expect(d).toMatchObject({ campaign_id: null, campaign_recipient_id: null, journey_id: null });
      expect(strip((await row('messages', messageId))!)).toEqual(strip(d));
    });
  });

  // ===============================================================================================
  describe('database rules (owner, rolled back)', () => {
    let f: Fixture;
    let m1: string;
    beforeAll(async () => {
      f = await runningCampaign(A, 3);
      m1 = (await send(f, 0)).messageId;
    });

    it('K1: a second message for one recipient is refused (org_id, campaign_id, campaign_recipient_id)', async () => {
      expect(await rolledBack((c) => outcome(copyMessage(c, m1, {})))).toEqual({
        code: '23505',
        constraint: 'uq_messages_campaign_recipient',
        detail: expect.any(String),
      });
    });

    it("the composite FK refuses another recipient's contact, another campaign, another organization", async () => {
      const other = await runningCampaign(A, 1);
      for (const changes of [
        { campaign_recipient_id: f.recipients[1]!.id }, // contact mismatch
        { campaign_id: other.campaignId, campaign_recipient_id: f.recipients[1]!.id },
      ])
        expect((await rolledBack((c) => outcome(copyMessage(c, m1, changes))))?.constraint).toBe(
          'messages_campaign_recipient_fk',
        );
    });

    it('shape and single-origin CHECKs', async () => {
      expect(
        (await rolledBack((c) => outcome(copyMessage(c, m1, { campaign_recipient_id: null }))))
          ?.constraint,
      ).toBe('messages_campaign_shape');
      expect(
        (
          await rolledBack((c) =>
            outcome(copyMessage(c, m1, { journey_id: uuidv7(), journey_execution_id: uuidv7() })),
          )
        )?.constraint,
      ).toBe('messages_single_origin');
    });

    it('write-once: the campaign attribution never changes after insert, owner included', async () => {
      expect(
        await rolledBack((c) =>
          outcome(
            c.query(
              `UPDATE messages SET campaign_id = NULL, campaign_recipient_id = NULL WHERE id = $1`,
              [m1],
            ),
          ),
        ),
      ).toEqual({ code: '42501', constraint: 'messages_campaign_id_immutable', detail: null });
    });

    it('K3: a message names at most one recipient (guard bypassed to reach the index)', async () => {
      expect(
        await rolledBack(async (c) => {
          await c.query('SET LOCAL session_replication_role = replica');
          return outcome(
            c.query(
              `UPDATE campaign_recipients SET status = 'sent', message_id = $1 WHERE id = $2`,
              [m1, f.recipients[1]!.id],
            ),
          );
        }),
      ).toMatchObject({ code: '23505', constraint: 'uq_campaign_recipients_message' });
    });

    it("the recipient guard: terminal rows are immutable; another recipient's message is refused", async () => {
      expect(
        (
          await rolledBack((c) =>
            outcome(
              c.query(
                `UPDATE campaign_recipients SET status = 'pending', message_id = NULL WHERE id = $1`,
                [f.recipients[0]!.id],
              ),
            ),
          )
        )?.code,
      ).toBe('23001');
      expect(
        await rolledBack((c) =>
          outcome(
            c.query(
              `UPDATE campaign_recipients SET status = 'sent', message_id = $1 WHERE id = $2`,
              [m1, f.recipients[1]!.id],
            ),
          ),
        ),
      ).toMatchObject({ code: '23514', constraint: 'campaign_recipients_message_attribution' });
      expect(
        await rolledBack((c) =>
          outcome(
            c.query(`UPDATE campaign_recipients SET status = 'sent' WHERE id = $1`, [
              f.recipients[1]!.id,
            ]),
          ),
        ),
      ).toMatchObject({ code: '23514', constraint: 'campaign_recipients_sent_shape' });
    });

    it('the recipient guard fails closed when it cannot read the message (N1 lesson)', async () => {
      const r2 = f.recipients[2]!;
      expect(
        await rolledBack(async (c) => {
          const { rows } = await c.query(
            `INSERT INTO messages SELECT (jsonb_populate_record(NULL::messages, to_jsonb(m) || jsonb_build_object('id', uuidv7(), 'contact_id', $2::uuid, 'campaign_recipient_id', $3::uuid))).* FROM messages m WHERE m.id = $1 RETURNING id`,
            [m1, r2.contactId, r2.id],
          );
          await c.query('ALTER FUNCTION app_campaign_recipients_guard() OWNER TO acc_app');
          return outcome(
            c.query(
              `UPDATE campaign_recipients SET status = 'sent', message_id = $1 WHERE id = $2`,
              [rows[0].id, r2.id],
            ),
          );
        }),
      ).toMatchObject({
        code: '23503',
        constraint: 'campaign_recipients_message_id_messages_id_fk',
      });
    });

    it('the campaign lifecycle guard: terminal states and illegal moves are refused; started_by is write-once', async () => {
      expect(
        await rolledBack((c) =>
          outcome(c.query(`UPDATE campaigns SET status = 'draft' WHERE id = $1`, [f.campaignId])),
        ),
      ).toMatchObject({ code: '23514', constraint: 'campaigns_lifecycle' });
      expect(
        await rolledBack((c) =>
          outcome(
            c.query(`UPDATE campaigns SET started_by = $2 WHERE id = $1`, [f.campaignId, B.userId]),
          ),
        ),
      ).toMatchObject({ code: '23514', constraint: 'campaigns_start_write_once' });
      expect(
        await rolledBack(async (c) => {
          await c.query(`UPDATE campaigns SET status = 'completed' WHERE id = $1`, [f.campaignId]);
          return outcome(
            c.query(`UPDATE campaigns SET status = 'running' WHERE id = $1`, [f.campaignId]),
          );
        }),
      ).toMatchObject({ code: '23514', constraint: 'campaigns_lifecycle' });
    });
  });

  // ===============================================================================================
  describe('capabilities are enforced at the database boundary (C-4)', () => {
    it('mint refuses: wrong claim token, expired lease, another recipient, a non-pending recipient, a campaign not running, a paused organization; journey subjects', async () => {
      const f = await runningCampaign(A, 2);
      const r = f.recipients;
      await send(f, 0); // r[0] is now sent
      expect(
        await asExecutor(f, r[1]!.id, (c) => mintRefusal(c, r[1]!.id), randomUUID()),
      ).toMatchObject({ code: '42501', detail: 'CLAIM_LOST' });
      expect(await asExecutor(f, r[1]!.id, (c) => mintRefusal(c, r[0]!.id))).toMatchObject({
        code: '42501',
        detail: 'SUBJECT_MISMATCH',
      });
      expect(await asExecutor(f, r[0]!.id, (c) => mintRefusal(c, r[0]!.id))).toMatchObject({
        code: '42501',
        detail: 'RECIPIENT_NOT_PENDING',
      });
      expect(
        await asExecutor(f, r[1]!.id, (c) => mintRefusal(c, r[1]!.id, 'journey_execution')),
      ).toMatchObject({ code: '42501', detail: 'SUBJECT_UNAVAILABLE' });
      await setControls(A.orgId, true);
      expect(await asExecutor(f, r[1]!.id, (c) => mintRefusal(c, r[1]!.id))).toMatchObject({
        code: '42501',
        detail: 'AUTOMATION_PAUSED',
      });
      await setControls(A.orgId, false);
      await h.admin.execute(
        sql`UPDATE campaign_dispatch SET claimed_until = now() - interval '1 second' WHERE campaign_id = ${f.campaignId}`,
      );
      expect(await asExecutor(f, r[1]!.id, (c) => mintRefusal(c, r[1]!.id))).toMatchObject({
        code: '42501',
        detail: 'CLAIM_LOST',
      });
      await h.admin.execute(
        sql`UPDATE campaign_dispatch SET claimed_until = now() + interval '5 minutes' WHERE campaign_id = ${f.campaignId}`,
      );
      await h.admin.execute(sql`UPDATE campaigns SET status = 'paused' WHERE id = ${f.campaignId}`);
      expect(await asExecutor(f, r[1]!.id, (c) => mintRefusal(c, r[1]!.id))).toMatchObject({
        code: '42501',
        detail: 'CAMPAIGN_NOT_RUNNING',
      });
    });

    it('without a valid capability acc_campaign reads no contact and writes no message, queue row or event; the reservation refuses', async () => {
      const f = await runningCampaign(A, 1);
      const r = f.recipients[0]!;
      const other = (await runningCampaign(A, 1)).recipients[0]!;
      await asExecutor(f, r.id, async (c) => {
        expect((await c.query('SELECT id FROM contacts')).rows).toEqual([]);
        expect((await c.query('SELECT id FROM templates')).rows).toEqual([]);
        expect(
          await outcome(
            c.query(
              `INSERT INTO messages (org_id, workspace_id, contact_id, channel_id, recipient_address, payload, correlation_id, campaign_id, campaign_recipient_id) VALUES ($1, $2, $3, $4, 'x', '{}', 'c', $5, $6)`,
              [A.orgId, A.workspaceId, r.contactId, waChannel, f.campaignId, r.id],
            ),
          ),
        ).toMatchObject({ code: '42501' });
      });
      // In a fresh transaction (the refused INSERT aborted that one): the reservation refuses too.
      await asExecutor(f, r.id, async (c) => {
        expect(
          await outcome(c.query(`SELECT * FROM app_message_reserve($1)`, [uuidv7()])),
        ).toMatchObject({ code: '42501' });
      });
      // With a valid capability: only the session recipient's contact; never another's.
      await asExecutor(f, r.id, async (c) => {
        await mintIn(c, r.id);
        expect((await c.query('SELECT id FROM contacts')).rows.map((x) => x.id)).toEqual([
          r.contactId,
        ]);
        expect(
          (await c.query('SELECT id FROM contacts WHERE id = $1', [other.contactId])).rows,
        ).toEqual([]);
      });
    });

    it("the reservation admits a capability only for its subject's own message (the one per-message path)", async () => {
      const f = await runningCampaign(A, 2);
      const { messageId } = await send(f, 0);
      const foreign = (await send(f, 1)).messageId;
      const g = await runningCampaign(A, 1);
      const own = g.recipients[0]!;
      await campaignDb
        .transaction(async (tx) => {
          await session(tx, g, own.id);
          await mint(tx, own.id);
          const auth = await authorizeAutomationSubmission(tx, A.orgId);
          const res = await core.submit(
            tx,
            {
              orgId: A.orgId,
              correlationId: 'c',
              authorization: auth,
              origin: { kind: 'campaign', campaignId: g.campaignId, campaignRecipientId: own.id },
            },
            {
              channelCode: 'whatsapp',
              recipient: own.address,
              templateId: g.templateId,
              workspaceId: A.workspaceId,
              payload: {},
            },
          );
          // Own message: admitted (then refused only because tests run without billing enforcement).
          expect(
            await outcome(
              tx.execute(sql`SELECT * FROM app_message_reserve(${res.messageId}::uuid)`),
            ),
          ).toMatchObject({ code: '22023' });
          throw new Error('rollback');
        })
        .catch((e: unknown) => {
          if (!(e instanceof Error && e.message === 'rollback')) throw e;
        });
      // Another subject's messages (another campaign's recipients): refused, each in its own transaction.
      for (const other of [messageId, foreign]) {
        await campaignDb
          .transaction(async (tx) => {
            await session(tx, g, own.id);
            await mint(tx, own.id);
            expect(
              await outcome(tx.execute(sql`SELECT * FROM app_message_reserve(${other}::uuid)`)),
            ).toMatchObject({ code: '42501' });
            throw new Error('rollback');
          })
          .catch((e: unknown) => {
            if (!(e instanceof Error && e.message === 'rollback')) throw e;
          });
      }
    });

    it('expiry is wall-clock: a capability expires inside one long transaction, and the core then cannot insert', async () => {
      const f = await runningCampaign(A, 1);
      await h.admin.execute(
        sql`UPDATE campaign_dispatch SET claimed_until = now() + interval '1500 milliseconds' WHERE campaign_id = ${f.campaignId}`,
      );
      const before = await orgMessages(A.orgId);
      const refused = await sendRefusal(f, 0, {
        hold: async () => {
          await new Promise((res) => setTimeout(res, 2_000));
        },
      });
      expect(refused).not.toBeNull();
      expect(await orgMessages(A.orgId)).toBe(before);
    });

    it('a capability issued before an organisation-wide revocation, or revoked itself, is void in a later transaction', async () => {
      const f = await runningCampaign(A, 2);
      const r = f.recipients[0]!;
      const token = await campaignDb.transaction(async (tx) => {
        await session(tx, f, r.id);
        return mint(tx, r.id); // committed, nothing sent
      });
      await asExecutor(f, r.id, async (c) => {
        await c.query(`SELECT set_config('app.automation_capability', $1, true)`, [token]);
        expect((await c.query('SELECT app_automation_capability_valid() AS v')).rows[0].v).toBe(
          true,
        );
      });
      await h.admin.execute(
        sql`UPDATE automation_capabilities SET revoked_at = clock_timestamp() WHERE subject_id = ${r.id}`,
      );
      await asExecutor(f, r.id, async (c) => {
        await c.query(`SELECT set_config('app.automation_capability', $1, true)`, [token]);
        expect((await c.query('SELECT app_automation_capability_valid() AS v')).rows[0].v).toBe(
          false,
        );
      });
      const r2 = f.recipients[1]!;
      const token2 = await campaignDb.transaction(async (tx) => {
        await session(tx, f, r2.id);
        return mint(tx, r2.id);
      });
      await h.admin.execute(
        sql`UPDATE automation_controls SET revoked_before = clock_timestamp() WHERE org_id = ${A.orgId}`,
      );
      expect(await sendRefusal(f, 1, { token: token2 })).not.toBeNull();
    });
  });

  // ===============================================================================================
  describe('owner condition 2: after a pause or revocation commits, no subsequent send is authorised', () => {
    const control = (action: 'pause' | 'resume' | 'revoke', token = tokens.get('org')!) =>
      http()
        .post(url(`/automation-controls/${action}`))
        .set('authorization', `Bearer ${token}`)
        .set('X-Acc-Organization', A.orgId)
        .send({ reason: 'test' });

    it('organisation pause waits for an in-flight send, then every later send is refused', async () => {
      const f = await runningCampaign(A, 3);
      let pauseStatus: number | undefined;
      let pause: Promise<unknown> = Promise.resolve();
      await send(f, 0, {
        hold: async () => {
          pause = control('pause').then((res) => {
            pauseStatus = res.status;
          });
          await new Promise((res) => setTimeout(res, 800));
          // The pause waits on the organisation's control row, which this send holds FOR SHARE.
          expect(pauseStatus).toBeUndefined();
        },
      });
      await pause;
      expect(pauseStatus).toBe(200);
      const before = await orgMessages(A.orgId);
      expect(await sendRefusal(f, 1)).toMatchObject({ code: '42501', detail: 'AUTOMATION_PAUSED' });
      expect(await orgMessages(A.orgId)).toBe(before);
      expect((await control('resume')).status).toBe(200);
      await send(f, 1);
    });

    it('a capability minted before the pause committed is void after it', async () => {
      const f = await runningCampaign(A, 1);
      const r = f.recipients[0]!;
      const token = await campaignDb.transaction(async (tx) => {
        await session(tx, f, r.id);
        return mint(tx, r.id);
      });
      expect((await control('pause')).status).toBe(200);
      const before = await orgMessages(A.orgId);
      expect(await sendRefusal(f, 0, { token })).not.toBeNull();
      expect(await orgMessages(A.orgId)).toBe(before);
    });

    it('organisation revoke waits for an in-flight send; outstanding capabilities are void afterwards; new mints work', async () => {
      const f = await runningCampaign(A, 3);
      const r = f.recipients[1]!;
      const outstanding = await campaignDb.transaction(async (tx) => {
        await session(tx, f, r.id);
        return mint(tx, r.id);
      });
      let revokeDone = false;
      let revoke: Promise<unknown> = Promise.resolve();
      await send(f, 0, {
        hold: async () => {
          revoke = control('revoke').then((res) => {
            revokeDone = true;
            expect([res.status, res.body?.data?.revokedBefore ? 'set' : res.body]).toEqual([
              200,
              'set',
            ]);
          });
          await new Promise((res) => setTimeout(res, 800));
          expect(revokeDone).toBe(false);
        },
      });
      await revoke;
      expect(await sendRefusal(f, 1, { token: outstanding })).not.toBeNull();
      await send(f, 2); // a capability minted after the revocation is valid
    });

    it('campaign pause (workspace route) waits for an in-flight send; later sends of that campaign are refused', async () => {
      const f = await runningCampaign(A, 2);
      let paused: number | undefined;
      let pause: Promise<unknown> = Promise.resolve();
      await send(f, 0, {
        hold: async () => {
          pause = http()
            .post(url(`/workspaces/${A.workspaceId}/campaigns/${f.campaignId}/pause`))
            .set('authorization', `Bearer ${tokens.get('org')}`)
            .then((res) => {
              paused = res.status;
            });
          await new Promise((res) => setTimeout(res, 800));
          expect(paused).toBeUndefined();
        },
      });
      await pause;
      expect(paused).toBe(200);
      expect(await sendRefusal(f, 1)).toMatchObject({
        code: '42501',
        detail: 'CAMPAIGN_NOT_RUNNING',
      });
    });
  });

  // ===============================================================================================
  describe('C-1: organisation-wide authority', () => {
    const status = (token: string) =>
      http()
        .get(url('/automation-controls'))
        .set('authorization', `Bearer ${token}`)
        .set('X-Acc-Organization', A.orgId);

    it('campaigns.manage at ORGANIZATION scope: allowed; at a workspace: 403, nothing changed, denial audited; without the permission: 403', async () => {
      expect((await status(tokens.get('org')!)).status).toBe(200);
      const ws = await http()
        .post(url('/automation-controls/pause'))
        .set('authorization', `Bearer ${tokens.get('ws')}`)
        .set('X-Acc-Organization', A.orgId)
        .send({});
      expect(ws.status).toBe(403);
      // The grant carries the permission, but its workspace scope does not cover the organization.
      expect(ws.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
      const ctl = await h.admin.execute(
        sql`SELECT sending_paused FROM automation_controls WHERE org_id = ${A.orgId}`,
      );
      expect(ctl.rows.every((x) => x.sending_paused === false)).toBe(true);
      const denied = await h.admin.execute(
        sql`SELECT 1 FROM audit_logs WHERE actor_user_id = ${tokens.get('wsUserId')} AND action = 'authorization.denied'`,
      );
      expect(denied.rows.length).toBeGreaterThan(0);
      expect((await status(tokens.get('orgAdminNoCampaigns')!)).status).toBe(403);
      // The organisation pause path records its actor and is audited (one row per call).
      const pausedAudits = async () =>
        (
          await h.admin.execute(
            sql`SELECT scope_type, metadata->>'reason' AS reason FROM audit_logs WHERE actor_user_id = ${tokens.get('orgUserId')} AND action = 'automation.paused' ORDER BY created_at`,
          )
        ).rows;
      const auditsBefore = (await pausedAudits()).length;
      const ok = await http()
        .post(url('/automation-controls/pause'))
        .set('authorization', `Bearer ${tokens.get('org')}`)
        .set('X-Acc-Organization', A.orgId)
        .send({ reason: 'incident' });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({
        orgId: A.orgId,
        sendingPaused: true,
        pauseReason: 'incident',
      });
      const audits = await pausedAudits();
      expect(audits.length).toBe(auditsBefore + 1);
      expect(audits.at(-1)).toEqual({ scope_type: 'organization', reason: 'incident' });
    });

    it('API keys are refused, even one carrying campaigns.manage', async () => {
      const prefix = `ak_test_${hex(8)}`;
      const secret = `s${hex(16)}`;
      const [key] = await h.admin
        .insert(schema.apiKeys)
        .values({
          orgId: A.orgId,
          name: `p8b3-${hex(3)}`,
          keyPrefix: prefix,
          keyHash: await credentials.hash(secret),
          scopes: [PERMISSIONS.CAMPAIGNS_MANAGE, PERMISSIONS.CAMPAIGNS_READ],
          createdBy: A.userId,
        })
        .returning({ id: schema.apiKeys.id });
      apiKeys.push(key!.id);
      const res = await http()
        .post(url('/automation-controls/pause'))
        .set('authorization', `Bearer ${prefix}.${secret}`)
        .send({});
      expect(res.status).toBe(403);
    });

    it('the database rule matches the application decision for every principal (parity)', async () => {
      const cases: [string, string, boolean][] = [
        ['org', tokens.get('orgUserId')!, true],
        ['ws', tokens.get('wsUserId')!, false],
        ['orgAdminNoCampaigns', A.userId, false],
      ];
      for (const [label, userId, expected] of cases) {
        const api = (await status(tokens.get(label)!)).status === 200;
        const db = await rolledBack(async (c) => {
          await c.query('SET LOCAL ROLE acc_app');
          await c.query(
            `SELECT set_config('app.current_org_id', $1, true), set_config('app.current_user_id', $2, true), set_config('app.current_api_key_id', '', true)`,
            [A.orgId, userId],
          );
          return (await c.query('SELECT app_automation_org_authority() AS ok')).rows[0]
            .ok as boolean;
        });
        expect([label, api, db]).toEqual([label, expected, expected]);
      }
      // An API-key session is never organisation authority in the database either.
      const withKey = await rolledBack(async (c) => {
        await c.query('SET LOCAL ROLE acc_app');
        await c.query(
          `SELECT set_config('app.current_org_id', $1, true), set_config('app.current_user_id', $2, true), set_config('app.current_api_key_id', $3, true)`,
          [A.orgId, tokens.get('orgUserId'), uuidv7()],
        );
        return (await c.query('SELECT app_automation_org_authority() AS ok')).rows[0].ok as boolean;
      });
      expect(withKey).toBe(false);
      // And acc_app cannot apply a control for a workspace-only holder by calling the definer itself.
      expect(
        await rolledBack(async (c) => {
          await c.query('SET LOCAL ROLE acc_app');
          await c.query(
            `SELECT set_config('app.current_org_id', $1, true), set_config('app.current_user_id', $2, true)`,
            [A.orgId, tokens.get('wsUserId')],
          );
          return outcome(c.query(`SELECT * FROM app_automation_control('pause', NULL)`));
        }),
      ).toMatchObject({ code: '42501' });
    });
  });

  // ===============================================================================================
  describe('C-5: journey sending stays unavailable until 8C-6', () => {
    it('acc_journey cannot execute the identity functions; the journey subject is refused; acc_journey gains nothing', async () => {
      const { rows } = await h.admin.execute<{ fn: string; journey: boolean; app: boolean }>(sql`
        SELECT p.proname AS fn, has_function_privilege('acc_journey', p.oid, 'EXECUTE') AS journey, has_function_privilege('acc_app', p.oid, 'EXECUTE') AS app
          FROM pg_proc p WHERE p.proname IN ('app_automation_capability_mint', 'app_automation_capability_valid', 'app_campaign_claim', 'app_automation_purge_capabilities') ORDER BY 1`);
      expect(rows).toEqual([
        { fn: 'app_automation_capability_mint', journey: false, app: false },
        { fn: 'app_automation_capability_valid', journey: false, app: false },
        { fn: 'app_automation_purge_capabilities', journey: false, app: false },
        { fn: 'app_campaign_claim', journey: false, app: false },
      ]);
      const grants = await h.admin.execute(
        sql`SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'acc_journey' AND table_name IN ('automation_capabilities', 'automation_controls', 'campaign_dispatch', 'campaigns', 'campaign_recipients')`,
      );
      expect(grants.rows).toEqual([]);
    });
  });

  // ===============================================================================================
  describe('the owner-run automation:control CLI', () => {
    let operator: { email: string; id: string };
    beforeAll(async () => {
      const email = `p8b3-op-${hex(5)}@example.test`;
      const [u] = await h.admin
        .insert(schema.users)
        .values({
          email,
          status: 'active',
          passwordHash: await credentials.hash(PASSWORD),
          passwordUpdatedAt: new Date(),
        })
        .returning({ id: schema.users.id });
      users.push(u!.id);
      const [role] = await h.admin
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(
          and(
            eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
            isNull(schema.roles.orgId),
          ),
        );
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.is_platform_admin','on',true)`);
        await tx
          .insert(schema.userRoles)
          .values({ userId: u!.id, roleId: role!.id, scopeType: 'platform', scopeId: null });
      });
      operator = { email, id: u!.id };
    });

    it('a super administrator pauses, revokes and resumes an organization; each is audited', async () => {
      const deps = { credentials, audit: ownerAuditWriter() };
      const p = await applyAutomationControl(h.admin, deps, {
        command: 'pause',
        orgId: B.orgId,
        operatorEmail: operator.email,
        operatorPassword: PASSWORD,
        reason: 'cli',
      });
      expect(p).toMatchObject({ orgId: B.orgId, sendingPaused: true });
      const r = await applyAutomationControl(h.admin, deps, {
        command: 'revoke',
        orgId: B.orgId,
        operatorEmail: operator.email,
        operatorPassword: PASSWORD,
        reason: null,
      });
      expect(r.revokedBefore).not.toBeNull();
      const s = await applyAutomationControl(h.admin, deps, {
        command: 'resume',
        orgId: B.orgId,
        operatorEmail: operator.email,
        operatorPassword: PASSWORD,
        reason: null,
      });
      expect(s.sendingPaused).toBe(false);
      const audit = await h.admin.execute(
        sql`SELECT action FROM audit_logs WHERE actor_user_id = ${operator.id} AND actor_label = 'automation_control_cli' ORDER BY created_at`,
      );
      expect(audit.rows.map((x) => x.action)).toEqual([
        'automation.paused',
        'automation.revoked',
        'automation.resumed',
      ]);
      await purgeAudit(h.admin, sql`actor_user_id = ${operator.id}`);
    });

    it('a wrong password, or an operator who is not a super administrator, is refused and changes nothing', async () => {
      const deps = { credentials, audit: ownerAuditWriter() };
      await expect(
        applyAutomationControl(h.admin, deps, {
          command: 'pause',
          orgId: B.orgId,
          operatorEmail: operator.email,
          operatorPassword: 'wrong-password-value',
          reason: null,
        }),
      ).rejects.toBeInstanceOf(AutomationControlRefusal);
      await expect(
        applyAutomationControl(h.admin, deps, {
          command: 'pause',
          orgId: B.orgId,
          operatorEmail: B.email,
          operatorPassword: PASSWORD,
          reason: null,
        }),
      ).rejects.toBeInstanceOf(AutomationControlRefusal);
      const ctl = await h.admin.execute(
        sql`SELECT sending_paused FROM automation_controls WHERE org_id = ${B.orgId}`,
      );
      expect(ctl.rows.every((x) => x.sending_paused === false)).toBe(true);
    });
  });
});
