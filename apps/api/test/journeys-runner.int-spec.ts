/**
 * Phase 8C PR 8C-3 — the journey runner (`docs/PHASE-8C-JOURNEYS-HANDOVER.md` §§8.2, 8.3, 9, 12).
 * Disposable clones only (`scripts/with-db-clone.mjs`).
 *
 * The runner runs as `acc_journey`: on the disposable clone, through `SET ROLE acc_journey` on
 * an owner connection, so every statement is filtered by the 0064 policies exactly as with the
 * role's own login (which is not provisioned: the role stays NOLOGIN until enablement). The
 * application under test keeps the runner disabled (`JOURNEY_RUNNER_ENABLED` default false).
 */
import {
  ERROR_CODES,
  JOURNEY_RUNNER_ERROR_CODES,
  PERMISSIONS,
  type JourneyGraph,
} from '@acc/contracts';
import { createDatabase, createPool, schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';
import { AuditWriter } from '../src/audit/audit-writer.service';
import { CredentialService } from '../src/iam/credential.service';
import {
  JourneyRunnerService,
  type ClaimResult,
  type JourneyClaim,
} from '../src/journeys/runner/journey-runner.service';
import { JourneyRunner } from '../src/journeys/runner/journey-runner.worker';

const url = (p: string) => `/${PREFIX}${p}`;
const key = () => `journey-8c3-${uuidv7()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Graph = Record<string, unknown>;
const exitNode = (reason?: string) => (reason ? { type: 'exit', reason } : { type: 'exit' });

describe('Phase 8C PR 8C-3: journey runner', () => {
  let h: Harness;
  let A: TenantFixture;
  let B: TenantFixture;
  let tokenA: string;
  let tokenB: string;
  let runnerPool: Pool;
  /** Owner connections that hold row locks for the fencing and transient-failure tests. */
  let lockPool: Pool;
  let segmentVip: string;
  let waChannel: string;
  const runners: JourneyRunnerService[] = [];

  const http = () => request(h.app.getHttpServer());
  const as = <T extends request.Test>(r: T, token = tokenA) =>
    r.set('authorization', `Bearer ${token}`);
  const base = (t: TenantFixture = A) => `/workspaces/${t.workspaceId}/journeys`;

  const makeRunner = (workerId: string, lockTimeoutMs = 300) => {
    const r = new JourneyRunnerService(
      createDatabase(runnerPool),
      h.app.get(AuditWriter),
      undefined,
      { workerId, lockTimeoutMs, leaseSeconds: 30, batchSize: 10, perOrgLimit: 5 },
    );
    runners.push(r);
    return r;
  };
  /** Ticks until nothing is claimable; returns every claim result. */
  const drain = async (runner: JourneyRunnerService, max = 20) => {
    const all: ClaimResult[] = [];
    for (let i = 0; i < max; i++) {
      const results = await runner.tick();
      if (results.length === 0) break;
      all.push(...results);
    }
    return all;
  };

  const contact = async (t: TenantFixture, firstName: string, metadata: object = {}) =>
    (
      await h.admin
        .insert(schema.contacts)
        .values({ orgId: t.orgId, workspaceId: t.workspaceId, firstName, metadata })
        .returning({ id: schema.contacts.id })
    )[0]!.id;

  /** Creates, publishes and activates a journey with `graph`; returns its ids. */
  const activeJourney = async (
    name: string,
    graph: Graph,
    t: TenantFixture = A,
    token = tokenA,
  ) => {
    const created = await as(http().post(url(base(t))), token)
      .set('idempotency-key', key())
      .send({ name });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const v = created.body.data.draftVersion as { id: string; graphSha256: string };
    const saved = await as(http().put(url(`${base(t)}/${id}/versions/${v.id}/graph`)), token).send({
      graph,
      expectedGraphSha256: v.graphSha256,
    });
    expect(saved.status).toBe(200);
    const pub = await as(http().post(url(`${base(t)}/${id}/versions/${v.id}/publish`)), token)
      .set('idempotency-key', key())
      .send({ expectedGraphSha256: saved.body.data.graphSha256 });
    expect(pub.status).toBe(200);
    const act = await as(http().post(url(`${base(t)}/${id}/activate`)), token);
    expect(act.status).toBe(200);
    return { id, versionId: v.id };
  };
  const enrol = async (
    journeyId: string,
    contactIds: string[],
    t: TenantFixture = A,
    token = tokenA,
  ) => {
    const res = await as(http().post(url(`${base(t)}/${journeyId}/enrollments`)), token)
      .set('idempotency-key', key())
      .send({ contactIds });
    expect(res.status).toBe(200);
    return res.body.data.results.map((r: { executionId: string }) => r.executionId) as string[];
  };
  const execution = async (id: string) =>
    (
      await h.admin.execute<{
        status: string;
        current_node_key: string | null;
        state_version: number;
        transitions: number;
        end_reason: string | null;
        journey_version_id: string;
        wake_at: Date | null;
      }>(
        sql`SELECT status, current_node_key, state_version, transitions, end_reason, journey_version_id, wake_at FROM journey_executions WHERE id = ${id}`,
      )
    ).rows[0]!;
  const steps = async (id: string) =>
    (
      await h.admin.execute<{
        seq: number;
        node_key: string;
        outcome: string;
        error_code: string | null;
      }>(
        sql`SELECT seq, node_key, outcome, error_code FROM journey_execution_steps WHERE execution_id = ${id} ORDER BY seq`,
      )
    ).rows;
  const queueRow = async (id: string) =>
    (
      await h.admin.execute<{
        claim_token: string | null;
        attempts: number;
        last_error_code: string | null;
        available_at: Date;
        epoch: number;
      }>(
        sql`SELECT claim_token, attempts, last_error_code, available_at, epoch FROM journey_execution_queue WHERE execution_id = ${id}`,
      )
    ).rows[0];
  /** Simulates time passing: the timer (wake_at) and the queue row are both due now. */
  const makeDue = async (id: string) => {
    await h.admin.execute(
      sql`UPDATE journey_executions SET wake_at = now() - interval '1 second' WHERE id = ${id} AND status = 'waiting'`,
    );
    await h.admin.execute(
      sql`UPDATE journey_execution_queue SET available_at = now() - interval '1 second' WHERE execution_id = ${id}`,
    );
  };
  const messageCount = async () =>
    Number(
      (
        await h.admin.execute<{ n: string }>(
          sql`SELECT ((SELECT count(*) FROM messages WHERE org_id IN (${A.orgId}, ${B.orgId})) + (SELECT count(*) FROM message_dispatch_queue WHERE org_id IN (${A.orgId}, ${B.orgId})))::text AS n`,
        )
      ).rows[0]!.n,
    );

  /** A runner-principal session bound to one claim, for direct policy checks. */
  const asRunner = async <T>(
    ctx: { orgId: string; executionId: string; claimToken: string },
    work: (c: PoolClient) => Promise<T>,
  ): Promise<T> => {
    const c = await runnerPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.current_org_id', $1, true), set_config('app.journey_execution_id', $2, true), set_config('app.journey_claim_token', $3, true)`,
        [ctx.orgId, ctx.executionId, ctx.claimToken],
      );
      return await work(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  };

  beforeAll(async () => {
    h = await startHarness();
    await h.clearRateLimits();
    const credentials = h.app.get(CredentialService);
    A = await createTenant(h.admin, 'j3-a', credentials);
    B = await createTenant(h.admin, 'j3-b', credentials);
    for (const t of [A, B]) {
      const roleId = uuidv7();
      await h.admin.insert(schema.roles).values({
        id: roleId,
        orgId: t.orgId,
        key: `j3_all_${t.slug.replace(/-/g, '_')}`,
        name: `Journeys 8C-3 ${t.slug}`,
        description: 'Journeys 8C-3 test role',
        isSystemRole: false,
        allowedScopeTypes: ['organization', 'workspace'],
      });
      for (const k of [
        PERMISSIONS.JOURNEYS_READ,
        PERMISSIONS.JOURNEYS_MANAGE,
        PERMISSIONS.MESSAGES_SEND,
      ]) {
        const [p] = await h.admin
          .select({ id: schema.permissions.id })
          .from(schema.permissions)
          .where(eq(schema.permissions.key, k));
        await h.admin.insert(schema.rolePermissions).values({ roleId, permissionId: p!.id });
      }
      await h.admin.insert(schema.userRoles).values({
        orgId: t.orgId,
        userId: t.userId,
        roleId,
        scopeType: 'organization',
        scopeId: t.orgId,
      });
    }
    segmentVip = (
      await h.admin
        .insert(schema.segments)
        .values({
          orgId: A.orgId,
          workspaceId: A.workspaceId,
          name: `vip-${uuidv7()}`,
          criteria: { tags: ['VIP'] },
        })
        .returning({ id: schema.segments.id })
    )[0]!.id;
    waChannel = (
      await h.admin
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(eq(schema.channels.code, 'whatsapp'))
    )[0]!.id;
    const login = async (email: string) =>
      (await http().post(url('/auth/login')).send({ email, password: PASSWORD })).body.data
        .accessToken as string;
    tokenA = await login(A.email);
    tokenB = await login(B.email);
    runnerPool = createPool({
      connectionString: process.env.DATABASE_ADMIN_URL!,
      max: 6,
      applicationName: 'acc-test-journey-runner',
    });
    lockPool = createPool({
      connectionString: process.env.DATABASE_ADMIN_URL!,
      max: 2,
      applicationName: 'acc-test-journey-locks',
    });
    // The runner principal: every connection of this pool acts as acc_journey.
    runnerPool.on('connect', (client) => {
      void client.query('SET ROLE acc_journey');
    });
  }, 90_000);

  afterAll(async () => {
    if (!h) return;
    await runnerPool?.end();
    await lockPool?.end();
    for (const t of [A, B].filter(Boolean)) {
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        for (const table of [
          'journey_execution_steps',
          'journey_execution_queue',
          'journey_executions',
          'journey_triggers',
          'journey_versions',
          'journeys',
          'segments',
        ])
          await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${t.orgId}`);
      });
      await destroyTenant(h.admin, t);
    }
    await h.close();
  }, 90_000);

  describe('disabled by default', () => {
    it('the application starts no runner and opens no acc_journey connection; enrolments stay unclaimed', async () => {
      expect(h.app.get(JourneyRunner).isRunning()).toBe(false);
      expect(h.app.get(JourneyRunnerService).available).toBe(false);
      await expect(h.app.get(JourneyRunnerService).tick()).rejects.toThrow(/disabled/);
      const j = await activeJourney('Idle', {
        schemaVersion: 1,
        entry: 'start',
        nodes: {
          start: { type: 'entry', trigger: { kind: 'api' }, next: 'done' },
          done: exitNode(),
        },
      });
      const [id] = await enrol(j.id, [await contact(A, 'idle')]);
      await sleep(1_500);
      expect(await execution(id!)).toMatchObject({ status: 'running', current_node_key: 'done' });
      expect(await queueRow(id!)).toMatchObject({ claim_token: null, attempts: 0, epoch: 0 });
      const role = await h.admin.execute<{ rolcanlogin: boolean }>(
        sql`SELECT rolcanlogin FROM pg_roles WHERE rolname = 'acc_journey'`,
      );
      expect(role.rows).toEqual([{ rolcanlogin: false }]);
      // Archived, so this execution does not reach the runner instances the later tests drive.
      expect((await as(http().post(url(`${base()}/${j.id}/archive`)))).status).toBe(200);
    });
  });

  describe('node processing', () => {
    it('runs update_contact, condition, placeholder and exit; audits the contact write; history matches state', async () => {
      const graph: Graph = {
        schemaVersion: 1,
        entry: 'start',
        nodes: {
          start: { type: 'entry', trigger: { kind: 'api' }, next: 'upd' },
          upd: {
            type: 'update_contact',
            operations: [
              { op: 'add_tag', tag: 'VIP' },
              {
                op: 'set_attribute',
                field: 'custom.plan',
                value: { source: 'literal', value: 'gold' },
              },
              {
                op: 'set_attribute',
                field: 'lastName',
                value: { source: 'contact_field', field: 'firstName' },
              },
            ],
            next: 'check',
          },
          check: {
            type: 'condition',
            rule: { kind: 'tag', tag: 'vip', present: true },
            onTrue: 'hook',
            onFalse: 'no',
          },
          hook: { type: 'webhook', label: 'CRM sync', next: 'crm' },
          crm: { type: 'crm_action', next: 'yes' },
          yes: exitNode('vip_path'),
          no: exitNode('other_path'),
        },
      };
      const j = await activeJourney('Path', graph);
      const c = await contact(A, 'Asha', { tags: ['existing'] });
      const [id] = await enrol(j.id, [c]);
      const runner = makeRunner('w-path');
      const results = await drain(runner);
      expect(results).toEqual([{ executionId: id, outcome: 'ended', transitions: 5 }]);
      expect(await execution(id!)).toMatchObject({
        status: 'completed',
        end_reason: 'vip_path',
        state_version: 6,
        transitions: 6,
      });
      expect((await steps(id!)).map((s) => [s.seq, s.node_key, s.outcome])).toEqual([
        [1, 'start', 'entered'],
        [2, 'upd', 'completed'],
        [3, 'check', 'completed'],
        [4, 'hook', 'stubbed'],
        [5, 'crm', 'stubbed'],
        [6, 'yes', 'exited'],
      ]);
      const [row] = (
        await h.admin.execute<{
          first_name: string;
          last_name: string;
          metadata: Record<string, unknown>;
        }>(sql`SELECT first_name, last_name, metadata FROM contacts WHERE id = ${c}`)
      ).rows;
      expect(row).toMatchObject({ first_name: 'Asha', last_name: 'Asha' });
      expect(row!.metadata).toEqual({ tags: ['existing', 'VIP'], plan: 'gold' });
      const audit = await h.admin.execute<{
        actor_type: string;
        actor_label: string;
        metadata: Record<string, unknown>;
      }>(
        sql`SELECT actor_type, actor_label, metadata FROM audit_logs WHERE resource_id = ${c} AND action = 'contact.updated'`,
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({ actor_type: 'system', actor_label: 'journey_runner' });
      expect(audit.rows[0]!.metadata).toMatchObject({
        executionId: id,
        journeyId: j.id,
        nodeKey: 'upd',
      });
      expect(JSON.stringify(audit.rows[0]!.metadata)).not.toMatch(/gold|VIP|Asha/);
      expect(await queueRow(id!)).toBeUndefined();
      expect(await messageCount()).toBe(0);
    });

    it('J-B1: every condition kind routes true and false on live contact state', async () => {
      const condGraph = (rule: object): Graph => ({
        schemaVersion: 1,
        entry: 'start',
        nodes: {
          start: { type: 'entry', trigger: { kind: 'api' }, next: 'cond' },
          cond: { type: 'condition', rule, onTrue: 'yes', onFalse: 'no' },
          yes: exitNode('yes'),
          no: exitNode('no'),
        },
      });
      const cases: [string, object, object, object][] = [
        [
          'attr eq',
          { kind: 'attribute', field: 'custom.tier', op: 'eq', value: 'GOLD' },
          { tier: 'gold' },
          { tier: 'silver' },
        ],
        [
          'attr exists',
          { kind: 'attribute', field: 'custom.tier', op: 'exists' },
          { tier: 'x' },
          {},
        ],
        [
          'attr neq',
          { kind: 'attribute', field: 'custom.tier', op: 'neq', value: 'gold' },
          {},
          { tier: 'Gold' },
        ],
        [
          'tag absent',
          { kind: 'tag', tag: 'blocked', present: false },
          { tags: ['a'] },
          { tag_list: 'x, blocked' },
        ],
        [
          'segment',
          { kind: 'segment', segmentId: segmentVip, member: true },
          { tags: ['vip'] },
          { tags: ['other'] },
        ],
      ];
      const runner = makeRunner('w-cond');
      for (const [name, rule, yesMeta, noMeta] of cases) {
        const j = await activeJourney(`Cond ${name}`, condGraph(rule));
        const [yes, no] = await enrol(j.id, [
          await contact(A, 'y', yesMeta),
          await contact(A, 'n', noMeta),
        ]);
        await drain(runner);
        expect([name, (await execution(yes!)).end_reason]).toEqual([name, 'yes']);
        expect([name, (await execution(no!)).end_reason]).toEqual([name, 'no']);
      }
      // Consent: the latest event per channel and consent type decides.
      const j = await activeJourney(
        'Cond consent',
        condGraph({
          kind: 'consent',
          channel: 'whatsapp',
          consentType: 'marketing',
          granted: true,
        }),
      );
      const granted = await contact(A, 'g');
      const revoked = await contact(A, 'r');
      const consent = (c: string, event: 'grant' | 'revoke', at: string) =>
        h.admin.insert(schema.consentEvents).values({
          orgId: A.orgId,
          workspaceId: A.workspaceId,
          contactId: c,
          channelId: waChannel,
          consentType: 'marketing',
          event,
          occurredAt: new Date(at),
          source: 'test',
        });
      await consent(granted, 'revoke', '2026-01-01T00:00:00Z');
      await consent(granted, 'grant', '2026-02-01T00:00:00Z');
      await consent(revoked, 'grant', '2026-01-01T00:00:00Z');
      await consent(revoked, 'revoke', '2026-02-01T00:00:00Z');
      const [g, r] = await enrol(j.id, [granted, revoked]);
      await drain(runner);
      expect((await execution(g!)).end_reason).toBe('yes');
      expect((await execution(r!)).end_reason).toBe('no');
    });

    it('waits arm a timer, release the claim and complete when due; a past wait_until passes through', async () => {
      const j = await activeJourney('Waits', {
        schemaVersion: 1,
        entry: 'start',
        nodes: {
          start: { type: 'entry', trigger: { kind: 'api' }, next: 'past' },
          past: { type: 'wait_until', at: '2020-01-01T00:00:00Z', next: 'hour' },
          hour: { type: 'wait_duration', seconds: 3600, next: 'done' },
          done: exitNode(),
        },
      });
      const [id] = await enrol(j.id, [await contact(A, 'w')]);
      const runner = makeRunner('w-wait');
      const before = Date.now();
      expect(await drain(runner)).toEqual([
        { executionId: id, outcome: 'waiting', transitions: 2 },
      ]);
      const waiting = await execution(id!);
      expect(waiting).toMatchObject({
        status: 'waiting',
        current_node_key: 'hour',
        state_version: 3,
      });
      const wake = new Date(waiting.wake_at!).getTime();
      expect(wake - before).toBeGreaterThan(3_590_000);
      const q = await queueRow(id!);
      expect(q).toMatchObject({ claim_token: null, attempts: 0 });
      expect(new Date(q!.available_at).getTime()).toBe(wake);
      expect(await runner.claim()).toEqual([]); // not due
      await makeDue(id!);
      expect(await drain(runner)).toEqual([{ executionId: id, outcome: 'ended', transitions: 2 }]);
      expect((await steps(id!)).map((s) => [s.node_key, s.outcome])).toEqual([
        ['start', 'entered'],
        ['past', 'completed'],
        ['hour', 'waited'],
        ['hour', 'completed'],
        ['done', 'exited'],
      ]);
      expect((await execution(id!)).status).toBe('completed');
    });

    it('fails closed on a send node (8C-5b: the production port is unavailable, SEND_UNAVAILABLE) and on a reserved contact field; no partial write, no message', async () => {
      // A send version cannot be activated (8C-2); planted by the owner to prove the runner's own refusal.
      const created = await as(http().post(url(base())))
        .set('idempotency-key', key())
        .send({ name: 'Planted send' });
      const jId = created.body.data.id as string;
      const v = created.body.data.draftVersion as { id: string; graphSha256: string };
      const [tpl] = await h.admin
        .insert(schema.templates)
        .values({
          orgId: A.orgId,
          channelId: waChannel,
          name: `t-${uuidv7()}`,
          body: 'Hi',
          variables: [],
          approvalStatus: 'approved',
        })
        .returning({ id: schema.templates.id });
      const sendGraph: JourneyGraph = {
        schemaVersion: 1,
        entry: 'start',
        nodes: {
          start: { type: 'entry', trigger: { kind: 'api' }, next: 'send' },
          send: {
            type: 'send_message',
            channel: 'whatsapp',
            templateId: tpl!.id,
            variables: {},
            onSuppressed: 'continue',
            onRefused: 'exit',
            next: 'done',
          },
          done: { type: 'exit' },
        },
      };
      const saved = await as(http().put(url(`${base()}/${jId}/versions/${v.id}/graph`))).send({
        graph: sendGraph,
        expectedGraphSha256: v.graphSha256,
      });
      await as(http().post(url(`${base()}/${jId}/versions/${v.id}/publish`)))
        .set('idempotency-key', key())
        .send({ expectedGraphSha256: saved.body.data.graphSha256 });
      expect((await as(http().post(url(`${base()}/${jId}/activate`)))).status).toBe(400);
      await h.admin.execute(
        sql`UPDATE journeys SET status = 'active', active_version_id = ${v.id}, activated_at = now() WHERE id = ${jId}`,
      );
      const c = await contact(A, 's');
      // An active identity, so the node reaches the (unavailable) production send port.
      await h.admin.insert(schema.contactIdentities).values({
        orgId: A.orgId,
        workspaceId: A.workspaceId,
        contactId: c,
        channelId: waChannel,
        rawAddress: '+12025550177',
        normalizedAddress: '+12025550177',
        isPrimary: true,
      });
      const [exec] = (
        await h.admin.execute<{ id: string }>(
          sql`INSERT INTO journey_executions (org_id, workspace_id, journey_id, journey_version_id, contact_id, current_node_key, state_version, transitions, entry_kind, entry_ref)
              VALUES (${A.orgId}, ${A.workspaceId}, ${jId}, ${v.id}, ${c}, 'send', 1, 1, 'api', 'planted') RETURNING id`,
        )
      ).rows;
      await h.admin.execute(
        sql`INSERT INTO journey_execution_queue (execution_id, org_id) VALUES (${exec!.id}, ${A.orgId})`,
      );
      const runner = makeRunner('w-send');
      await drain(runner);
      expect(await execution(exec!.id)).toMatchObject({
        status: 'failed',
        end_reason: 'node_failed',
      });
      expect(await steps(exec!.id)).toEqual([
        {
          seq: 2,
          node_key: 'send',
          outcome: 'failed',
          error_code: JOURNEY_RUNNER_ERROR_CODES.SEND_UNAVAILABLE,
        },
      ]);
      expect(await messageCount()).toBe(0);

      const reserved = await activeJourney('Reserved field', {
        schemaVersion: 1,
        entry: 'start',
        nodes: {
          start: { type: 'entry', trigger: { kind: 'api' }, next: 'upd' },
          upd: {
            type: 'update_contact',
            operations: [
              { op: 'add_tag', tag: 'should-not-stick' },
              {
                op: 'set_attribute',
                field: 'custom.tags',
                value: { source: 'literal', value: 'x' },
              },
            ],
            next: 'done',
          },
          done: exitNode(),
        },
      });
      const rc = await contact(A, 'reserved', { tags: ['keep'] });
      const [rid] = await enrol(reserved.id, [rc]);
      await drain(runner);
      expect(await execution(rid!)).toMatchObject({ status: 'failed', end_reason: 'node_failed' });
      expect((await steps(rid!)).at(-1)).toMatchObject({
        node_key: 'upd',
        outcome: 'failed',
        error_code: JOURNEY_RUNNER_ERROR_CODES.CONTACT_FIELD_RESERVED,
      });
      const [meta] = (
        await h.admin.execute<{ metadata: unknown }>(
          sql`SELECT metadata FROM contacts WHERE id = ${rc}`,
        )
      ).rows;
      expect(meta!.metadata).toEqual({ tags: ['keep'] }); // the savepoint undid the tag
    });
  });

  describe('claiming, leases and fencing', () => {
    const linear: Graph = {
      schemaVersion: 1,
      entry: 'start',
      nodes: {
        start: { type: 'entry', trigger: { kind: 'api' }, next: 'a' },
        a: { type: 'webhook', next: 'b' },
        b: { type: 'human_handoff', next: 'c' },
        c: { type: 'ai_handoff', next: 'done' },
        done: exitNode(),
      },
    };

    it('J-C1: two runners on the same due executions: each transition once, history equals state', async () => {
      const j = await activeJourney('Concurrent', linear);
      const ids = await enrol(
        j.id,
        await Promise.all([1, 2, 3, 4, 5, 6].map((i) => contact(A, `cc${i}`))),
      );
      const r1 = makeRunner('w-c1');
      const r2 = makeRunner('w-c2');
      for (let i = 0; i < 10; i++) {
        const [x, y] = await Promise.all([r1.tick(), r2.tick()]);
        if (x.length + y.length === 0) break;
      }
      for (const id of ids) {
        const e = await execution(id);
        expect(e).toMatchObject({ status: 'completed', state_version: 5, transitions: 5 });
        expect((await steps(id)).map((s) => s.seq)).toEqual([1, 2, 3, 4, 5]);
      }
    });

    it('per-organisation fairness: one claim call takes at most the per-organisation share', async () => {
      const j = await activeJourney('Fair', linear);
      await enrol(j.id, await Promise.all([1, 2, 3, 4, 5, 6, 7].map((i) => contact(A, `f${i}`))));
      const runner = makeRunner('w-fair');
      const claims = await runner.claim(10);
      expect(claims).toHaveLength(5);
      for (const c of claims) await runner.processClaim(c);
      await drain(runner);
    });

    it('duplicate processing of one claim commits each transition once', async () => {
      const j = await activeJourney('Duplicate', linear);
      const [id] = await enrol(j.id, [await contact(A, 'dup')]);
      const runner = makeRunner('w-dup', 5_000);
      const [claim] = await runner.claim(1);
      const [x, y] = await Promise.all([runner.processClaim(claim!), runner.processClaim(claim!)]);
      expect(x.transitions + y.transitions).toBe(4);
      expect([x.outcome, y.outcome].sort()).toEqual(['ended', 'fenced']);
      expect((await steps(id!)).map((s) => s.seq)).toEqual([1, 2, 3, 4, 5]);
    });

    it('J-C3: an expired lease fences its worker; the next claim takes over with a new epoch', async () => {
      const j = await activeJourney('Lease', linear);
      const [id] = await enrol(j.id, [await contact(A, 'lease')]);
      const stale = makeRunner('w-stale');
      const fresh = makeRunner('w-fresh');
      const [old] = await stale.claim(1);
      await h.admin.execute(
        sql`UPDATE journey_execution_queue SET claimed_until = now() - interval '1 second' WHERE execution_id = ${id}`,
      );
      // Expired but not yet re-claimed: the stale worker sees and writes nothing.
      expect(await stale.processClaim(old!)).toEqual({
        executionId: id,
        outcome: 'fenced',
        transitions: 0,
      });
      expect(await steps(id!)).toHaveLength(1);
      const [taken] = await fresh.claim(1);
      expect(taken!.epoch).toBe(old!.epoch + 1);
      expect(taken!.claimToken).not.toBe(old!.claimToken);
      expect(await stale.processClaim(old!)).toMatchObject({ outcome: 'fenced', transitions: 0 });
      expect(await fresh.processClaim(taken!)).toMatchObject({ outcome: 'ended', transitions: 4 });
      expect((await steps(id!)).map((s) => s.seq)).toEqual([1, 2, 3, 4, 5]);
    });

    it('a transition whose state_version changed underneath it is fenced and writes nothing', async () => {
      const j = await activeJourney('Fence', linear);
      const [id] = await enrol(j.id, [await contact(A, 'fence')]);
      const runner = makeRunner('w-fence', 5_000);
      const [claim] = await runner.claim(1);
      const other = await lockPool.connect();
      try {
        await other.query('BEGIN');
        await other.query(
          'UPDATE journey_executions SET state_version = state_version + 1 WHERE id = $1',
          [id],
        );
        const processing = runner.processClaim(claim!);
        await sleep(300);
        await other.query('COMMIT');
        expect(await processing).toMatchObject({ outcome: 'fenced', transitions: 0 });
      } finally {
        other.release();
      }
      expect(await steps(id!)).toHaveLength(1);
      expect(await execution(id!)).toMatchObject({ state_version: 2, current_node_key: 'a' });
    });

    it('a paused journey is never claimed; a journey paused after the claim is released untouched', async () => {
      const j = await activeJourney('Paused', linear);
      const [id] = await enrol(j.id, [await contact(A, 'p')]);
      const runner = makeRunner('w-pause');
      await as(http().post(url(`${base()}/${j.id}/pause`)));
      expect(await runner.claim()).toEqual([]);
      expect(await queueRow(id!)).toMatchObject({ claim_token: null, attempts: 0, epoch: 0 });
      await as(http().post(url(`${base()}/${j.id}/resume`)));
      const [claim] = await runner.claim(1);
      await as(http().post(url(`${base()}/${j.id}/pause`)));
      expect(await runner.processClaim(claim!)).toEqual({
        executionId: id,
        outcome: 'inactive',
        transitions: 0,
      });
      expect(await queueRow(id!)).toMatchObject({ claim_token: null, attempts: 0 });
      expect(await steps(id!)).toHaveLength(1);
      await as(http().post(url(`${base()}/${j.id}/resume`)));
      await drain(runner);
      expect((await execution(id!)).status).toBe('completed');
    });

    it('J-V1: an in-flight execution finishes on its own version after a new version is promoted', async () => {
      const tagGraph = (tag: string): Graph => ({
        schemaVersion: 1,
        entry: 'start',
        nodes: {
          start: { type: 'entry', trigger: { kind: 'api' }, next: 'hold' },
          hold: { type: 'wait_duration', seconds: 600, next: 'tag' },
          tag: { type: 'update_contact', operations: [{ op: 'add_tag', tag }], next: 'done' },
          done: exitNode(),
        },
      });
      const j = await activeJourney('Versions', tagGraph('v1'));
      const x = await contact(A, 'x');
      const [xid] = await enrol(j.id, [x]);
      const runner = makeRunner('w-ver');
      await drain(runner);
      expect((await execution(xid!)).status).toBe('waiting');
      const draft = await as(http().post(url(`${base()}/${j.id}/versions`))).set(
        'idempotency-key',
        key(),
      );
      const saved = await as(
        http().put(url(`${base()}/${j.id}/versions/${draft.body.data.id}/graph`)),
      ).send({
        graph: tagGraph('v2'),
        expectedGraphSha256: draft.body.data.graphSha256,
      });
      const pub = await as(
        http().post(url(`${base()}/${j.id}/versions/${draft.body.data.id}/publish`)),
      )
        .set('idempotency-key', key())
        .send({ expectedGraphSha256: saved.body.data.graphSha256 });
      expect(pub.status).toBe(200);
      const y = await contact(A, 'y');
      const [yid] = await enrol(j.id, [y]);
      await makeDue(xid!);
      await drain(runner);
      await makeDue(yid!);
      await drain(runner);
      const tags = async (c: string) =>
        (
          await h.admin.execute<{ m: { tags?: string[] } }>(
            sql`SELECT metadata AS m FROM contacts WHERE id = ${c}`,
          )
        ).rows[0]!.m.tags ?? [];
      expect(await execution(xid!)).toMatchObject({
        status: 'completed',
        journey_version_id: j.versionId,
      });
      expect(await tags(x)).toEqual(['v1']);
      expect(await execution(yid!)).toMatchObject({
        status: 'completed',
        journey_version_id: draft.body.data.id,
      });
      expect(await tags(y)).toEqual(['v2']);
    });
  });

  describe('retries, poison and terminal states', () => {
    const tagger: Graph = {
      schemaVersion: 1,
      entry: 'start',
      nodes: {
        start: { type: 'entry', trigger: { kind: 'api' }, next: 'upd' },
        upd: {
          type: 'update_contact',
          operations: [{ op: 'add_tag', tag: 'retry' }],
          next: 'done',
        },
        done: exitNode(),
      },
    };

    it('a transient failure rolls back and retries with backoff, then fails RUNNER_RETRY_EXHAUSTED after 3 attempts', async () => {
      const j = await activeJourney('Transient', tagger);
      const c = await contact(A, 'locked');
      const [id] = await enrol(j.id, [c]);
      const runner = makeRunner('w-transient', 200);
      const holder = await lockPool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM contacts WHERE id = $1 FOR UPDATE', [c]);
        for (const attempt of [1, 2]) {
          const results = await runner.tick();
          expect(results).toEqual([
            { executionId: id, outcome: 'retry', transitions: 0, errorCode: '55P03' },
          ]);
          const q = await queueRow(id!);
          expect(q).toMatchObject({
            attempts: attempt,
            last_error_code: '55P03',
            claim_token: null,
          });
          expect(new Date(q!.available_at).getTime()).toBeGreaterThan(Date.now());
          expect(await execution(id!)).toMatchObject({
            status: 'running',
            current_node_key: 'upd',
            state_version: 1,
          });
          await makeDue(id!);
        }
        expect(await runner.tick()).toEqual([
          {
            executionId: id,
            outcome: 'ended',
            transitions: 0,
            errorCode: 'RUNNER_RETRY_EXHAUSTED',
          },
        ]);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      expect(await execution(id!)).toMatchObject({
        status: 'failed',
        end_reason: 'runner_retry_exhausted',
      });
      expect(await steps(id!)).toEqual([
        { seq: 1, node_key: 'start', outcome: 'entered', error_code: null },
        { seq: 2, node_key: 'upd', outcome: 'failed', error_code: 'RUNNER_RETRY_EXHAUSTED' },
      ]);
      expect(await queueRow(id!)).toBeUndefined();
      const [meta] = (
        await h.admin.execute<{ m: unknown }>(
          sql`SELECT metadata AS m FROM contacts WHERE id = ${c}`,
        )
      ).rows;
      expect(meta!.m).toEqual({}); // nothing from a rolled-back attempt
    });

    it('an execution claimed again and again without progress fails as poison (RUNNER_POISONED)', async () => {
      const j = await activeJourney('Poison', tagger);
      const [id] = await enrol(j.id, [await contact(A, 'poison')]);
      // Five earlier claims that never committed (crashed workers whose leases lapsed).
      await h.admin.execute(
        sql`UPDATE journey_execution_queue SET attempts = 5 WHERE execution_id = ${id}`,
      );
      const runner = makeRunner('w-poison');
      expect(await runner.tick()).toEqual([
        { executionId: id, outcome: 'ended', transitions: 0, errorCode: 'RUNNER_POISONED' },
      ]);
      expect(await execution(id!)).toMatchObject({
        status: 'failed',
        end_reason: 'runner_poisoned',
      });
      expect((await steps(id!)).at(-1)).toMatchObject({
        outcome: 'failed',
        error_code: 'RUNNER_POISONED',
      });
      expect(await queueRow(id!)).toBeUndefined();
    });

    it('ended executions are immutable: the runner never touches an execution cancelled by an operator', async () => {
      const j = await activeJourney('Cancelled', tagger);
      const [id] = await enrol(j.id, [await contact(A, 'cancel')]);
      const runner = makeRunner('w-cancelled', 5_000);
      const [claim] = await runner.claim(1);
      const cancel = as(http().post(url(`${base()}/${j.id}/executions/${id}/cancel`)));
      const [result] = await Promise.all([runner.processClaim(claim!), cancel]);
      const e = await execution(id!);
      if (e.status === 'cancelled') {
        // Cancel won the row: the runner's work is fenced or already committed before it.
        expect(['fenced', 'ended']).toContain(result.outcome);
      } else {
        expect(e.status).toBe('completed');
      }
      const s = await steps(id!);
      expect(s.map((x) => x.seq)).toEqual(s.map((_, i) => i + 1));
    });
  });

  describe('acc_journey isolation (0064 policies)', () => {
    it('a claim sees exactly its execution, journey, version and contact; nothing of other executions or organisations', async () => {
      const j = await activeJourney('Isolation', {
        schemaVersion: 1,
        entry: 'start',
        nodes: {
          start: { type: 'entry', trigger: { kind: 'api' }, next: 'done' },
          done: exitNode(),
        },
      });
      const [mine, other] = await enrol(j.id, [
        await contact(A, 'mine'),
        await contact(A, 'other'),
      ]);
      const jb = await activeJourney(
        'B isolation',
        {
          schemaVersion: 1,
          entry: 'start',
          nodes: {
            start: { type: 'entry', trigger: { kind: 'api' }, next: 'done' },
            done: exitNode(),
          },
        },
        B,
        tokenB,
      );
      await enrol(jb.id, [await contact(B, 'b')], B, tokenB);
      const runner = makeRunner('w-iso');
      const claims: JourneyClaim[] = await runner.claim(10);
      const claim = claims.find((c) => c.executionId === mine)!;
      expect(claim).toBeDefined();
      const counts = async (ctx: { orgId: string; executionId: string; claimToken: string }) =>
        asRunner(ctx, async (c) => {
          const n = async (q: string) => Number((await c.query(q)).rows[0].n);
          return {
            executions: await n('SELECT count(*) AS n FROM journey_executions'),
            contacts: await n('SELECT count(*) AS n FROM contacts'),
            journeys: await n('SELECT count(*) AS n FROM journeys'),
            versions: await n('SELECT count(*) AS n FROM journey_versions'),
            queue: await n('SELECT count(*) AS n FROM journey_execution_queue'),
            steps: await n('SELECT count(*) AS n FROM journey_execution_steps'),
            segments: await n('SELECT count(*) AS n FROM segments'),
          };
        });
      const ctx = { orgId: A.orgId, executionId: mine!, claimToken: claim.claimToken };
      expect(await counts(ctx)).toEqual({
        executions: 1,
        contacts: 1,
        journeys: 1,
        versions: 1,
        queue: 1,
        steps: 1,
        segments: Number(
          (
            await h.admin.execute<{ n: string }>(
              sql`SELECT count(*)::text AS n FROM segments WHERE workspace_id = ${A.workspaceId}`,
            )
          ).rows[0]!.n,
        ),
      });
      // Without the live claim nothing is visible except the content-free queue row of the
      // execution the session names (ids, timestamps, attempts: what the claim function itself
      // reads); in another organisation, not even that.
      const nothing = {
        executions: 0,
        contacts: 0,
        journeys: 0,
        versions: 0,
        queue: 1,
        steps: 0,
        segments: 0,
      };
      expect(await counts({ ...ctx, claimToken: uuidv7() })).toEqual(nothing);
      expect(await counts({ ...ctx, executionId: other! })).toEqual(nothing);
      expect(await counts({ ...ctx, orgId: B.orgId })).toEqual({ ...nothing, queue: 0 });
      // Privileges the runner principal must never have. (8C-5b, 0067: it may read the outcome
      // columns of its claimed execution's attributed messages — never their content.)
      for (const q of [
        'SELECT recipient_address, payload FROM messages LIMIT 1',
        'INSERT INTO messages (org_id) VALUES (gen_random_uuid())',
        'INSERT INTO message_dispatch_queue (message_id, org_id) VALUES (gen_random_uuid(), gen_random_uuid())',
        "UPDATE journey_execution_steps SET outcome = 'failed'",
        'DELETE FROM journey_executions',
        'SELECT 1 FROM usage_ledger LIMIT 1',
        'SELECT 1 FROM api_keys LIMIT 1',
      ]) {
        await expect(asRunner(ctx, (c) => c.query(q))).rejects.toThrow(/permission denied/);
      }
      // An expired lease closes everything.
      await h.admin.execute(
        sql`UPDATE journey_execution_queue SET claimed_until = now() - interval '1 second' WHERE execution_id = ${mine}`,
      );
      expect(await counts(ctx)).toEqual(nothing);
      for (const c of claims)
        await h.admin.execute(
          sql`UPDATE journey_execution_queue SET claim_token = NULL, claimed_until = NULL WHERE execution_id = ${c.executionId}`,
        );
      void ERROR_CODES;
    });
  });
});
