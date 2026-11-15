// Must stay the first import: it enables campaign dispatch (tests only) and billing enforcement
// before the application module (and its validated configuration) is loaded.
import './campaign-dispatch.env';

/**
 * Phase 8B PR 8B-3b — the campaign executor, scheduler and API integration
 * (PHASE-8B-3-HANDOVER-Rev2 §6; owner decisions OD-8B3-1..6). Disposable clones only
 * (`scripts/with-db-clone.mjs`).
 *
 * The application boots with `CAMPAIGN_DISPATCH_ENABLED` (admitted in tests only, with billing
 * enforcement): its `acc_campaign` pool is verified RLS-bound at start-up, the worker starts and
 * is stopped here before its first cycle, and the suite drives the executor explicitly — the
 * application's own `CampaignDispatchService`, and directly constructed instances on an
 * `acc_campaign` pool where a test needs a second worker or a stub core.
 *
 * **Nothing is sent to a provider.** Messages are queued by the shared core; the dispatch worker
 * is off (`DISPATCH_WORKER_ENABLED` unset), and providers are the simulator.
 */
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { createDatabase, createPool, schema, type Database, type Transaction } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { randomBytes } from 'node:crypto';

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
import { AuditWriter } from '../src/audit/audit-writer.service';
import { AppConfigService } from '../src/config/app-config.service';
import {
  CampaignDispatchService,
  type CampaignSubmissionCore,
} from '../src/campaigns/dispatch/campaign-dispatch.service';
import { CampaignDispatchWorker } from '../src/campaigns/dispatch/campaign-dispatch.worker';
import { PrincipalRevalidator } from '../src/auth/principal-revalidation.service';
import { CAMPAIGN_POOL } from '../src/database/database.tokens';
import { CredentialService } from '../src/iam/credential.service';
import { MessageSubmissionCore } from '../src/messages/submission/message-submission.core';

jest.setTimeout(90_000);

const url = (p: string) => `/${PREFIX}${p}`;
const hex = (n: number) => randomBytes(n).toString('hex');
const WA_PRICE = 500_000; // 50 paise per message (1/10,000 paisa, migration 0051)
const WA_PAISE = 50;

/** TEST ONLY: a core that refuses every submission with `code` (or a plain error) and writes nothing. */
class RefusingCore implements CampaignSubmissionCore {
  calls = 0;
  constructor(private readonly code: string | null) {}
  async submit(): Promise<never> {
    this.calls++;
    const error = new Error(`refused (${this.code ?? 'no code'})`);
    if (this.code !== null) (error as Error & { code: string }).code = this.code;
    throw error;
  }
}

interface Planted {
  readonly tenant: TenantFixture;
  readonly campaignId: string;
  readonly templateId: string;
  readonly recipients: { id: string; contactId: string; identityId: string; address: string }[];
}

describe('Phase 8B PR 8B-3b: campaign executor, scheduler and API integration', () => {
  let h: Harness;
  let credentials: CredentialService;
  let A: TenantFixture; // funded, priced, provider assigned
  let C: TenantFixture; // provider assigned, NO billing account and no rate card
  let L: TenantFixture; // funded for exactly two WhatsApp messages
  let waChannel: string;
  let executorPool: Pool;
  let executorDb: Database;
  let app: CampaignDispatchService;
  const tenants: TenantFixture[] = [];
  const providers: string[] = [];
  const roles: string[] = [];
  const plans: string[] = [];
  const users: string[] = [];
  const tokens = new Map<string, string>();
  let seq = 0;
  let workerWasRunning = false;
  let senderRole: string;
  const apiKeys: string[] = [];

  const http = () => request(h.app.getHttpServer());
  const login = async (email: string) =>
    (await http().post(url('/auth/login')).send({ email, password: PASSWORD })).body.data
      .accessToken as string;
  const as = <T extends request.Test>(r: T, who: string) =>
    r.set('authorization', `Bearer ${tokens.get(who)!}`);
  const base = (t: TenantFixture, id: string) => `/workspaces/${t.workspaceId}/campaigns/${id}`;

  // --- fixtures ---------------------------------------------------------------------------------

  async function roleWith(t: TenantFixture, label: string, perms: string[]): Promise<string> {
    const roleId = uuidv7();
    roles.push(roleId);
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: t.orgId,
      key: `p8b3b_${label}_${hex(3)}`,
      name: `8B-3b ${label}`,
      description: perms.join(', '),
      isSystemRole: false,
      allowedScopeTypes: ['organization', 'workspace'],
    });
    const rows = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(inArray(schema.permissions.key, perms));
    for (const p of rows)
      await h.admin
        .insert(schema.rolePermissions)
        .values({ roleId, permissionId: p.id, orgId: t.orgId });
    return roleId;
  }

  async function userWith(
    t: TenantFixture,
    label: string,
    roleId: string,
    scopeType: 'organization' | 'workspace',
  ) {
    const email = `p8b3b-${label}-${hex(5)}@example.test`;
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
    await h.admin.insert(schema.userRoles).values({
      userId: u!.id,
      roleId,
      scopeType,
      scopeId: scopeType === 'organization' ? t.orgId : t.workspaceId,
    });
    await h.clearRateLimits();
    tokens.set(label, await login(email));
    tokens.set(`${label}:id`, u!.id);
    return u!.id;
  }

  async function provider(t: TenantFixture) {
    const slug = `p8b3b-${hex(4)}`;
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

  async function price(orgId: string) {
    await h.admin.transaction(async (tx) => {
      const plan = await tx.execute<{ id: string }>(
        sql`INSERT INTO pricing_plans (name) VALUES (${`p8b3b-${uuidv7()}`}) RETURNING id`,
      );
      plans.push(plan.rows[0]!.id);
      const version = await tx.execute<{ id: string }>(
        sql`INSERT INTO pricing_plan_versions (plan_id, version_number) VALUES (${plan.rows[0]!.id}, 1) RETURNING id`,
      );
      await tx.execute(
        sql`INSERT INTO pricing_rules (plan_version_id, channel_id, unit_price_e4)
            VALUES (${version.rows[0]!.id}, ${waChannel}, ${WA_PRICE})`,
      );
      await tx.execute(
        sql`UPDATE pricing_plan_versions SET status = 'active', effective_from = now() WHERE id = ${version.rows[0]!.id}`,
      );
      await tx.execute(
        sql`INSERT INTO customer_pricing_assignments (org_id, plan_id, effective_from) VALUES (${orgId}, ${plan.rows[0]!.id}, now())`,
      );
    });
  }

  /**
   * A campaign with `n` materialised pending recipients. `running` also creates the claim row, as
   * `POST …/dispatch` does (no claim token: the executor claims it).
   */
  async function plant(
    t: TenantFixture,
    n: number,
    opts: {
      status?: 'draft' | 'running';
      rate?: number;
      approved?: boolean;
      startedBy?: string | null;
    } = {},
  ): Promise<Planted> {
    const [tpl] = await h.admin
      .insert(schema.templates)
      .values({
        orgId: t.orgId,
        channelId: waChannel,
        name: `t-${uuidv7()}`,
        body: 'Hello',
        variables: [],
        approvalStatus: opts.approved === false ? 'pending' : 'approved',
      })
      .returning({ id: schema.templates.id });
    const status = opts.status ?? 'running';
    const [c] = await h.admin
      .insert(schema.campaigns)
      .values({
        orgId: t.orgId,
        workspaceId: t.workspaceId,
        name: `c-${uuidv7()}`,
        channelId: waChannel,
        templateId: tpl!.id,
        recipientSource: { type: 'all_contacts' },
        status,
        throttling: { rateLimitPerSecond: opts.rate ?? 25, maxAttemptsPerRecipient: 1 },
        ...(status === 'running'
          ? {
              startedBy: opts.startedBy === undefined ? t.userId : opts.startedBy,
              startedAt: new Date(),
            }
          : {}),
      })
      .returning({ id: schema.campaigns.id });
    const recipients: Planted['recipients'] = [];
    for (let i = 0; i < n; i++) {
      const address = `+1202557${String(1000 + ++seq).padStart(4, '0')}`;
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
      // uuidv7 ids sort in insertion order: the executor sends recipients in this order.
      const [r] = await h.admin
        .insert(schema.campaignRecipients)
        .values({
          id: uuidv7(),
          campaignId: c!.id,
          orgId: t.orgId,
          workspaceId: t.workspaceId,
          contactId: contact!.id,
          identityId: identity!.id,
          status: 'pending',
        })
        .returning({ id: schema.campaignRecipients.id });
      recipients.push({ id: r!.id, contactId: contact!.id, identityId: identity!.id, address });
    }
    if (status === 'running')
      await h.admin.execute(
        sql`INSERT INTO campaign_dispatch (campaign_id, org_id) VALUES (${c!.id}, ${t.orgId})`,
      );
    return { tenant: t, campaignId: c!.id, templateId: tpl!.id, recipients };
  }

  /** An executor on the acc_campaign test pool, with its own worker id and options. */
  const executor = (
    core: CampaignSubmissionCore = h.app.get(MessageSubmissionCore, { strict: false }),
    options: Partial<CampaignDispatchService['options']> = {},
  ) =>
    new CampaignDispatchService(executorDb, core, h.app.get(AuditWriter), undefined, {
      workerId: `test-${hex(3)}`,
      batchSize: 10,
      perOrgLimit: 10,
      leaseSeconds: 30,
      lockTimeoutMs: 2_000,
      ...options,
    });

  /** Claims exactly this campaign (others of the organisation are made unavailable meanwhile). */
  async function claimOne(x: CampaignDispatchService, campaignId: string) {
    const claims = await x.claim();
    const mine = claims.find((c) => c.campaignId === campaignId);
    // Release any other claim this call took, untouched.
    for (const other of claims.filter((c) => c.campaignId !== campaignId))
      await h.admin.execute(
        sql`UPDATE campaign_dispatch SET claim_token = NULL, claimed_until = NULL, claimed_by = NULL WHERE campaign_id = ${other.campaignId}`,
      );
    return mine;
  }
  /** Processes this campaign until it stops being claimable now (or `max` claims). */
  async function drive(x: CampaignDispatchService, campaignId: string, max = 10) {
    const outcomes: string[] = [];
    for (let i = 0; i < max; i++) {
      await h.admin.execute(
        sql`UPDATE campaign_dispatch SET next_slot_at = now(), available_at = now() WHERE campaign_id = ${campaignId}`,
      );
      const claim = await claimOne(x, campaignId);
      if (!claim) break;
      const result = await x.processClaim(claim);
      outcomes.push(result.outcome);
      if (result.outcome !== 'released') break;
    }
    return outcomes;
  }

  const campaign = async (id: string) =>
    (await h.admin.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)))[0]!;
  const recipientRows = async (campaignId: string) =>
    h.admin
      .select()
      .from(schema.campaignRecipients)
      .where(eq(schema.campaignRecipients.campaignId, campaignId))
      .orderBy(schema.campaignRecipients.id);
  const claimRow = async (campaignId: string) =>
    (
      await h.admin.execute<{
        epoch: number;
        claim_token: string | null;
        attempts: number;
        last_error_code: string | null;
        available_in: number;
        next_slot_in: number;
      }>(
        sql`SELECT epoch, claim_token, attempts, last_error_code,
                   extract(epoch FROM available_at - now())::float AS available_in,
                   extract(epoch FROM next_slot_at - now())::float AS next_slot_in
              FROM campaign_dispatch WHERE campaign_id = ${campaignId}`,
      )
    ).rows[0];
  const count = async (table: string, where: ReturnType<typeof sql>) =>
    Number(
      (
        await h.admin.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)} WHERE ${where}`,
        )
      ).rows[0]!.n,
    );
  const campaignMessages = (campaignId: string) =>
    h.admin.execute<{
      id: string;
      campaign_recipient_id: string;
      status: string;
      journey_execution_id: string | null;
    }>(
      sql`SELECT id, campaign_recipient_id, status::text AS status, journey_execution_id
            FROM messages WHERE campaign_id = ${campaignId} ORDER BY created_at`,
    );
  const audits = async (campaignId: string, action: string) =>
    (
      await h.admin.execute<{
        actor_type: string;
        actor_label: string | null;
        actor_user_id: string | null;
        outcome: string;
        metadata: Record<string, unknown>;
      }>(
        sql`SELECT actor_type::text, actor_label, actor_user_id, outcome::text, metadata
              FROM audit_logs WHERE resource_id = ${campaignId} AND action = ${action}`,
      )
    ).rows;
  const reserved = async (orgId: string) =>
    Number(
      (
        await h.admin.execute<{ r: string }>(
          sql`SELECT reserved_paise::text AS r FROM wallets WHERE org_id = ${orgId}`,
        )
      ).rows[0]?.r ?? 0,
    );
  const setAutomationPaused = (orgId: string, paused: boolean) =>
    h.admin.execute(
      paused
        ? sql`INSERT INTO automation_controls (org_id, sending_paused, paused_at) VALUES (${orgId}, true, now())
              ON CONFLICT (org_id) DO UPDATE SET sending_paused = true, paused_at = now()`
        : sql`UPDATE automation_controls SET sending_paused = false, paused_at = NULL, paused_by_user_id = NULL,
                     paused_by_label = NULL, pause_reason = NULL WHERE org_id = ${orgId}`,
    );

  // --- lifecycle --------------------------------------------------------------------------------

  beforeAll(async () => {
    h = await startHarness();
    // Stop the application's worker before its first cycle (poll interval 60 s); the suite drives
    // the executor itself.
    const worker = h.app.get(CampaignDispatchWorker);
    workerWasRunning = worker.isRunning();
    await worker.onModuleDestroy();
    await h.clearRateLimits();
    credentials = h.app.get(CredentialService);
    app = h.app.get(CampaignDispatchService);
    waChannel = (
      await h.admin
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(eq(schema.channels.code, 'whatsapp'))
    )[0]!.id;
    A = await createTenant(h.admin, 'p8b3b-a', credentials);
    C = await createTenant(h.admin, 'p8b3b-c', credentials);
    L = await createTenant(h.admin, 'p8b3b-l', credentials);
    tenants.push(A, C, L);
    for (const t of tenants) await provider(t);
    for (const t of [A, L]) await price(t.orgId);
    await h.admin.execute(
      sql`INSERT INTO wallets (org_id, balance_paise) VALUES (${A.orgId}, 1000000), (${L.orgId}, ${2 * WA_PAISE})`,
    );

    const sender = (senderRole = await roleWith(A, 'sender', [
      PERMISSIONS.CAMPAIGNS_READ,
      PERMISSIONS.CAMPAIGNS_MANAGE,
      PERMISSIONS.MESSAGES_SEND,
    ]));
    const manager = await roleWith(A, 'manager', [
      PERMISSIONS.CAMPAIGNS_READ,
      PERMISSIONS.CAMPAIGNS_MANAGE,
    ]);
    const senderC = await roleWith(C, 'sender', [
      PERMISSIONS.CAMPAIGNS_READ,
      PERMISSIONS.CAMPAIGNS_MANAGE,
      PERMISSIONS.MESSAGES_SEND,
    ]);
    const senderL = await roleWith(L, 'sender', [
      PERMISSIONS.CAMPAIGNS_READ,
      PERMISSIONS.CAMPAIGNS_MANAGE,
      PERMISSIONS.MESSAGES_SEND,
    ]);
    await userWith(A, 'sender', sender, 'workspace');
    await userWith(A, 'manager', manager, 'workspace');
    await userWith(C, 'senderC', senderC, 'workspace');
    await userWith(L, 'senderL', senderL, 'workspace');

    executorPool = createPool({
      connectionString: process.env.DATABASE_ADMIN_URL!,
      max: 6,
      applicationName: 'acc-test-8b3b-executor',
    });
    executorPool.on('connect', (client) => {
      void client.query('SET ROLE acc_campaign');
    });
    executorDb = createDatabase(executorPool);
  }, 180_000);

  beforeEach(async () => {
    await h.clearRateLimits();
  });

  afterEach(async () => {
    for (const t of tenants) await setAutomationPaused(t.orgId, false);
  });

  afterAll(async () => {
    if (!h) return;
    try {
      await executorPool?.end();
      const orgIds = tenants.map((t) => t.orgId);
      if (orgIds.length > 0) {
        const orgs = sql`ANY(${`{${orgIds.join(',')}}`}::uuid[])`;
        await purgeMessageEvents(h.admin, sql`org_id = ${orgs}`);
        for (const id of apiKeys) await purgeAudit(h.admin, sql`actor_api_key_id = ${id}`);
        await purgeAudit(
          h.admin,
          sql`resource_type = 'Campaign' AND scope_id IN (SELECT id FROM workspaces WHERE org_id = ${orgs})`,
        );
        await h.admin.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL session_replication_role = replica`);
          await tx.execute(
            sql`DELETE FROM pricing_evaluation_components WHERE evaluation_id IN (SELECT id FROM pricing_evaluations WHERE org_id = ${orgs})`,
          );
          for (const table of [
            'usage_ledger',
            'pricing_evaluations',
            'automation_capabilities',
            'automation_controls',
            'message_dispatch_queue',
            'campaign_dispatch',
            'messages',
            'campaign_recipients',
            'campaigns',
            'api_keys',
            'templates',
            'suppressions',
            'contact_identities',
            'contacts',
            'customer_pricing_assignments',
            'wallets',
            'organization_provider_assignments',
          ])
            await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${orgs}`);
          if (plans.length > 0) {
            const planIds = sql`ANY(${`{${plans.join(',')}}`}::uuid[])`;
            await tx.execute(
              sql`DELETE FROM pricing_rules WHERE plan_version_id IN (SELECT id FROM pricing_plan_versions WHERE plan_id = ${planIds})`,
            );
            await tx.execute(sql`DELETE FROM pricing_plan_versions WHERE plan_id = ${planIds}`);
            await tx.execute(sql`DELETE FROM pricing_plans WHERE id = ${planIds}`);
          }
          if (roles.length > 0) {
            const roleIds = sql`ANY(${`{${roles.join(',')}}`}::uuid[])`;
            await tx.execute(sql`DELETE FROM role_permissions WHERE role_id = ${roleIds}`);
          }
        });
      }
      await removeIdentities(h.admin, users);
      if (roles.length > 0)
        await h.admin.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL session_replication_role = replica`);
          await tx.execute(
            sql`DELETE FROM roles WHERE id = ANY(${`{${roles.join(',')}}`}::uuid[])`,
          );
        });
      for (const t of tenants) await destroyTenant(h.admin, t);
      if (providers.length > 0)
        await h.admin.delete(schema.providers).where(inArray(schema.providers.id, providers));
    } finally {
      await h.close();
    }
  }, 120_000);

  // ===============================================================================================

  describe('enablement (tests only) and the executor principal', () => {
    it('boots with dispatch enabled only alongside billing enforcement; the worker started and was stopped', () => {
      const config = h.app.get(AppConfigService);
      expect(config.campaigns.dispatchEnabled).toBe(true);
      expect(config.billing.enforcementEnabled).toBe(true);
      expect(workerWasRunning).toBe(true);
      expect(h.app.get(CampaignDispatchWorker).isRunning()).toBe(false);
      expect(app.available).toBe(true);
    });

    it('the application executor pool is acc_campaign, RLS-bound', async () => {
      const pool = h.app.get<Pool>(CAMPAIGN_POOL);
      const { rows } = await pool.query(
        `SELECT current_user AS role, r.rolsuper, r.rolbypassrls, r.rolcanlogin
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      expect(rows[0]).toEqual({
        role: 'acc_campaign',
        rolsuper: false,
        rolbypassrls: false,
        rolcanlogin: false,
      });
    });

    it('acc_campaign reaches only its claimed campaign: nothing at all without a claim', async () => {
      const f = await plant(A, 1);
      const seen = await executorDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_org_id', ${A.orgId}, true)`);
        const n = async (table: string) =>
          Number(
            (
              await tx.execute<{ n: string }>(
                sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)}`,
              )
            ).rows[0]!.n,
          );
        return {
          campaigns: await n('campaigns'),
          recipients: await n('campaign_recipients'),
          dispatch: await n('campaign_dispatch'),
          contacts: await n('contacts'),
          messages: await n('messages'),
        };
      });
      expect(seen).toEqual({ campaigns: 0, recipients: 0, dispatch: 0, contacts: 0, messages: 0 });
      // and the planted campaign is still untouched
      expect((await campaign(f.campaignId)).status).toBe('running');
      await h.admin.execute(
        sql`UPDATE campaign_dispatch SET available_at = now() + interval '1 day' WHERE campaign_id = ${f.campaignId}`,
      );
    });

    it('acc_app cannot run the scheduler definer; acc_campaign can read a channel code (0070 grants)', async () => {
      const c = await executorPool.connect();
      try {
        await c.query('BEGIN');
        const code = await c.query(`SELECT app_channel_code($1::uuid) AS code`, [waChannel]);
        expect(code.rows[0].code).toBe('whatsapp');
        await c.query('SET LOCAL ROLE acc_app');
        await expect(c.query(`SELECT * FROM app_campaign_start_due(1)`)).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    });
  });

  // ===============================================================================================

  describe('POST …/dispatch (enabled path)', () => {
    it('needs messages.send in addition to campaigns.manage', async () => {
      const f = await plant(A, 2, { status: 'draft' });
      const res = await as(http().post(url(`${base(A, f.campaignId)}/dispatch`)), 'manager');
      expect(res.status).toBe(403);
      expect((await campaign(f.campaignId)).status).toBe('draft');
      expect(await claimRow(f.campaignId)).toBeUndefined();
    });

    it('refuses an unapproved template (422) and an empty audience (422); nothing starts', async () => {
      const unapproved = await plant(A, 1, { status: 'draft', approved: false });
      const r1 = await as(http().post(url(`${base(A, unapproved.campaignId)}/dispatch`)), 'sender');
      expect(r1.status).toBe(422);
      expect(r1.body.error.code).toBe(ERROR_CODES.TEMPLATE_NOT_APPROVED);
      const empty = await plant(A, 0, { status: 'draft' });
      const r2 = await as(http().post(url(`${base(A, empty.campaignId)}/dispatch`)), 'sender');
      expect(r2.status).toBe(422);
      expect(r2.body.error.code).toBe(ERROR_CODES.CAMPAIGN_AUDIENCE_EMPTY);
      for (const f of [unapproved, empty]) {
        expect((await campaign(f.campaignId)).status).toBe('draft');
        expect(await claimRow(f.campaignId)).toBeUndefined();
      }
    });

    it('starts a draft campaign under the caller, creates its claim row and audits; a second dispatch conflicts', async () => {
      const f = await plant(A, 2, { status: 'draft' });
      const res = await as(http().post(url(`${base(A, f.campaignId)}/dispatch`)), 'sender');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: f.campaignId,
        status: 'running',
        pauseReason: null,
      });
      const row = await campaign(f.campaignId);
      expect(row.startedBy).toBe(tokens.get('sender:id'));
      expect(row.startedAt).not.toBeNull();
      expect(await claimRow(f.campaignId)).toMatchObject({ epoch: 0, claim_token: null });
      const [audit] = await audits(f.campaignId, 'campaign.dispatched');
      expect(audit).toMatchObject({ actor_user_id: tokens.get('sender:id'), outcome: 'success' });
      expect(audit!.metadata).toMatchObject({ previousStatus: 'draft', pendingRecipients: 2 });
      // Nothing was sent by the API itself.
      expect(await count('messages', sql`campaign_id = ${f.campaignId}`)).toBe(0);

      const again = await as(http().post(url(`${base(A, f.campaignId)}/dispatch`)), 'sender');
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe(ERROR_CODES.CAMPAIGN_LIFECYCLE_CONFLICT);

      // Run it to completion through the application's executor.
      expect(await drive(app as CampaignDispatchService, f.campaignId)).toEqual(['completed']);
      expect((await campaign(f.campaignId)).status).toBe('completed');
    });

    it('an organisation without a billing account: dispatch starts, the executor auto-pauses billing_account', async () => {
      const f = await plant(C, 2, { status: 'draft' });
      const res = await as(http().post(url(`${base(C, f.campaignId)}/dispatch`)), 'senderC');
      expect(res.status).toBe(200);
      const outcomes = await drive(executor(), f.campaignId);
      expect(outcomes).toEqual(['paused']);
      const row = await campaign(f.campaignId);
      expect(row).toMatchObject({ status: 'paused', pauseReason: 'billing_account' });
      expect((await recipientRows(f.campaignId)).map((r) => r.status)).toEqual([
        'pending',
        'pending',
      ]);
      expect(await count('messages', sql`campaign_id = ${f.campaignId}`)).toBe(0);
      expect(await claimRow(f.campaignId)).toBeUndefined();
      const [audit] = await audits(f.campaignId, 'campaign.auto_paused');
      expect(audit).toMatchObject({
        actor_type: 'system',
        actor_label: 'campaign_executor',
        outcome: 'failure',
      });
      expect(audit!.metadata).toMatchObject({ pauseReason: 'billing_account' });
      // The API reports the reason.
      const view = await as(http().get(url(base(C, f.campaignId))), 'senderC');
      expect(view.body.data).toMatchObject({ status: 'paused', pauseReason: 'billing_account' });
    });
  });

  // ===============================================================================================

  describe('the executor: T-send per recipient', () => {
    it('sends every recipient through the shared core with attribution, queue, event and reservation; completes and audits', async () => {
      const f = await plant(A, 3);
      const before = await reserved(A.orgId);
      const outcomes = await drive(executor(), f.campaignId);
      expect(outcomes).toEqual(['completed']);

      const messages = (await campaignMessages(f.campaignId)).rows;
      expect(messages).toHaveLength(3);
      const recipients = await recipientRows(f.campaignId);
      for (const r of recipients) {
        expect(r.status).toBe('sent');
        const m = messages.find((x) => x.id === r.messageId);
        expect(m).toMatchObject({ campaign_recipient_id: r.id, journey_execution_id: null });
      }
      // Exactly what a direct submission writes: one queue entry and one event per message, and
      // the funds reservation (enforcement is on).
      const ids = sql`ANY(${`{${messages.map((m) => m.id).join(',')}}`}::uuid[])`;
      expect(await count('message_dispatch_queue', sql`message_id = ${ids}`)).toBe(3);
      expect(await count('message_events', sql`message_id = ${ids}`)).toBe(3);
      expect(
        await count('usage_ledger', sql`message_id = ${ids} AND entry_type = 'reservation'`),
      ).toBe(3);
      expect((await reserved(A.orgId)) - before).toBe(3 * WA_PAISE);
      // One capability per send, bound to the recipient and the campaign.
      expect(
        await count(
          'automation_capabilities',
          sql`automation_id = ${f.campaignId} AND subject_kind = 'campaign_recipient'`,
        ),
      ).toBe(3);

      const row = await campaign(f.campaignId);
      expect(row.status).toBe('completed');
      expect(row.completedAt).not.toBeNull();
      expect(row.metrics).toMatchObject({ totalRecipients: 3, sent: 3 });
      expect(await claimRow(f.campaignId)).toBeUndefined();
      const [audit] = await audits(f.campaignId, 'campaign.completed');
      expect(audit).toMatchObject({ actor_type: 'system', actor_label: 'campaign_executor' });
      expect(audit!.metadata).toMatchObject({ totalRecipients: 3, sent: 3, skipped: 0, failed: 0 });

      // GET derives live metrics.
      const view = await as(http().get(url(base(A, f.campaignId))), 'sender');
      expect(view.body.data.metrics).toMatchObject({ totalRecipients: 3, sent: 3 });
    });

    it('throttles to ceil(rate × 5 s) per claim and releases to the next slot', async () => {
      const f = await plant(A, 7, { rate: 1 });
      const x = executor();
      const claim = (await claimOne(x, f.campaignId))!;
      const first = await x.processClaim(claim);
      expect(first).toMatchObject({ outcome: 'released', sent: 5 });
      const after = (await claimRow(f.campaignId))!;
      expect(after.claim_token).toBeNull();
      expect(after.next_slot_in).toBeGreaterThan(3);
      expect(after.next_slot_in).toBeLessThanOrEqual(5.5);
      // Not claimable before its slot.
      expect(await claimOne(x, f.campaignId)).toBeUndefined();
      expect(await drive(x, f.campaignId)).toEqual(['completed']);
      expect((await recipientRows(f.campaignId)).every((r) => r.status === 'sent')).toBe(true);
    });

    it('two executors running concurrently send each recipient exactly once', async () => {
      const f = await plant(A, 6, { rate: 1 });
      const x1 = executor();
      const x2 = executor();
      await Promise.all([x1.tick(), x2.tick(), x1.tick(), x2.tick()]);
      await drive(x1, f.campaignId);
      const messages = (await campaignMessages(f.campaignId)).rows;
      expect(messages).toHaveLength(6);
      expect(new Set(messages.map((m) => m.campaign_recipient_id)).size).toBe(6);
      expect((await campaign(f.campaignId)).status).toBe('completed');
    });

    it('a superseded claim is fenced: nothing is written', async () => {
      const f = await plant(A, 2);
      const x = executor();
      const stale = (await claimOne(x, f.campaignId))!;
      // The lease lapses and another worker re-claims (epoch + 1).
      await h.admin.execute(
        sql`UPDATE campaign_dispatch SET claimed_until = now() - interval '1 second' WHERE campaign_id = ${f.campaignId}`,
      );
      const fresh = (await claimOne(executor(), f.campaignId))!;
      expect(fresh.epoch).toBe(stale.epoch + 1);
      expect(await x.processClaim(stale)).toMatchObject({ outcome: 'fenced', sent: 0 });
      expect(await count('messages', sql`campaign_id = ${f.campaignId}`)).toBe(0);
      expect(await count('automation_capabilities', sql`automation_id = ${f.campaignId}`)).toBe(0);
      await x.processClaim(fresh);
      expect(await count('messages', sql`campaign_id = ${f.campaignId}`)).toBe(2);
    });

    it('a recipient whose identity is no longer active is skipped (no_active_identity); the rest are sent', async () => {
      const f = await plant(A, 2);
      await h.admin
        .update(schema.contactIdentities)
        .set({ status: 'inactive' })
        .where(eq(schema.contactIdentities.id, f.recipients[0]!.identityId));
      expect(await drive(executor(), f.campaignId)).toEqual(['completed']);
      const [r0, r1] = await recipientRows(f.campaignId);
      expect(r0).toMatchObject({
        status: 'skipped',
        skipReason: 'no_active_identity',
        messageId: null,
      });
      expect(r1).toMatchObject({ status: 'sent' });
      expect((await campaign(f.campaignId)).metrics).toMatchObject({ sent: 1, skipped: 1 });
    });

    it('a suppressed recipient is skipped by the core refusal; nothing is written for it', async () => {
      const f = await plant(A, 2);
      await h.admin.insert(schema.suppressions).values({
        orgId: A.orgId,
        channelId: waChannel,
        rawAddress: f.recipients[0]!.address,
        normalizedAddress: f.recipients[0]!.address,
        reason: '8B-3b test',
      });
      expect(await drive(executor(), f.campaignId)).toEqual(['completed']);
      const [r0, r1] = await recipientRows(f.campaignId);
      expect(r0).toMatchObject({ status: 'skipped', skipReason: 'recipient_suppressed' });
      expect(r1!.status).toBe('sent');
      expect(await count('messages', sql`campaign_id = ${f.campaignId}`)).toBe(1);
    });

    it('insufficient funds auto-pauses the campaign; resume (messages.send) continues it after funding', async () => {
      const f = await plant(L, 3);
      expect(await drive(executor(), f.campaignId)).toEqual(['paused']);
      expect(await campaign(f.campaignId)).toMatchObject({
        status: 'paused',
        pauseReason: 'insufficient_funds',
      });
      expect((await recipientRows(f.campaignId)).map((r) => r.status)).toEqual([
        'sent',
        'sent',
        'pending',
      ]);
      await h.admin.execute(
        sql`UPDATE wallets SET balance_paise = balance_paise + 1000 WHERE org_id = ${L.orgId}`,
      );
      const res = await as(http().post(url(`${base(L, f.campaignId)}/resume`)), 'senderL');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'running', pauseReason: null });
      const [audit] = await audits(f.campaignId, 'campaign.resumed');
      expect(audit!.metadata).toMatchObject({ previousPauseReason: 'insufficient_funds' });
      expect(await drive(executor(), f.campaignId)).toEqual(['completed']);
      expect((await recipientRows(f.campaignId)).every((r) => r.status === 'sent')).toBe(true);
    });
  });

  // ===============================================================================================

  describe('refusal matrix (OD-8B3-3) with a refusing core', () => {
    const cases: ReadonlyArray<
      [
        string,
        string | null,
        { recipient?: string; campaign?: string; reason?: string; result: string },
      ]
    > = [
      [
        ERROR_CODES.RECIPIENT_SUPPRESSED,
        ERROR_CODES.RECIPIENT_SUPPRESSED,
        { recipient: 'skipped', result: 'completed' },
      ],
      [
        ERROR_CODES.CONSENT_REVOKED,
        ERROR_CODES.CONSENT_REVOKED,
        { recipient: 'skipped', result: 'completed' },
      ],
      [
        ERROR_CODES.VALIDATION_FAILED,
        ERROR_CODES.VALIDATION_FAILED,
        { recipient: 'failed', result: 'completed' },
      ],
      ['23503 (identity mismatch)', '23503', { recipient: 'failed', result: 'completed' }],
      [
        ERROR_CODES.BILLING_INSUFFICIENT_FUNDS,
        ERROR_CODES.BILLING_INSUFFICIENT_FUNDS,
        { campaign: 'paused', reason: 'insufficient_funds', result: 'paused' },
      ],
      [
        ERROR_CODES.BILLING_ACCOUNT_FROZEN,
        ERROR_CODES.BILLING_ACCOUNT_FROZEN,
        { campaign: 'paused', reason: 'billing_account', result: 'paused' },
      ],
      [
        ERROR_CODES.NO_ACTIVE_PROVIDER_ASSIGNMENT,
        ERROR_CODES.NO_ACTIVE_PROVIDER_ASSIGNMENT,
        { campaign: 'paused', reason: 'no_provider_assignment', result: 'paused' },
      ],
      [
        ERROR_CODES.TEMPLATE_NOT_APPROVED,
        ERROR_CODES.TEMPLATE_NOT_APPROVED,
        { campaign: 'paused', reason: 'template_not_approved', result: 'paused' },
      ],
      [
        ERROR_CODES.CHANNEL_NOT_SUPPORTED,
        ERROR_CODES.CHANNEL_NOT_SUPPORTED,
        { campaign: 'paused', reason: 'channel_not_supported', result: 'paused' },
      ],
    ];

    it.each(cases)('%s', async (_label, code, expected) => {
      const f = await plant(A, 1);
      const core = new RefusingCore(code);
      const x = executor(core);
      const claim = (await claimOne(x, f.campaignId))!;
      const result = await x.processClaim(claim);
      expect(result.outcome).toBe(expected.result);
      expect(core.calls).toBe(1);
      const [r] = await recipientRows(f.campaignId);
      const row = await campaign(f.campaignId);
      if (expected.recipient) {
        expect(r!.status).toBe(expected.recipient);
        if (expected.recipient === 'skipped') expect(r!.skipReason).toBe(code!.toLowerCase());
        else expect(r!.errorCode).toBe(code);
        expect(row.status).toBe('completed');
      } else {
        expect(r!.status).toBe('pending');
        expect(row).toMatchObject({ status: expected.campaign, pauseReason: expected.reason });
        expect(await claimRow(f.campaignId)).toBeUndefined();
        expect(await audits(f.campaignId, 'campaign.auto_paused')).toHaveLength(1);
      }
      // A refusal rolls back the core's savepoint: no message exists for the campaign.
      expect(await count('messages', sql`campaign_id = ${f.campaignId}`)).toBe(0);
    });

    it('a transient refusal (BILLING_BUSY) records nothing and releases with backoff', async () => {
      const f = await plant(A, 1);
      const x = executor(new RefusingCore(ERROR_CODES.BILLING_BUSY));
      const result = await x.processClaim((await claimOne(x, f.campaignId))!);
      expect(result).toMatchObject({ outcome: 'retry', errorCode: ERROR_CODES.BILLING_BUSY });
      const [r] = await recipientRows(f.campaignId);
      expect(r).toMatchObject({ status: 'pending', attempts: 0 });
      const claim = (await claimRow(f.campaignId))!;
      expect(claim).toMatchObject({ claim_token: null, last_error_code: ERROR_CODES.BILLING_BUSY });
      expect(claim.available_in).toBeGreaterThan(0);
      // The whole T-send rolled back, including the capability.
      expect(await count('automation_capabilities', sql`automation_id = ${f.campaignId}`)).toBe(0);
      expect((await campaign(f.campaignId)).status).toBe('running');
      await h.admin.execute(
        sql`UPDATE campaign_dispatch SET available_at = now() + interval '1 day' WHERE campaign_id = ${f.campaignId}`,
      );
    });

    it(`an unexpected failure is retried, then the recipient fails after ${3} attempts`, async () => {
      const f = await plant(A, 1);
      const x = executor(new RefusingCore(null));
      const results: string[] = [];
      for (let i = 0; i < 3; i++) {
        await h.admin.execute(
          sql`UPDATE campaign_dispatch SET available_at = now(), next_slot_at = now() WHERE campaign_id = ${f.campaignId}`,
        );
        results.push((await x.processClaim((await claimOne(x, f.campaignId))!)).outcome);
        const [r] = await recipientRows(f.campaignId);
        if (i < 2) expect(r).toMatchObject({ status: 'pending', attempts: i + 1 });
        else
          expect(r).toMatchObject({
            status: 'failed',
            attempts: 3,
            errorCode: 'CAMPAIGN_SEND_UNEXPECTED',
          });
      }
      expect(results).toEqual(['retry', 'retry', 'completed']);
    });
  });

  // ===============================================================================================

  describe('lifecycle: operator pause, resume, cancel, organisation pause', () => {
    it('operator pause removes the claim; a claim in hand is fenced; resume needs messages.send', async () => {
      const f = await plant(A, 7, { rate: 1 }); // quota 5 per claim
      const x = executor();
      expect(await x.processClaim((await claimOne(x, f.campaignId))!)).toMatchObject({
        outcome: 'released',
        sent: 5,
      });
      await h.admin.execute(
        sql`UPDATE campaign_dispatch SET next_slot_at = now() WHERE campaign_id = ${f.campaignId}`,
      );
      const inHand = (await claimOne(x, f.campaignId))!;

      const paused = await as(http().post(url(`${base(A, f.campaignId)}/pause`)), 'sender');
      expect(paused.status).toBe(200);
      expect(paused.body.data).toMatchObject({ status: 'paused', pauseReason: 'operator' });
      expect(await claimRow(f.campaignId)).toBeUndefined();
      expect(await x.processClaim(inHand)).toMatchObject({ outcome: 'fenced', sent: 0 });
      expect(await count('messages', sql`campaign_id = ${f.campaignId}`)).toBe(5);

      const denied = await as(http().post(url(`${base(A, f.campaignId)}/resume`)), 'manager');
      expect(denied.status).toBe(403);
      expect((await campaign(f.campaignId)).status).toBe('paused');

      const resumed = await as(http().post(url(`${base(A, f.campaignId)}/resume`)), 'sender');
      expect(resumed.status).toBe(200);
      expect(resumed.body.data).toMatchObject({ status: 'running', pauseReason: null });
      expect(await claimRow(f.campaignId)).toBeDefined();
      expect(await drive(x, f.campaignId)).toEqual(['completed']);
      expect(await count('messages', sql`campaign_id = ${f.campaignId}`)).toBe(7);
      // The original initiator stays attributed.
      expect((await campaign(f.campaignId)).startedBy).toBe(A.userId);
    });

    it('cancel skips every pending recipient and removes the claim; messages already created stay', async () => {
      const f = await plant(A, 7, { rate: 1 }); // quota 5 per claim
      const x = executor();
      await x.processClaim((await claimOne(x, f.campaignId))!);
      const res = await as(http().post(url(`${base(A, f.campaignId)}/cancel`)), 'sender');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'cancelled', pauseReason: null });
      const rows = await recipientRows(f.campaignId);
      expect(rows.map((r) => r.status)).toEqual([...Array(5).fill('sent'), 'skipped', 'skipped']);
      expect(rows.slice(5).every((r) => r.skipReason === 'campaign_cancelled')).toBe(true);
      expect(await claimRow(f.campaignId)).toBeUndefined();
      expect(await count('messages', sql`campaign_id = ${f.campaignId}`)).toBe(5);
      expect(await drive(x, f.campaignId)).toEqual([]);
    });

    it('an organisation automation pause between claim and send auto-pauses the campaign (automation_paused)', async () => {
      const f = await plant(A, 2);
      const x = executor();
      const claim = (await claimOne(x, f.campaignId))!;
      await setAutomationPaused(A.orgId, true);
      expect(await x.processClaim(claim)).toMatchObject({
        outcome: 'paused',
        pauseReason: 'automation_paused',
        sent: 0,
      });
      expect(await campaign(f.campaignId)).toMatchObject({
        status: 'paused',
        pauseReason: 'automation_paused',
      });
      expect(await count('messages', sql`campaign_id = ${f.campaignId}`)).toBe(0);
      expect(await audits(f.campaignId, 'campaign.auto_paused')).toHaveLength(1);
      // While the organisation stays paused, a resumed campaign is never claimed.
      const resumed = await as(http().post(url(`${base(A, f.campaignId)}/resume`)), 'sender');
      expect(resumed.status).toBe(200);
      expect(await claimOne(x, f.campaignId)).toBeUndefined();
      await setAutomationPaused(A.orgId, false);
      expect(await drive(x, f.campaignId)).toEqual(['completed']);
    });
  });

  // ===============================================================================================

  describe('scheduled start (app_campaign_start_due, 0070)', () => {
    async function scheduled(who: string) {
      const f = await plant(A, 2, { status: 'draft' });
      const at = new Date(Date.now() + 3_600_000).toISOString();
      const res = await as(
        http()
          .post(url(`${base(A, f.campaignId)}/schedule`))
          .send({ scheduledAt: at }),
        who,
      );
      return { f, res };
    }
    const makeDue = (id: string) =>
      h.admin.execute(
        sql`UPDATE campaigns SET scheduled_at = now() - interval '1 second' WHERE id = ${id}`,
      );

    it('scheduling needs messages.send and records the scheduling user', async () => {
      const denied = await scheduled('manager');
      expect(denied.res.status).toBe(403);
      expect((await campaign(denied.f.campaignId)).status).toBe('draft');
      const ok = await scheduled('sender');
      expect(ok.res.status).toBe(200);
      expect(await campaign(ok.f.campaignId)).toMatchObject({
        status: 'scheduled',
        scheduledBy: tokens.get('sender:id'),
        scheduledByApiKeyId: null,
      });
    });

    it('starts a due campaign once, under the scheduling user, with its claim row and an audit row', async () => {
      const { f } = await scheduled('sender');
      expect(await executor().startDue()).not.toContain(f.campaignId); // not yet due
      await makeDue(f.campaignId);
      const [s1, s2] = await Promise.all([executor().startDue(), executor().startDue()]);
      expect([...s1, ...s2].filter((id) => id === f.campaignId)).toHaveLength(1);
      expect(await campaign(f.campaignId)).toMatchObject({
        status: 'running',
        startedBy: tokens.get('sender:id'),
      });
      expect(await claimRow(f.campaignId)).toBeDefined();
      const [audit] = await audits(f.campaignId, 'campaign.started');
      expect(audit).toMatchObject({ actor_type: 'system', actor_label: 'campaign_scheduler' });
      expect(audit!.metadata).toMatchObject({
        via: 'schedule',
        initiatorUserId: tokens.get('sender:id'),
      });
      expect(await executor().startDue()).not.toContain(f.campaignId);
      expect(await drive(executor(), f.campaignId)).toEqual(['completed']);
    });

    it('never starts a campaign of a paused organisation, nor one with no recorded scheduler', async () => {
      const { f } = await scheduled('sender');
      await makeDue(f.campaignId);
      await setAutomationPaused(A.orgId, true);
      expect(await executor().startDue()).not.toContain(f.campaignId);
      expect((await campaign(f.campaignId)).status).toBe('scheduled');
      await setAutomationPaused(A.orgId, false);

      // Scheduled before 8B-3b: no initiator recorded.
      const legacy = await plant(A, 1, { status: 'draft' });
      await h.admin.execute(
        sql`UPDATE campaigns SET status = 'scheduled', schedule_mode = 'scheduled', scheduled_at = now() - interval '1 second' WHERE id = ${legacy.campaignId}`,
      );
      expect(await executor().startDue()).not.toContain(legacy.campaignId);
      expect((await campaign(legacy.campaignId)).status).toBe('scheduled');
      // Leave neither behind for later cycles.
      await h.admin.execute(
        sql`UPDATE campaigns SET status = 'cancelled' WHERE id IN (${f.campaignId}, ${legacy.campaignId})`,
      );
    });
  });

  // ===============================================================================================

  describe('scheduling authority: messages.send on current grants (both API paths)', () => {
    const draft = () => plant(A, 1, { status: 'draft' });
    const future = () => new Date(Date.now() + 3_600_000).toISOString();
    const patch = (f: Planted, who: string, body: Record<string, unknown>) =>
      as(
        http()
          .patch(url(base(A, f.campaignId)))
          .send(body),
        who,
      );
    const scheduleVia = (f: Planted, who: string) =>
      as(
        http()
          .post(url(`${base(A, f.campaignId)}/schedule`))
          .send({ scheduledAt: future() }),
        who,
      );
    const scheduledAudits = async (id: string) => (await audits(id, 'campaign.scheduled')).length;

    /** A fresh user holding the sender role (campaigns.manage + messages.send) at the workspace. */
    async function revocableSender(label: string) {
      const userId = await userWith(A, label, senderRole, 'workspace');
      return {
        userId,
        revoke: () =>
          h.admin.execute(
            sql`DELETE FROM user_roles WHERE user_id = ${userId} AND role_id = ${senderRole}`,
          ),
      };
    }
    /** Revokes `revoke()` the first time the final transaction re-reads the caller's grants. */
    function revokeAtFinalCheck(revoke: () => Promise<unknown>) {
      const revalidator = h.app.get(PrincipalRevalidator);
      const original = revalidator.currentGrants.bind(revalidator);
      return jest.spyOn(revalidator, 'currentGrants').mockImplementationOnce(async (principal) => {
        await revoke();
        return original(principal);
      });
    }
    async function apiKey(scopes: string[]) {
      const prefix = `ak_test_${hex(8)}`;
      const secret = `s${hex(16)}`;
      const [key] = await h.admin
        .insert(schema.apiKeys)
        .values({
          orgId: A.orgId,
          workspaceId: A.workspaceId,
          name: `p8b3b-${hex(3)}`,
          keyPrefix: prefix,
          keyHash: await credentials.hash(secret),
          scopes,
          createdBy: tokens.get('sender:id')!,
        })
        .returning({ id: schema.apiKeys.id });
      apiKeys.push(key!.id);
      tokens.set(`key:${key!.id}`, `${prefix}.${secret}`);
      return key!.id;
    }

    afterEach(() => jest.restoreAllMocks());

    it('PATCH: campaigns.manage without messages.send cannot move a draft to scheduled (either form); metadata updates still work', async () => {
      const f = await draft();
      const both = await patch(f, 'manager', { scheduleMode: 'scheduled', scheduledAt: future() });
      expect(both.status).toBe(403);
      await h.admin.execute(
        sql`UPDATE campaigns SET scheduled_at = now() + interval '2 hours' WHERE id = ${f.campaignId}`,
      );
      const modeOnly = await patch(f, 'manager', { scheduleMode: 'scheduled' });
      expect(modeOnly.status).toBe(403);
      expect(await campaign(f.campaignId)).toMatchObject({ status: 'draft', scheduledBy: null });
      const renamed = await patch(f, 'manager', { name: `renamed-${hex(3)}` });
      expect(renamed.status).toBe(200);
      expect(renamed.body.data.status).toBe('draft');
    });

    it('PATCH: a sender schedules (recorded as scheduler); a manager cannot re-time it; moving back to draft clears the scheduler', async () => {
      const f = await draft();
      const ok = await patch(f, 'sender', { scheduleMode: 'scheduled', scheduledAt: future() });
      expect(ok.status).toBe(200);
      expect(await campaign(f.campaignId)).toMatchObject({
        status: 'scheduled',
        scheduledBy: tokens.get('sender:id'),
        scheduledByApiKeyId: null,
      });
      expect((await patch(f, 'manager', { scheduledAt: future() })).status).toBe(403);
      expect((await patch(f, 'manager', { name: `renamed-${hex(3)}` })).status).toBe(200);
      expect((await campaign(f.campaignId)).scheduledBy).toBe(tokens.get('sender:id'));
      const back = await patch(f, 'sender', { scheduleMode: 'immediate' });
      expect(back.status).toBe(200);
      expect(await campaign(f.campaignId)).toMatchObject({ status: 'draft', scheduledBy: null });
    });

    it('POST …/schedule: campaigns.manage without messages.send is refused; nothing commits', async () => {
      const f = await draft();
      expect((await scheduleVia(f, 'manager')).status).toBe(403);
      expect(await campaign(f.campaignId)).toMatchObject({ status: 'draft', scheduledBy: null });
      expect(await scheduledAudits(f.campaignId)).toBe(0);
    });

    it('POST …/schedule: messages.send revoked after the preflight — the final transaction refuses and nothing commits', async () => {
      const f = await draft();
      const s = await revocableSender('revoke-schedule');
      const spy = revokeAtFinalCheck(s.revoke);
      const res = await scheduleVia(f, 'revoke-schedule');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(403);
      expect(await campaign(f.campaignId)).toMatchObject({ status: 'draft', scheduledBy: null });
      expect(await scheduledAudits(f.campaignId)).toBe(0);
    });

    it('PATCH: messages.send revoked before the final check — the transition to scheduled does not commit', async () => {
      const f = await draft();
      const s = await revocableSender('revoke-patch');
      const spy = revokeAtFinalCheck(s.revoke);
      const res = await patch(f, 'revoke-patch', {
        scheduleMode: 'scheduled',
        scheduledAt: future(),
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(403);
      expect(await campaign(f.campaignId)).toMatchObject({ status: 'draft', scheduledBy: null });
      expect(await audits(f.campaignId, 'campaign.updated')).toHaveLength(0);
    });

    it('a sender with intact grants schedules through the final check (control for the revocation cases)', async () => {
      const f = await draft();
      await revocableSender('intact-sender');
      const res = await scheduleVia(f, 'intact-sender');
      expect(res.status).toBe(200);
      expect(await campaign(f.campaignId)).toMatchObject({
        status: 'scheduled',
        scheduledBy: tokens.get('intact-sender:id'),
      });
    });

    it('API keys: a key with messages.send schedules (recorded as the key); a key without it is refused on both paths', async () => {
      const sending = await apiKey([
        PERMISSIONS.CAMPAIGNS_READ,
        PERMISSIONS.CAMPAIGNS_MANAGE,
        PERMISSIONS.MESSAGES_SEND,
      ]);
      const managing = await apiKey([PERMISSIONS.CAMPAIGNS_READ, PERMISSIONS.CAMPAIGNS_MANAGE]);
      const f1 = await draft();
      const ok = await as(
        http()
          .post(url(`${base(A, f1.campaignId)}/schedule`))
          .send({ scheduledAt: future() }),
        `key:${sending}`,
      );
      expect(ok.status).toBe(200);
      expect(await campaign(f1.campaignId)).toMatchObject({
        status: 'scheduled',
        scheduledBy: null,
        scheduledByApiKeyId: sending,
      });
      const f2 = await draft();
      expect((await scheduleVia(f2, `key:${managing}`)).status).toBe(403);
      expect(
        (await patch(f2, `key:${managing}`, { scheduleMode: 'scheduled', scheduledAt: future() }))
          .status,
      ).toBe(403);
      expect(await campaign(f2.campaignId)).toMatchObject({
        status: 'draft',
        scheduledByApiKeyId: null,
      });
      // A key revoked after the preflight is refused by the final check.
      const f3 = await draft();
      const spy = revokeAtFinalCheck(() =>
        h.admin.execute(sql`UPDATE api_keys SET revoked_at = now() WHERE id = ${sending}`),
      );
      expect((await scheduleVia(f3, `key:${sending}`)).status).toBe(403);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await campaign(f3.campaignId)).status).toBe('draft');
      for (const f of [f1])
        await h.admin.execute(
          sql`UPDATE campaigns SET status = 'cancelled' WHERE id = ${f.campaignId}`,
        );
    });

    it('the revalidated grants equal what AuthGuard resolves (GET /auth/me/authorization), for a session and an API key', async () => {
      const key = await apiKey([PERMISSIONS.CAMPAIGNS_READ, PERMISSIONS.MESSAGES_SEND]);
      const revalidator = h.app.get(PrincipalRevalidator);
      const shape = (
        grants: readonly {
          scopeType: string;
          scopeId: string | null;
          permissions: readonly string[];
        }[],
      ) =>
        grants
          .map((g) => ({
            scopeType: g.scopeType,
            scopeId: g.scopeId,
            permissions: [...g.permissions].sort(),
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const token = tokens.get('sender')!;
      const sid = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
        .sid as string;
      const me = await as(http().get(url('/auth/me/authorization')), 'sender');
      expect(me.status).toBe(200);
      expect(
        shape(
          await revalidator.currentGrants({
            userId: tokens.get('sender:id')!,
            apiKeyId: null,
            sessionId: sid,
          }),
        ),
      ).toEqual(shape(me.body.data.grants));
      const meKey = await as(http().get(url('/auth/me/authorization')), `key:${key}`);
      expect(meKey.status).toBe(200);
      expect(
        shape(await revalidator.currentGrants({ userId: null, apiKeyId: key, sessionId: null })),
      ).toEqual(shape(meKey.body.data.grants));
      // A revoked session resolves to nothing.
      expect(
        await revalidator.currentGrants({
          userId: tokens.get('sender:id')!,
          apiKeyId: null,
          sessionId: uuidv7(),
        }),
      ).toEqual([]);
    });
  });

  // ===============================================================================================

  describe('database rules added by 0070 (owner, rolled back)', () => {
    it('a campaign has one initiator kind, and API-key start attribution is write-once', async () => {
      const byUser = await plant(A, 0);
      const byKey = await plant(A, 0, { startedBy: null });
      const c = await executorPool.connect();
      try {
        await c.query('BEGIN');
        await c.query('RESET ROLE'); // the clone owner
        const keys: string[] = [];
        for (let i = 0; i < 2; i++)
          keys.push(
            (
              await c.query(
                `INSERT INTO api_keys (org_id, name, key_prefix, key_hash, scopes, created_by)
                 VALUES ($1, $2, $3, 'not-a-real-hash', '[]'::jsonb, $4) RETURNING id`,
                [A.orgId, `p8b3b-${hex(3)}`, `ak_test_${hex(8)}`, A.userId],
              )
            ).rows[0].id as string,
          );
        const attempt = async (text: string, params: unknown[]) => {
          await c.query('SAVEPOINT s');
          try {
            await c.query(text, params);
            await c.query('RELEASE SAVEPOINT s');
            return null;
          } catch (e) {
            await c.query('ROLLBACK TO SAVEPOINT s');
            const { code, constraint } = e as { code?: string; constraint?: string };
            return { code, constraint };
          }
        };
        const setKey = `UPDATE campaigns SET started_by_api_key_id = $2 WHERE id = $1`;
        expect(await attempt(setKey, [byUser.campaignId, keys[0]])).toEqual({
          code: '23514',
          constraint: 'campaigns_single_initiator',
        });
        expect(await attempt(setKey, [byKey.campaignId, keys[0]])).toBeNull();
        expect(await attempt(setKey, [byKey.campaignId, keys[1]])).toEqual({
          code: '23514',
          constraint: 'campaigns_start_write_once',
        });
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
      for (const f of [byUser, byKey])
        await h.admin.execute(
          sql`UPDATE campaign_dispatch SET available_at = now() + interval '1 day' WHERE campaign_id = ${f.campaignId}`,
        );
    });
  });

  // ===============================================================================================

  describe('capability retention (OD-8B3-6)', () => {
    it('purges capabilities older than 90 days, and only those', async () => {
      const f = await plant(A, 1);
      await h.admin.transaction(async (tx: Transaction) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        for (const days of [91, 89])
          await tx.execute(
            sql`INSERT INTO automation_capabilities (org_id, subject_kind, subject_id, automation_id, claim_epoch, token_hash, issued_at, expires_at)
                VALUES (${A.orgId}, 'campaign_recipient', ${f.recipients[0]!.id}, ${f.campaignId}, 1,
                        sha256(convert_to(${uuidv7()}, 'UTF8')),
                        now() - make_interval(days => ${days}), now() - make_interval(days => ${days}) + interval '10 seconds')`,
          );
      });
      expect(await executor().purgeCapabilities()).toBeGreaterThanOrEqual(1);
      expect(
        await count(
          'automation_capabilities',
          sql`automation_id = ${f.campaignId} AND issued_at < now() - interval '90 days'`,
        ),
      ).toBe(0);
      expect(await count('automation_capabilities', sql`automation_id = ${f.campaignId}`)).toBe(1);
      await h.admin.execute(
        sql`UPDATE campaign_dispatch SET available_at = now() + interval '1 day' WHERE campaign_id = ${f.campaignId}`,
      );
    });
  });
});
