/**
 * Phase 8C PR 8C-5a — journey send attribution (migration 0066; handover Rev 2 §§3.1, 4, 8).
 * Disposable clones only (`scripts/with-db-clone.mjs`).
 *
 * Proves, against the real application:
 *   - direct-API invariance: `POST /messages` sets no attribution and its `message.queued`
 *     payload is exactly `{channelCode, recipient}`;
 *   - the shared core with a journey origin (test-only caller, an authorised `acc_app`
 *     transaction): both columns set, every other field identical to the direct path, and a
 *     mismatched contact, journey or organisation refused by the composite foreign key;
 *   - the database rules: shape CHECK, composite FK per dimension, write-once, the step <->
 *     message FK, CHECK, trigger and uniqueness, and the `wait_deadline_at` CHECK.
 *
 * Nothing here enables a journey send: the runner, event intake and scheduler stay disabled
 * and no production code constructs a `SubmissionOrigin`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { PERMISSIONS } from '@acc/contracts';
import { createPool, schema } from '@acc/db';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

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
import { CredentialService } from '../src/iam/credential.service';
import { JourneyRunner } from '../src/journeys/runner/journey-runner.worker';
import { JourneyOriginProbeController } from './journey-origin-probe.controller';

jest.setTimeout(60_000);

const url = (p: string) => `/${PREFIX}${p}`;
const key = () => `journey-8c5a-${uuidv7()}`;
const R1 = '+12025550141';
const R2 = '+12025550142';
const PAYLOAD = { text: 'attribution' };

/** Columns that legitimately differ between two submissions of the same request. */
const PER_SUBMISSION = ['id', 'created_at', 'updated_at', 'correlation_id'];
const ATTRIBUTION = ['journey_id', 'journey_execution_id', 'campaign_id'];

type Refusal = { code: string; constraint: string | null } | null;

describe('Phase 8C PR 8C-5a: journey send attribution (0066)', () => {
  let h: Harness;
  let A: TenantFixture;
  let B: TenantFixture;
  let tokenA: string;
  let tokenB: string;
  let pool: Pool;
  const providers: string[] = [];
  let workspaceA2: string;

  const http = () => request(h.app.getHttpServer());
  const as = <T extends request.Test>(r: T, token = tokenA) =>
    r.set('authorization', `Bearer ${token}`);
  const base = (t: TenantFixture) => `/workspaces/${t.workspaceId}/journeys`;

  const activeJourney = async (name: string, t: TenantFixture, token: string) => {
    const created = await as(http().post(url(base(t))), token)
      .set('idempotency-key', key())
      .send({ name });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const v = created.body.data.draftVersion as { id: string; graphSha256: string };
    const saved = await as(http().put(url(`${base(t)}/${id}/versions/${v.id}/graph`)), token).send({
      graph: {
        schemaVersion: 1,
        entry: 'start',
        nodes: {
          start: { type: 'entry', trigger: { kind: 'api' }, next: 'done' },
          done: { type: 'exit' },
        },
      },
      expectedGraphSha256: v.graphSha256,
    });
    expect(saved.status).toBe(200);
    const pub = await as(http().post(url(`${base(t)}/${id}/versions/${v.id}/publish`)), token)
      .set('idempotency-key', key())
      .send({ expectedGraphSha256: saved.body.data.graphSha256 });
    expect(pub.status).toBe(200);
    expect((await as(http().post(url(`${base(t)}/${id}/activate`)), token)).status).toBe(200);
    return id;
  };
  const enrol = async (journeyId: string, contactId: string, t: TenantFixture, token: string) => {
    const res = await as(http().post(url(`${base(t)}/${journeyId}/enrollments`)), token)
      .set('idempotency-key', key())
      .send({ contactIds: [contactId] });
    expect(res.status).toBe(200);
    return res.body.data.results[0].executionId as string;
  };

  const sendDirect = async (recipient: string, t: TenantFixture = A, token = tokenA) => {
    const res = await as(http().post(url('/messages')), token)
      .set('X-Acc-Organization', t.orgId)
      .set('Idempotency-Key', randomUUID())
      .send({ channelCode: 'whatsapp', recipient, payload: PAYLOAD });
    expect(res.status).toBe(202);
    return res.body.data.id as string;
  };
  const sendJourney = async (journeyId: string, executionId: string, recipient: string) => {
    const res = await as(http().post(url('/test-journey-origin')))
      .set('X-Acc-Organization', A.orgId)
      .send({
        journeyId,
        executionId,
        request: { channelCode: 'whatsapp', recipient, payload: PAYLOAD },
      });
    expect(res.status).toBe(200);
    return res.body as { messageId?: string; refused?: Refusal };
  };

  const row = async (id: string) =>
    (await pool.query(`SELECT to_jsonb(m) AS r FROM messages m WHERE id = $1`, [id])).rows[0]!
      .r as Record<string, unknown>;
  const queuedPayloads = async (id: string) =>
    (
      await pool.query(
        `SELECT payload FROM message_events WHERE message_id = $1 AND event_type = 'message.queued'`,
        [id],
      )
    ).rows.map((r) => r.payload);
  const orgCounts = async (orgId: string) =>
    (
      await pool.query(
        `SELECT (SELECT count(*) FROM messages WHERE org_id = $1)::int AS messages,
                (SELECT count(*) FROM message_dispatch_queue WHERE org_id = $1)::int AS queue,
                (SELECT count(*) FROM message_events WHERE org_id = $1)::int AS events`,
        [orgId],
      )
    ).rows[0];
  const without = (r: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));

  /** Runs `work` in an owner transaction that is always rolled back. */
  const rolledBack = async <T>(work: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      return await work(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  };
  const refusal = (p: Promise<unknown>): Promise<Refusal> =>
    p.then(
      () => null,
      (e: { code?: string; constraint?: string }) => ({
        code: e.code ?? 'none',
        constraint: e.constraint ?? null,
      }),
    );
  /** Inserts a copy of message `from` with `changes` applied (owner, inside `c`'s transaction). */
  const copyMessage = (c: PoolClient, from: string, changes: Record<string, unknown>) =>
    c.query(
      `INSERT INTO messages
         SELECT (jsonb_populate_record(NULL::messages,
                   to_jsonb(m) || jsonb_build_object('id', uuidv7()) || $2::jsonb)).*
           FROM messages m WHERE m.id = $1`,
      [from, JSON.stringify(changes)],
    );
  const insertStep = (
    c: PoolClient,
    executionId: string,
    seq: number,
    messageId: string | null,
    shape: { nodeType?: string; outcome?: string; orgId?: string; workspaceId?: string } = {},
  ) =>
    c.query(
      `INSERT INTO journey_execution_steps (org_id, workspace_id, execution_id, seq, node_key, node_type, outcome, message_id)
       VALUES ($1, $2, $3, $4, 'send', $5, $6, $7)`,
      [
        shape.orgId ?? A.orgId,
        shape.workspaceId ?? A.workspaceId,
        executionId,
        seq,
        shape.nodeType ?? 'send_message',
        shape.outcome ?? 'completed',
        messageId,
      ],
    );

  // Fixture: R1's contact (created by a direct send) enrolled in J1 (E1) and J2 (E2);
  // R2's contact enrolled in J1 (E3); org B has its own journey and execution (EB).
  let m0: string;
  let mB: string;
  let c1: string;
  let c2: string;
  let J1: string;
  let J2: string;
  let E1: string;
  let E2: string;
  let E3: string;
  let JB: string;
  let EB: string;
  let cB: string;

  beforeAll(async () => {
    h = await startHarness({ controllers: [JourneyOriginProbeController] });
    await h.clearRateLimits();
    const credentials = h.app.get(CredentialService);
    A = await createTenant(h.admin, 'j5a-a', credentials);
    B = await createTenant(h.admin, 'j5a-b', credentials);
    const [channel] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'))
      .limit(1);
    const perms = await h.admin
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(
        inArray(schema.permissions.key, [
          PERMISSIONS.JOURNEYS_READ,
          PERMISSIONS.JOURNEYS_MANAGE,
          PERMISSIONS.MESSAGES_SEND,
          PERMISSIONS.MESSAGES_READ,
        ]),
      );
    for (const t of [A, B]) {
      const slug = `j5a-${randomBytes(4).toString('hex')}`;
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
      providers.push(prov!.id);
      await h.admin.insert(schema.organizationProviderAssignments).values({
        orgId: t.orgId,
        channelId: channel!.id,
        providerId: prov!.id,
        priority: 1,
        status: 'active',
      });
      const roleId = uuidv7();
      await h.admin.insert(schema.roles).values({
        id: roleId,
        orgId: t.orgId,
        key: `j5a_${randomBytes(4).toString('hex')}`,
        name: `Journeys 8C-5a ${t.slug}`,
        description: 'Journeys 8C-5a test role',
        isSystemRole: false,
        allowedScopeTypes: ['organization', 'workspace'],
      });
      for (const p of perms)
        await h.admin.insert(schema.rolePermissions).values({ roleId, permissionId: p.id });
      await h.admin.insert(schema.userRoles).values({
        orgId: t.orgId,
        userId: t.userId,
        roleId,
        scopeType: 'organization',
        scopeId: t.orgId,
      });
    }
    workspaceA2 = (
      await h.admin
        .insert(schema.workspaces)
        .values({
          orgId: A.orgId,
          name: 'j5a second',
          slug: `j5a-w2-${randomBytes(4).toString('hex')}`,
        })
        .returning({ id: schema.workspaces.id })
    )[0]!.id;
    const login = async (email: string) =>
      (await http().post(url('/auth/login')).send({ email, password: PASSWORD })).body.data
        .accessToken as string;
    tokenA = await login(A.email);
    tokenB = await login(B.email);
    pool = createPool({
      connectionString: process.env.DATABASE_ADMIN_URL!,
      max: 3,
      applicationName: 'acc-test-8c5a',
    });

    m0 = await sendDirect(R1);
    c1 = (await row(m0)).contact_id as string;
    c2 = (await row(await sendDirect(R2))).contact_id as string;
    mB = await sendDirect(R1, B, tokenB);
    cB = (await row(mB)).contact_id as string;
    J1 = await activeJourney('Attribution J1', A, tokenA);
    J2 = await activeJourney('Attribution J2', A, tokenA);
    JB = await activeJourney('Attribution JB', B, tokenB);
    E1 = await enrol(J1, c1, A, tokenA);
    E2 = await enrol(J2, c1, A, tokenA);
    E3 = await enrol(J1, c2, A, tokenA);
    EB = await enrol(JB, cB, B, tokenB);
  }, 120_000);

  afterAll(async () => {
    if (!h) return;
    try {
      await pool?.end();
      for (const t of [A, B].filter(Boolean)) {
        await purgeMessageEvents(h.admin, eq(schema.messageEvents.orgId, t.orgId));
        await h.admin.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL session_replication_role = replica`);
          for (const table of [
            'journey_execution_steps',
            'journey_execution_queue',
            'message_dispatch_queue',
            'messages',
            'journey_executions',
            'journey_triggers',
            'journey_versions',
            'journeys',
            'contact_identities',
            'contacts',
            'organization_provider_assignments',
          ])
            await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${t.orgId}`);
          if (t === A && workspaceA2)
            await tx.execute(sql`DELETE FROM workspaces WHERE id = ${workspaceA2}`);
        });
        await destroyTenant(h.admin, t);
      }
      for (const id of providers)
        await h.admin.delete(schema.providers).where(eq(schema.providers.id, id));
    } finally {
      await h.close();
    }
  }, 120_000);

  it('enables nothing: the runner is off and the fixture executions stay unclaimed at their exit node', async () => {
    expect(h.app.get(JourneyRunner).isRunning()).toBe(false);
    const { rows } = await pool.query(
      `SELECT e.status, e.current_node_key, e.wait_deadline_at, q.claim_token
         FROM journey_executions e JOIN journey_execution_queue q ON q.execution_id = e.id
        WHERE e.id = ANY($1::uuid[])`,
      [[E1, E2, E3, EB]],
    );
    expect(rows).toHaveLength(4);
    for (const r of rows)
      expect(r).toEqual({
        status: 'running',
        current_node_key: 'done',
        wait_deadline_at: null,
        claim_token: null,
      });
  });

  describe('direct API invariance', () => {
    it('POST /messages sets no attribution; message.queued is exactly {channelCode, recipient}', async () => {
      const r = await row(m0);
      expect(r).toMatchObject({
        journey_id: null,
        journey_execution_id: null,
        campaign_id: null,
        status: 'queued',
        org_id: A.orgId,
        workspace_id: A.workspaceId,
        contact_id: c1,
        recipient_address: R1,
      });
      expect(await queuedPayloads(m0)).toEqual([{ channelCode: 'whatsapp', recipient: R1 }]);
    });
  });

  describe('the core with a journey origin (test-only caller)', () => {
    let m1: string;

    it('sets both columns; every other field and the event payload equal the direct path', async () => {
      const out = await sendJourney(J1, E1, R1);
      expect(out.refused).toBeUndefined();
      m1 = out.messageId!;
      const direct = await row(m0);
      const journey = await row(m1);
      expect(journey).toMatchObject({
        journey_id: J1,
        journey_execution_id: E1,
        campaign_id: null,
      });
      expect(without(journey, [...PER_SUBMISSION, ...ATTRIBUTION])).toEqual(
        without(direct, [...PER_SUBMISSION, ...ATTRIBUTION]),
      );
      expect(await queuedPayloads(m1)).toEqual([{ channelCode: 'whatsapp', recipient: R1 }]);
      const queue = await pool.query(
        `SELECT dispatch_epoch, claim_token FROM message_dispatch_queue WHERE message_id = $1`,
        [m1],
      );
      expect(queue.rows).toEqual([{ dispatch_epoch: 0, claim_token: null }]);
      // The fixture execution is untouched: attribution never advances a journey.
      const e = await pool.query(
        `SELECT status, current_node_key, state_version FROM journey_executions WHERE id = $1`,
        [E1],
      );
      expect(e.rows[0]).toMatchObject({ status: 'running', current_node_key: 'done' });
    });

    it.each([
      ['another contact’s execution', () => [J1, E3, R1]],
      ['another journey than the execution’s', () => [J2, E1, R1]],
      ['a recipient resolving to another contact', () => [J1, E1, R2]],
      ['another organization’s execution', () => [JB, EB, R1]],
    ])('refuses %s by the composite FK, creating nothing', async (_label, args) => {
      const [journeyId, executionId, recipient] = args() as [string, string, string];
      const before = await orgCounts(A.orgId);
      const out = await sendJourney(journeyId, executionId, recipient);
      expect(out).toEqual({
        refused: { code: '23503', constraint: 'messages_journey_execution_fk' },
      });
      expect(await orgCounts(A.orgId)).toEqual(before);
    });

    describe('write-once (every principal, the owner included)', () => {
      it('refuses clearing an attributed message', async () => {
        expect(
          await rolledBack((c) =>
            refusal(
              c.query(
                `UPDATE messages SET journey_id = NULL, journey_execution_id = NULL WHERE id = $1`,
                [m1],
              ),
            ),
          ),
        ).toEqual({ code: '42501', constraint: 'messages_journey_id_immutable' });
      });

      it('refuses re-pointing to another live execution of the same contact', async () => {
        expect(
          await rolledBack((c) =>
            refusal(
              c.query(
                `UPDATE messages SET journey_id = $2, journey_execution_id = $3 WHERE id = $1`,
                [m1, J2, E2],
              ),
            ),
          ),
        ).toEqual({ code: '42501', constraint: 'messages_journey_id_immutable' });
      });

      it('refuses attributing a direct message after insert (NULL -> value)', async () => {
        expect(
          await rolledBack((c) =>
            refusal(
              c.query(
                `UPDATE messages SET journey_id = $2, journey_execution_id = $3 WHERE id = $1`,
                [m0, J1, E1],
              ),
            ),
          ),
        ).toEqual({ code: '42501', constraint: 'messages_journey_id_immutable' });
      });

      it('leaves every other mutable column writable on an attributed message', async () => {
        expect(
          await rolledBack((c) =>
            refusal(c.query(`UPDATE messages SET failure_reason = 'x' WHERE id = $1`, [m1])),
          ),
        ).toBeNull();
      });
    });

    describe('steps: message FK, shape CHECK, step <-> message trigger, uniqueness', () => {
      it('accepts a completed send_message step naming its own execution’s message', async () => {
        expect(await rolledBack((c) => refusal(insertStep(c, E1, 900, m1)))).toBeNull();
      });

      it('refuses a direct (unattributed) message', async () => {
        expect(await rolledBack((c) => refusal(insertStep(c, E1, 900, m0)))).toEqual({
          code: '23514',
          constraint: 'journey_execution_steps_message_execution',
        });
      });

      it('refuses another execution’s message (same organization)', async () => {
        expect(await rolledBack((c) => refusal(insertStep(c, E3, 900, m1)))).toEqual({
          code: '23514',
          constraint: 'journey_execution_steps_message_execution',
        });
      });

      it('refuses a message that does not exist, or exists only in another organization', async () => {
        expect(await rolledBack((c) => refusal(insertStep(c, E1, 900, uuidv7())))).toEqual({
          code: '23503',
          constraint: 'journey_execution_steps_message_fk',
        });
        expect(await rolledBack((c) => refusal(insertStep(c, E1, 900, mB)))).toEqual({
          code: '23503',
          constraint: 'journey_execution_steps_message_fk',
        });
      });

      it.each([
        ['another node type', { nodeType: 'update_contact' }],
        ['a non-completed outcome', { outcome: 'failed' }],
      ])('refuses a message on %s', async (_label, shape) => {
        expect(await rolledBack((c) => refusal(insertStep(c, E1, 900, m1, shape)))).toEqual({
          code: '23514',
          constraint: 'journey_execution_steps_message_shape',
        });
      });

      it('fails closed (N1, 0067): a message the guard cannot read is refused, whichever execution it names', async () => {
        // The guard's owner is made unable to read messages (acc_app without a tenant context
        // sees none), while the foreign key — which checks without row security — still finds
        // the row. Before 0067 the guard let both steps through; now each is refused.
        for (const [execution, message] of [
          [E1, m1],
          [E3, m1],
        ])
          expect(
            await rolledBack(async (c) => {
              await c.query('ALTER FUNCTION app_journey_step_message_guard() OWNER TO acc_app');
              return refusal(insertStep(c, execution!, 900, message!));
            }),
          ).toEqual({ code: '23503', constraint: 'journey_execution_steps_message_fk' });
        // Control: with its owner restored (the rollback), the step's own message is accepted.
        expect(await rolledBack((c) => refusal(insertStep(c, E1, 900, m1)))).toBeNull();
      });

      it('refuses a second step naming the same message', async () => {
        expect(
          await rolledBack(async (c) => {
            await insertStep(c, E1, 900, m1);
            return refusal(insertStep(c, E1, 901, m1));
          }),
        ).toEqual({ code: '23505', constraint: 'uq_journey_execution_steps_message' });
      });

      it('leaves steps without a message unchanged', async () => {
        expect(
          await rolledBack((c) =>
            refusal(
              insertStep(c, E1, 900, null, { nodeType: 'update_contact', outcome: 'failed' }),
            ),
          ),
        ).toBeNull();
      });
    });
  });

  describe('database rules on messages (owner inserts; rolled back)', () => {
    it('shape: both attribution columns or neither', async () => {
      for (const changes of [{ journey_id: null }, { journey_execution_id: null }].map((x) => ({
        journey_id: J1,
        journey_execution_id: E1,
        ...x,
      })))
        expect(await rolledBack((c) => refusal(copyMessage(c, m0, changes)))).toEqual({
          code: '23514',
          constraint: 'messages_journey_shape',
        });
    });

    it('a consistent copy is accepted (control for the refusals below)', async () => {
      expect(
        await rolledBack((c) =>
          refusal(copyMessage(c, m0, { journey_id: J1, journey_execution_id: E1 })),
        ),
      ).toBeNull();
    });

    it('the composite FK refuses another workspace of the same organization', async () => {
      expect(
        await rolledBack(async (c) => {
          const { rows } = await c.query(
            `INSERT INTO contacts (org_id, workspace_id, first_name) VALUES ($1, $2, 'w2') RETURNING id`,
            [A.orgId, workspaceA2],
          );
          return refusal(
            copyMessage(c, m0, {
              workspace_id: workspaceA2,
              contact_id: rows[0].id,
              journey_id: J1,
              journey_execution_id: E1,
            }),
          );
        }),
      ).toEqual({ code: '23503', constraint: 'messages_journey_execution_fk' });
    });

    it('the composite FK refuses another contact, journey and organization', async () => {
      for (const changes of [
        { contact_id: c2, journey_id: J1, journey_execution_id: E1 },
        { journey_id: J2, journey_execution_id: E1 },
        {
          org_id: B.orgId,
          workspace_id: B.workspaceId,
          contact_id: cB,
          journey_id: J1,
          journey_execution_id: E1,
        },
      ])
        expect(await rolledBack((c) => refusal(copyMessage(c, m0, changes)))).toEqual({
          code: '23503',
          constraint: 'messages_journey_execution_fk',
        });
    });
  });

  describe('journey_executions.wait_deadline_at (column and invariant only; behaviour is 8C-5b)', () => {
    it('refuses a deadline on a non-waiting execution', async () => {
      expect(
        await rolledBack((c) =>
          refusal(
            c.query(
              `UPDATE journey_executions SET wait_deadline_at = now() + interval '1 hour' WHERE id = $1`,
              [E1],
            ),
          ),
        ),
      ).toEqual({ code: '23514', constraint: 'journey_executions_wait_deadline_shape' });
    });

    it('accepts a deadline while waiting, and refuses ending with it still set', async () => {
      expect(
        await rolledBack(async (c) => {
          await c.query(
            `UPDATE journey_executions SET status = 'waiting', wait_deadline_at = now() + interval '1 hour' WHERE id = $1`,
            [E1],
          );
          return refusal(
            c.query(`UPDATE journey_executions SET status = 'running' WHERE id = $1`, [E1]),
          );
        }),
      ).toEqual({ code: '23514', constraint: 'journey_executions_wait_deadline_shape' });
    });
  });
});
