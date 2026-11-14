/**
 * Phase 8C PR 8C-5b — the journey send node, `wait_for_outcome` and `send_outcome`, and the
 * `wait_deadline_at` lifecycle (handover Rev 2 §§3.1D, 6, 7, 8). Disposable clones only
 * (`scripts/with-db-clone.mjs`).
 *
 * The runner runs as `acc_journey` through `SET ROLE` on an owner pool, exactly as in
 * journeys-runner.int-spec.ts. Send-node journeys cannot be activated (`JOURNEY_SEND_DISABLED`,
 * unchanged), so they are published through the API and activated by the owner, as the 8C-3
 * suite does.
 *
 * **No journey sends.** The production binding of the send port is `UnavailableJourneySendPort`.
 * The other tests inject a test-only `ScriptedPort`, constructed only here, which never touches
 * the submission core: a "sent" result names a message the owner planted beforehand,
 * attributed to the execution (the 0066 FK binds it), so the step <-> message rules apply as
 * they will to a real send. Delivery outcomes are planted the same way.
 */
import {
  JOURNEY_RUNNER_ERROR_CODES,
  JOURNEY_RUNNER_LIMITS,
  PERMISSIONS,
  type JourneyGraph,
} from '@acc/contracts';
import { createDatabase, createPool, schema, type Transaction } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
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
import { AuditWriter } from '../src/audit/audit-writer.service';
import { CredentialService } from '../src/iam/credential.service';
import { JourneyRunnerService } from '../src/journeys/runner/journey-runner.service';
import { JourneyRunner } from '../src/journeys/runner/journey-runner.worker';
import {
  JOURNEY_SEND_PORT,
  UnavailableJourneySendPort,
  type JourneySendInput,
  type JourneySendPort,
  type JourneySendResult,
} from '../src/journeys/runner/journey-send.port';

jest.setTimeout(60_000);

const url = (p: string) => `/${PREFIX}${p}`;
const key = () => `journey-8c5b-${uuidv7()}`;

/** TEST ONLY: returns a scripted result per execution; never writes. */
class ScriptedPort implements JourneySendPort {
  readonly results = new Map<string, JourneySendResult>();
  readonly calls: JourneySendInput[] = [];
  async send(_tx: Transaction, input: JourneySendInput): Promise<JourneySendResult> {
    this.calls.push(input);
    return this.results.get(input.executionId) ?? { kind: 'unavailable' };
  }
}

type Edge = 'continue' | 'exit';

describe('Phase 8C PR 8C-5b: journey send node and outcome waits', () => {
  let h: Harness;
  let A: TenantFixture;
  let B: TenantFixture;
  let tokenA: string;
  let runnerPool: Pool;
  let waChannel: string;
  let template: string;
  const port = new ScriptedPort();
  const runners: JourneyRunnerService[] = [];
  let addressSeq = 0;

  const http = () => request(h.app.getHttpServer());
  const as = <T extends request.Test>(r: T) => r.set('authorization', `Bearer ${tokenA}`);
  const base = () => `/workspaces/${A.workspaceId}/journeys`;

  const makeRunner = (workerId: string, sendPort?: JourneySendPort, lockTimeoutMs = 300) => {
    const r = new JourneyRunnerService(
      createDatabase(runnerPool),
      h.app.get(AuditWriter),
      undefined,
      { workerId, lockTimeoutMs, leaseSeconds: 30, batchSize: 20, perOrgLimit: 20 },
      sendPort,
    );
    runners.push(r);
    return r;
  };
  const drain = async (runner: JourneyRunnerService, max = 20) => {
    for (let i = 0; i < max; i++) if ((await runner.tick()).length === 0) break;
  };

  // --- fixtures -------------------------------------------------------------------------------

  const sendNode = (onSuppressed: Edge, onRefused: Edge, next: string) => ({
    type: 'send_message' as const,
    channel: 'whatsapp' as const,
    templateId: template,
    variables: { name: { source: 'contact_field' as const, field: 'firstName' } },
    onSuppressed,
    onRefused,
    next,
  });
  const sendGraph = (onSuppressed: Edge, onRefused: Edge): JourneyGraph => ({
    schemaVersion: 1,
    entry: 'start',
    nodes: {
      start: { type: 'entry', trigger: { kind: 'api' }, next: 'send' },
      send: sendNode(onSuppressed, onRefused, 'done'),
      done: { type: 'exit' },
    },
  });
  const waitGraph = (outcome: 'delivered' | 'read', onSuppressed: Edge = 'exit'): JourneyGraph => ({
    schemaVersion: 1,
    entry: 'start',
    nodes: {
      start: { type: 'entry', trigger: { kind: 'api' }, next: 'send' },
      send: sendNode(onSuppressed, 'exit', 'wfo'),
      wfo: {
        type: 'wait_for_outcome',
        sendNodeKey: 'send',
        outcome,
        timeoutSeconds: 3600,
        onOutcome: 'yes',
        onTimeout: 'no',
      },
      yes: { type: 'exit', reason: 'got_outcome' },
      no: { type: 'exit', reason: 'timed_out' },
    },
  });
  const conditionGraph = (outcome: 'delivered' | 'read' | 'failed'): JourneyGraph => ({
    schemaVersion: 1,
    entry: 'start',
    nodes: {
      start: { type: 'entry', trigger: { kind: 'api' }, next: 'send' },
      send: sendNode('continue', 'exit', 'cond'),
      cond: {
        type: 'condition',
        rule: { kind: 'send_outcome', sendNodeKey: 'send', outcome },
        onTrue: 'yes',
        onFalse: 'no',
      },
      yes: { type: 'exit', reason: 'outcome_true' },
      no: { type: 'exit', reason: 'outcome_false' },
    },
  });

  /** Published through the API; activated by the owner (the API refuses send-node versions). */
  const plantedJourney = async (name: string, graph: JourneyGraph) => {
    const created = await as(http().post(url(base())))
      .set('idempotency-key', key())
      .send({ name });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const v = created.body.data.draftVersion as { id: string; graphSha256: string };
    const saved = await as(http().put(url(`${base()}/${id}/versions/${v.id}/graph`))).send({
      graph,
      expectedGraphSha256: v.graphSha256,
    });
    expect(saved.status).toBe(200);
    const pub = await as(http().post(url(`${base()}/${id}/versions/${v.id}/publish`)))
      .set('idempotency-key', key())
      .send({ expectedGraphSha256: saved.body.data.graphSha256 });
    expect([pub.status, pub.status === 200 ? null : pub.body]).toEqual([200, null]);
    expect((await as(http().post(url(`${base()}/${id}/activate`)))).status).toBe(400);
    await h.admin.execute(
      sql`UPDATE journeys SET status = 'active', active_version_id = ${v.id}, activated_at = now() WHERE id = ${id}`,
    );
    return { id, versionId: v.id };
  };

  const contact = async (firstName: string, identity = true, t: TenantFixture = A) => {
    const [c] = await h.admin
      .insert(schema.contacts)
      .values({ orgId: t.orgId, workspaceId: t.workspaceId, firstName })
      .returning({ id: schema.contacts.id });
    let address: string | null = null;
    if (identity) {
      address = `+120255${String(60000 + ++addressSeq).padStart(5, '0')}`;
      await h.admin.insert(schema.contactIdentities).values({
        orgId: t.orgId,
        workspaceId: t.workspaceId,
        contactId: c!.id,
        channelId: waChannel,
        rawAddress: address,
        normalizedAddress: address,
        isPrimary: true,
      });
    }
    return { id: c!.id, address };
  };

  /** An execution positioned at `node` (as after the entry step), due now. */
  const plantExecution = async (
    journey: { id: string; versionId: string },
    contactId: string,
    node = 'send',
    t: TenantFixture = A,
  ) => {
    const [exec] = (
      await h.admin.execute<{ id: string }>(
        sql`INSERT INTO journey_executions (org_id, workspace_id, journey_id, journey_version_id, contact_id, current_node_key, state_version, transitions, entry_kind, entry_ref)
            VALUES (${t.orgId}, ${t.workspaceId}, ${journey.id}, ${journey.versionId}, ${contactId}, ${node}, 1, 1, 'api', ${`planted:${uuidv7()}`}) RETURNING id`,
      )
    ).rows;
    await h.admin.execute(
      sql`INSERT INTO journey_execution_queue (execution_id, org_id) VALUES (${exec!.id}, ${t.orgId})`,
    );
    return exec!.id;
  };

  /** A queued message attributed to the execution (what a real send would have created). */
  const plantMessage = async (
    executionId: string,
    journeyId: string,
    contactId: string,
    address: string,
    t: TenantFixture = A,
  ) =>
    (
      await h.admin
        .insert(schema.messages)
        .values({
          orgId: t.orgId,
          workspaceId: t.workspaceId,
          contactId,
          channelId: waChannel,
          recipientAddress: address,
          payload: {},
          status: 'queued',
          correlationId: 'test-8c5b',
          journeyId,
          journeyExecutionId: executionId,
        })
        .returning({ id: schema.messages.id })
    )[0]!.id;

  /**
   * Plants a delivery outcome (as settlement/ingestion would), bypassing their role guards but
   * keeping the 0044 CHECKs: `delivered` sets `delivered_at`; `read` implies delivered.
   */
  const setOutcome = async (
    messageId: string,
    o: { status?: string; deliveryStatus?: string | null; readAt?: boolean },
  ) => {
    await h.admin.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      if (o.status)
        await tx.execute(
          sql`UPDATE messages SET status = ${o.status}::message_status WHERE id = ${messageId}`,
        );
      const delivery = o.readAt ? 'delivered' : o.deliveryStatus;
      if (delivery !== undefined)
        await tx.execute(
          sql`UPDATE messages SET delivery_status = ${delivery}::message_delivery_status,
                                  delivered_at = CASE WHEN ${delivery} = 'delivered' THEN now() END
               WHERE id = ${messageId}`,
        );
      if (o.readAt)
        await tx.execute(sql`UPDATE messages SET read_at = now() WHERE id = ${messageId}`);
    });
  };

  const execution = async (id: string) =>
    (
      await h.admin.execute<{
        status: string;
        current_node_key: string | null;
        state_version: number;
        transitions: number;
        end_reason: string | null;
        wake_at: Date | null;
        wait_deadline_at: Date | null;
      }>(
        sql`SELECT status, current_node_key, state_version, transitions, end_reason, wake_at, wait_deadline_at FROM journey_executions WHERE id = ${id}`,
      )
    ).rows[0]!;
  const steps = async (id: string) =>
    (
      await h.admin.execute<{
        seq: number;
        node_key: string;
        outcome: string;
        error_code: string | null;
        message_id: string | null;
        details: Record<string, unknown>;
      }>(
        sql`SELECT seq, node_key, outcome, error_code, message_id, details FROM journey_execution_steps WHERE execution_id = ${id} ORDER BY seq`,
      )
    ).rows;
  const queueRow = async (id: string) =>
    (
      await h.admin.execute<{ attempts: number; claim_token: string | null; available_at: Date }>(
        sql`SELECT attempts, claim_token, available_at FROM journey_execution_queue WHERE execution_id = ${id}`,
      )
    ).rows[0];
  const makeDue = async (id: string) => {
    await h.admin.execute(
      sql`UPDATE journey_executions SET wake_at = now() - interval '1 second' WHERE id = ${id} AND status = 'waiting'`,
    );
    await h.admin.execute(
      sql`UPDATE journey_execution_queue SET available_at = now() - interval '1 second' WHERE execution_id = ${id}`,
    );
  };
  const orgMessages = async () =>
    Number(
      (
        await h.admin.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM messages WHERE org_id IN (${A.orgId}, ${B.orgId})`,
        )
      ).rows[0]!.n,
    );

  /** An execution sent through the scripted port and armed at `wfo`. */
  const armedWait = async (journey: { id: string; versionId: string }, label: string) => {
    const c = await contact(label);
    const id = await plantExecution(journey, c.id);
    const messageId = await plantMessage(id, journey.id, c.id, c.address!);
    port.results.set(id, { kind: 'sent', messageId });
    await drain(makeRunner(`w-arm-${label}`, port));
    const e = await execution(id);
    expect(e).toMatchObject({ status: 'waiting', current_node_key: 'wfo' });
    expect(e.wait_deadline_at).not.toBeNull();
    return { id, messageId, contactId: c.id };
  };

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
  /** Gives the execution's queue row a live claim (as app_journey_claim would). */
  const liveClaim = async (executionId: string, live = true) => {
    const token = uuidv7();
    await h.admin.execute(
      sql`UPDATE journey_execution_queue SET claim_token = ${token}, claimed_by = 'test', claimed_until = now() + ${live ? sql`interval '1 minute'` : sql`- interval '1 minute'`} WHERE execution_id = ${executionId}`,
    );
    return token;
  };
  const refusalCode = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string }) => e.code ?? 'none',
    );

  let sendCont: { id: string; versionId: string };
  let sendExit: { id: string; versionId: string };
  let waitDelivered: { id: string; versionId: string };
  let waitRead: { id: string; versionId: string };
  let waitSuppressedContinue: { id: string; versionId: string };

  beforeAll(async () => {
    h = await startHarness();
    await h.clearRateLimits();
    const credentials = h.app.get(CredentialService);
    A = await createTenant(h.admin, 'j5b-a', credentials);
    B = await createTenant(h.admin, 'j5b-b', credentials);
    const roleId = uuidv7();
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: A.orgId,
      key: `j5b_all_${A.slug.replace(/-/g, '_')}`,
      name: `Journeys 8C-5b ${A.slug}`,
      description: 'Journeys 8C-5b test role',
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
      orgId: A.orgId,
      userId: A.userId,
      roleId,
      scopeType: 'organization',
      scopeId: A.orgId,
    });
    waChannel = (
      await h.admin
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(eq(schema.channels.code, 'whatsapp'))
    )[0]!.id;
    template = (
      await h.admin
        .insert(schema.templates)
        .values({
          orgId: A.orgId,
          channelId: waChannel,
          name: `t-${uuidv7()}`,
          body: 'Hello {{name}}',
          variables: [],
          approvalStatus: 'approved',
        })
        .returning({ id: schema.templates.id })
    )[0]!.id;
    tokenA = (await http().post(url('/auth/login')).send({ email: A.email, password: PASSWORD }))
      .body.data.accessToken as string;
    runnerPool = createPool({
      connectionString: process.env.DATABASE_ADMIN_URL!,
      max: 6,
      applicationName: 'acc-test-journey-send',
    });
    runnerPool.on('connect', (client) => {
      void client.query('SET ROLE acc_journey');
    });
    sendCont = await plantedJourney('Send continue', sendGraph('continue', 'continue'));
    sendExit = await plantedJourney('Send exit', sendGraph('exit', 'exit'));
    waitDelivered = await plantedJourney('Wait delivered', waitGraph('delivered'));
    waitRead = await plantedJourney('Wait read', waitGraph('read'));
    waitSuppressedContinue = await plantedJourney(
      'Wait without message',
      waitGraph('delivered', 'continue'),
    );
  }, 120_000);

  afterAll(async () => {
    if (!h) return;
    try {
      await runnerPool?.end();
      for (const t of [A, B].filter(Boolean)) {
        await purgeMessageEvents(h.admin, eq(schema.messageEvents.orgId, t.orgId));
        await h.admin.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL session_replication_role = replica`);
          for (const table of [
            'journey_execution_steps',
            'journey_execution_queue',
            'messages',
            'journey_executions',
            'journey_triggers',
            'journey_versions',
            'journeys',
            'templates',
          ])
            await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${t.orgId}`);
        });
        await destroyTenant(h.admin, t);
      }
    } finally {
      await h.close();
    }
  }, 120_000);

  // --- production binding -----------------------------------------------------------------------

  describe('production binding: no journey can send', () => {
    it('binds the port to UnavailableJourneySendPort; the runner stays off', () => {
      expect(h.app.get(JOURNEY_SEND_PORT)).toBeInstanceOf(UnavailableJourneySendPort);
      expect(h.app.get(JourneyRunner).isRunning()).toBe(false);
      expect(h.app.get(JourneyRunnerService).available).toBe(false);
    });

    it('a send node fails SEND_UNAVAILABLE (node_failed); no message is created', async () => {
      const before = await orgMessages();
      const c = await contact('prod');
      const id = await plantExecution(sendCont, c.id);
      await drain(makeRunner('w-prod')); // no port given: the fail-closed default
      expect(await execution(id)).toMatchObject({ status: 'failed', end_reason: 'node_failed' });
      expect(await steps(id)).toEqual([
        expect.objectContaining({
          seq: 2,
          node_key: 'send',
          outcome: 'failed',
          error_code: JOURNEY_RUNNER_ERROR_CODES.SEND_UNAVAILABLE,
          message_id: null,
        }),
      ]);
      expect(await orgMessages()).toBe(before);
    });
  });

  // --- send node with a test-only port ----------------------------------------------------------

  describe('send node (test-only scripted port)', () => {
    it('sent: the step records the message; the port saw the identity, template and resolved variables', async () => {
      const c = await contact('Asha');
      const id = await plantExecution(sendCont, c.id);
      const messageId = await plantMessage(id, sendCont.id, c.id, c.address!);
      port.results.set(id, { kind: 'sent', messageId });
      await drain(makeRunner('w-sent', port));
      expect(await execution(id)).toMatchObject({ status: 'completed', end_reason: 'exit_node' });
      expect((await steps(id)).map((s) => [s.node_key, s.outcome, s.message_id])).toEqual([
        ['send', 'completed', messageId],
        ['done', 'exited', null],
      ]);
      expect(port.calls.find((call) => call.executionId === id)).toEqual({
        orgId: A.orgId,
        workspaceId: A.workspaceId,
        journeyId: sendCont.id,
        executionId: id,
        contactId: c.id,
        nodeKey: 'send',
        channel: 'whatsapp',
        templateId: template,
        recipient: c.address,
        variables: { name: 'Asha' },
      });
    });

    it('a "sent" message attributed to another execution is refused by the step guard; nothing commits', async () => {
      const c1 = await contact('other1');
      const c2 = await contact('other2');
      const owner = await plantExecution(sendCont, c1.id);
      const foreign = await plantMessage(owner, sendCont.id, c1.id, c1.address!);
      port.results.set(owner, { kind: 'sent', messageId: foreign });
      const id = await plantExecution(sendCont, c2.id);
      port.results.set(id, { kind: 'sent', messageId: foreign });
      const runner = makeRunner('w-foreign', port);
      const results = await runner.tick();
      expect(results).toEqual(
        expect.arrayContaining([
          { executionId: owner, outcome: 'ended', transitions: 2 },
          {
            executionId: id,
            outcome: 'retry',
            transitions: 0,
            errorCode: expect.stringMatching(/^(23514|23505)$/),
          },
        ]),
      );
      expect(await execution(id)).toMatchObject({
        status: 'running',
        current_node_key: 'send',
        state_version: 1,
      });
      expect(await steps(id)).toEqual([]);
      // Tidy: the production port ends it.
      port.results.set(id, { kind: 'unavailable' });
      await makeDue(id);
      await drain(runner);
      expect(await execution(id)).toMatchObject({ status: 'failed' });
    });

    it.each([
      ['RECIPIENT_SUPPRESSED', 'continue', 'skipped', 'completed', 'exit_node'],
      ['CONSENT_REVOKED', 'exit', 'skipped', 'exited', 'send_suppressed'],
      ['BILLING_INSUFFICIENT_FUNDS', 'exit', 'refused', 'exited', 'send_refused'],
      ['NO_ACTIVE_PROVIDER_ASSIGNMENT', 'continue', 'refused', 'completed', 'exit_node'],
      ['BILLING_ACCOUNT_FROZEN', 'continue', 'refused', 'completed', 'exit_node'],
      ['TEMPLATE_NOT_APPROVED', 'continue', 'failed', 'failed', 'node_failed'],
      ['SMS_PAYLOAD_INVALID', 'exit', 'failed', 'failed', 'node_failed'],
    ])(
      'refused %s (edges %s): step %s, execution %s (%s)',
      async (code, edges, stepOutcome, status, endReason) => {
        const before = await orgMessages();
        const c = await contact(`r-${code}`);
        const id = await plantExecution(edges === 'exit' ? sendExit : sendCont, c.id);
        port.results.set(id, { kind: 'refused', code });
        await drain(makeRunner(`w-${code}`, port));
        expect(await execution(id)).toMatchObject({ status, end_reason: endReason });
        expect((await steps(id))[0]).toMatchObject({
          node_key: 'send',
          outcome: stepOutcome,
          error_code: `SEND_REFUSED_${code}`,
          message_id: null,
        });
        expect(await orgMessages()).toBe(before);
      },
    );

    it('BILLING_BUSY and a transient SQLSTATE record nothing and retry (transient bound)', async () => {
      for (const code of ['BILLING_BUSY', '40001']) {
        const c = await contact(`busy-${code}`);
        const id = await plantExecution(sendCont, c.id);
        port.results.set(id, { kind: 'refused', code });
        expect(await makeRunner(`w-busy-${code}`, port).tick()).toEqual(
          expect.arrayContaining([
            { executionId: id, outcome: 'retry', transitions: 0, errorCode: code },
          ]),
        );
        expect(await steps(id)).toEqual([]);
        expect(await queueRow(id)).toMatchObject({ attempts: 1, claim_token: null });
        port.results.set(id, { kind: 'unavailable' });
        await makeDue(id);
        await drain(makeRunner(`w-busy-end-${code}`, port));
      }
    });

    it('an unmapped refusal is retried and then fails as poison (RUNNER_POISONED)', async () => {
      const c = await contact('mystery');
      const id = await plantExecution(sendCont, c.id);
      port.results.set(id, { kind: 'refused', code: 'MYSTERY_REFUSAL' });
      expect(await makeRunner('w-mystery', port).tick()).toEqual(
        expect.arrayContaining([
          {
            executionId: id,
            outcome: 'retry',
            transitions: 0,
            errorCode: 'SEND_REFUSED_MYSTERY_REFUSAL',
          },
        ]),
      );
      await h.admin.execute(
        sql`UPDATE journey_execution_queue SET attempts = ${JOURNEY_RUNNER_LIMITS.poisonClaims - 1}, available_at = now() WHERE execution_id = ${id}`,
      );
      await drain(makeRunner('w-mystery-2', port));
      expect(await execution(id)).toMatchObject({
        status: 'failed',
        end_reason: 'runner_poisoned',
      });
    });

    it.each([
      ['continue', 'completed', 'exit_node'],
      ['exit', 'exited', 'send_suppressed'],
    ])(
      'no active identity (onSuppressed %s): step skipped NO_IDENTITY; the port is not called',
      async (edge, status, endReason) => {
        const c = await contact(`noid-${edge}`, false);
        const id = await plantExecution(edge === 'exit' ? sendExit : sendCont, c.id);
        port.results.set(id, { kind: 'unavailable' });
        await drain(makeRunner(`w-noid-${edge}`, port));
        expect(await execution(id)).toMatchObject({ status, end_reason: endReason });
        expect((await steps(id))[0]).toMatchObject({
          outcome: 'skipped',
          error_code: JOURNEY_RUNNER_ERROR_CODES.NO_IDENTITY,
        });
        expect(port.calls.some((call) => call.executionId === id)).toBe(false);
      },
    );
  });

  // --- wait_for_outcome -------------------------------------------------------------------------

  describe('wait_for_outcome (J-B2) over planted attributed messages', () => {
    const wfoRows = async (id: string) => (await steps(id)).filter((s) => s.node_key === 'wfo');

    it('arms on the first visit: waiting, a persisted deadline, the first re-check within it, one history row', async () => {
      const w = await armedWait(waitDelivered, 'arm');
      const e = await execution(w.id);
      const deadline = new Date(e.wait_deadline_at!).getTime();
      const wake = new Date(e.wake_at!).getTime();
      expect(deadline - Date.now()).toBeGreaterThan(3500_000);
      expect(deadline - Date.now()).toBeLessThanOrEqual(3600_000);
      expect(wake).toBeLessThanOrEqual(deadline);
      expect(wake - Date.now()).toBeGreaterThan(200_000);
      expect(wake - Date.now()).toBeLessThanOrEqual(300_000);
      expect(new Date((await queueRow(w.id))!.available_at).getTime()).toBe(wake);
      expect(await wfoRows(w.id)).toEqual([
        expect.objectContaining({
          outcome: 'waited',
          details: { deadline: new Date(deadline).toISOString() },
        }),
      ]);
    });

    it.each([
      ['delivered', { deliveryStatus: 'delivered' }],
      ['read', { readAt: true }],
    ] as const)(
      '%s takes onOutcome and clears the deadline (two history rows)',
      async (outcome, plant) => {
        const w = await armedWait(outcome === 'read' ? waitRead : waitDelivered, `o-${outcome}`);
        await setOutcome(w.messageId, plant);
        await makeDue(w.id);
        await drain(makeRunner(`w-o-${outcome}`, port));
        expect(await execution(w.id)).toMatchObject({
          status: 'completed',
          end_reason: 'got_outcome',
          wait_deadline_at: null,
        });
        expect((await wfoRows(w.id)).map((s) => [s.outcome, s.details])).toEqual([
          ['waited', expect.any(Object)],
          ['completed', { outcome }],
        ]);
      },
    );

    it.each([
      ['status failed', { status: 'failed' }],
      ['delivery undelivered', { deliveryStatus: 'undelivered' }],
    ] as const)(
      'a failed message (%s) can never be delivered: onTimeout at once',
      async (_l, plant) => {
        const w = await armedWait(waitDelivered, `f-${_l}`);
        await setOutcome(w.messageId, plant);
        await makeDue(w.id);
        await drain(makeRunner('w-failed', port));
        expect(await execution(w.id)).toMatchObject({
          end_reason: 'timed_out',
          wait_deadline_at: null,
        });
        expect((await wfoRows(w.id)).at(-1)!.details).toEqual({ timedOut: true, failed: true });
      },
    );

    it.each([
      ['outcome_unknown', { status: 'outcome_unknown' }],
      ['pending', { deliveryStatus: 'pending' }],
      ['not_supported', { deliveryStatus: 'not_supported' }],
      ['no delivery status', {}],
    ] as const)(
      '%s is not an outcome: silent re-arms, then onTimeout at the deadline',
      async (label, plant) => {
        const w = await armedWait(waitDelivered, `u-${label}`);
        await setOutcome(w.messageId, plant);
        const armed = await execution(w.id);
        const history = await steps(w.id);
        for (let i = 0; i < 2; i++) {
          await makeDue(w.id);
          expect(await makeRunner(`w-rearm-${label}-${i}`, port).tick()).toEqual(
            expect.arrayContaining([{ executionId: w.id, outcome: 'waiting', transitions: 0 }]),
          );
          const now = await execution(w.id);
          expect(now).toMatchObject({
            status: 'waiting',
            state_version: armed.state_version,
            transitions: armed.transitions,
          });
          expect(new Date(now.wait_deadline_at!).getTime()).toBe(
            new Date(armed.wait_deadline_at!).getTime(),
          );
          expect(new Date(now.wake_at!).getTime()).toBeGreaterThan(Date.now());
          expect(new Date(now.wake_at!).getTime()).toBeLessThanOrEqual(
            new Date(armed.wait_deadline_at!).getTime(),
          );
          expect(await steps(w.id)).toEqual(history);
        }
        await h.admin.execute(
          sql`UPDATE journey_executions SET wait_deadline_at = now() - interval '1 second' WHERE id = ${w.id}`,
        );
        await makeDue(w.id);
        await drain(makeRunner(`w-timeout-${label}`, port));
        expect(await execution(w.id)).toMatchObject({
          end_reason: 'timed_out',
          wait_deadline_at: null,
        });
        expect((await wfoRows(w.id)).map((s) => [s.outcome, s.details])).toEqual([
          ['waited', expect.any(Object)],
          ['completed', { timedOut: true }],
        ]);
      },
    );

    it('an outcome already reached on the first visit takes onOutcome without arming', async () => {
      const c = await contact('early');
      const id = await plantExecution(waitDelivered, c.id);
      const messageId = await plantMessage(id, waitDelivered.id, c.id, c.address!);
      await setOutcome(messageId, { deliveryStatus: 'delivered' });
      port.results.set(id, { kind: 'sent', messageId });
      await drain(makeRunner('w-early', port));
      expect(await execution(id)).toMatchObject({
        end_reason: 'got_outcome',
        wait_deadline_at: null,
      });
      expect((await wfoRows(id)).map((s) => s.outcome)).toEqual(['completed']);
    });

    it('no message from the send node: onTimeout at once', async () => {
      const c = await contact('nomsg');
      const id = await plantExecution(waitSuppressedContinue, c.id);
      port.results.set(id, { kind: 'refused', code: 'RECIPIENT_SUPPRESSED' });
      await drain(makeRunner('w-nomsg', port));
      expect(await execution(id)).toMatchObject({
        end_reason: 'timed_out',
        wait_deadline_at: null,
      });
      expect((await wfoRows(id)).map((s) => [s.outcome, s.details])).toEqual([
        ['completed', { timedOut: true, message: false }],
      ]);
    });
  });

  // --- send_outcome -----------------------------------------------------------------------------

  describe('send_outcome condition', () => {
    const journeys = new Map<string, { id: string; versionId: string }>();
    const run = async (
      outcome: 'delivered' | 'read' | 'failed',
      plant: { status?: string; deliveryStatus?: string; readAt?: boolean } | 'no message',
    ) => {
      if (!journeys.has(outcome))
        journeys.set(outcome, await plantedJourney(`Cond ${outcome}`, conditionGraph(outcome)));
      const j = journeys.get(outcome)!;
      const c = await contact(`cond-${outcome}`);
      const id = await plantExecution(j, c.id);
      if (plant === 'no message')
        port.results.set(id, { kind: 'refused', code: 'CONSENT_REVOKED' });
      else {
        const messageId = await plantMessage(id, j.id, c.id, c.address!);
        await setOutcome(messageId, plant);
        port.results.set(id, { kind: 'sent', messageId });
      }
      await drain(makeRunner(`w-cond-${outcome}`, port));
      return (await execution(id)).end_reason;
    };

    it.each([
      ['delivered', { deliveryStatus: 'delivered' }, 'outcome_true'],
      ['delivered', { deliveryStatus: 'pending' }, 'outcome_false'],
      ['delivered', { status: 'outcome_unknown' }, 'outcome_false'],
      ['read', { readAt: true }, 'outcome_true'],
      ['read', { deliveryStatus: 'delivered' }, 'outcome_false'],
      ['failed', { status: 'failed' }, 'outcome_true'],
      ['failed', { deliveryStatus: 'undelivered' }, 'outcome_true'],
      ['failed', { status: 'outcome_unknown' }, 'outcome_false'],
      ['delivered', 'no message', 'outcome_false'],
      ['failed', 'no message', 'outcome_false'],
    ] as const)('%s with %j → %s', async (outcome, plant, expected) => {
      expect(await run(outcome, plant)).toBe(expected);
    });
  });

  // --- the deadline lifecycle -------------------------------------------------------------------

  describe('wait_deadline_at lifecycle: cleared by every end path', () => {
    it('operator cancel', async () => {
      const w = await armedWait(waitDelivered, 'cancel');
      const res = await as(
        http().post(url(`${base()}/${waitDelivered.id}/executions/${w.id}/cancel`)),
      );
      expect(res.status).toBe(200);
      expect(await execution(w.id)).toMatchObject({ status: 'cancelled', wait_deadline_at: null });
    });

    it('journey archive', async () => {
      const j = await plantedJourney('Archive wait', waitGraph('delivered'));
      const w = await armedWait(j, 'archive');
      expect((await as(http().post(url(`${base()}/${j.id}/archive`)))).status).toBe(200);
      expect(await execution(w.id)).toMatchObject({
        status: 'cancelled',
        end_reason: 'journey_archived',
        wait_deadline_at: null,
      });
    });

    it('node failure (TRANSITION_LIMIT)', async () => {
      const w = await armedWait(waitDelivered, 'limit');
      await h.admin.execute(
        sql`UPDATE journey_executions SET transitions = ${JOURNEY_RUNNER_LIMITS.maxTransitions} WHERE id = ${w.id}`,
      );
      await makeDue(w.id);
      await drain(makeRunner('w-limit', port));
      expect(await execution(w.id)).toMatchObject({
        status: 'failed',
        end_reason: 'node_failed',
        wait_deadline_at: null,
      });
      expect((await steps(w.id)).at(-1)).toMatchObject({ error_code: 'TRANSITION_LIMIT' });
    });

    it('retry exhaustion (a transient fault on every re-arm)', async () => {
      const w = await armedWait(waitDelivered, 'exhaust');
      await h.admin.execute(
        sql`UPDATE journey_execution_queue SET attempts = ${JOURNEY_RUNNER_LIMITS.transientMaxAttempts - 1} WHERE execution_id = ${w.id}`,
      );
      await makeDue(w.id);
      // TEST ONLY, on the disposable clone: a serialization failure on this execution's re-arm
      // (an update that keeps it waiting); the update that ends it is let through.
      const fn = `test_8c5b_fail_rearm_${w.id.replace(/-/g, '')}`;
      await h.admin.execute(
        sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.id = '${w.id}' AND NEW.status = 'waiting' THEN
              RAISE EXCEPTION 'injected transient fault' USING ERRCODE = 'serialization_failure';
            END IF;
            RETURN NEW;
          END $$`),
      );
      await h.admin.execute(
        sql.raw(
          `CREATE TRIGGER ${fn} BEFORE UPDATE ON journey_executions FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
        ),
      );
      try {
        expect(await makeRunner('w-exhaust', port).tick()).toEqual(
          expect.arrayContaining([
            {
              executionId: w.id,
              outcome: 'ended',
              transitions: 0,
              errorCode: 'RUNNER_RETRY_EXHAUSTED',
            },
          ]),
        );
      } finally {
        await h.admin.execute(sql.raw(`DROP TRIGGER ${fn} ON journey_executions`));
        await h.admin.execute(sql.raw(`DROP FUNCTION ${fn}()`));
      }
      expect(await execution(w.id)).toMatchObject({
        status: 'failed',
        end_reason: 'runner_retry_exhausted',
        wait_deadline_at: null,
      });
    });

    it('poison', async () => {
      const w = await armedWait(waitDelivered, 'poison');
      await h.admin.execute(
        sql`UPDATE journey_execution_queue SET attempts = ${JOURNEY_RUNNER_LIMITS.poisonClaims} WHERE execution_id = ${w.id}`,
      );
      await makeDue(w.id);
      await drain(makeRunner('w-poison', port));
      expect(await execution(w.id)).toMatchObject({
        status: 'failed',
        end_reason: 'runner_poisoned',
        wait_deadline_at: null,
      });
    });

    it('pause keeps the absolute deadline; one that passed during the pause times out on the next wake after resume', async () => {
      const j = await plantedJourney('Pause wait', waitGraph('delivered'));
      const w = await armedWait(j, 'pause');
      const armed = await execution(w.id);
      expect((await as(http().post(url(`${base()}/${j.id}/pause`)))).status).toBe(200);
      await h.admin.execute(
        sql`UPDATE journey_executions SET wait_deadline_at = now() - interval '1 second' WHERE id = ${w.id}`,
      );
      await makeDue(w.id);
      await drain(makeRunner('w-paused', port));
      const paused = await execution(w.id);
      expect(paused).toMatchObject({ status: 'waiting', state_version: armed.state_version });
      expect(paused.wait_deadline_at).not.toBeNull();
      // Resumed by the owner (the API re-validates activation, which refuses send-node versions).
      await h.admin.execute(sql`UPDATE journeys SET status = 'active' WHERE id = ${j.id}`);
      await makeDue(w.id);
      await drain(makeRunner('w-resumed', port));
      expect(await execution(w.id)).toMatchObject({
        end_reason: 'timed_out',
        wait_deadline_at: null,
      });
    });

    it('a lease expiry during a wait is fenced; the reclaim reads the persisted deadline', async () => {
      const w = await armedWait(waitDelivered, 'lease');
      const armed = await execution(w.id);
      await makeDue(w.id);
      const stale = makeRunner('w-stale', port);
      const [claim] = (await stale.claim()).filter((c) => c.executionId === w.id);
      expect(claim).toBeDefined();
      await h.admin.execute(
        sql`UPDATE journey_execution_queue SET claimed_until = now() - interval '1 second' WHERE execution_id = ${w.id}`,
      );
      expect(await makeRunner('w-reclaim', port).tick()).toEqual(
        expect.arrayContaining([{ executionId: w.id, outcome: 'waiting', transitions: 0 }]),
      );
      expect(await stale.processClaim(claim!)).toMatchObject({ outcome: 'fenced', transitions: 0 });
      const after = await execution(w.id);
      expect(new Date(after.wait_deadline_at!).getTime()).toBe(
        new Date(armed.wait_deadline_at!).getTime(),
      );
      expect(after.state_version).toBe(armed.state_version);
    });
  });

  // --- messages_runner_select and the grants ---------------------------------------------------

  describe('acc_journey on messages (0067)', () => {
    let w1: { id: string; messageId: string };
    let w2: { id: string; messageId: string };

    beforeAll(async () => {
      w1 = await armedWait(waitDelivered, 'pol-1');
      w2 = await armedWait(waitDelivered, 'pol-2');
    });

    it('reads only the claimed execution’s messages, with a live claim', async () => {
      const token = await liveClaim(w1.id);
      const ids = await asRunner(
        { orgId: A.orgId, executionId: w1.id, claimToken: token },
        async (c) => (await c.query('SELECT id FROM messages')).rows.map((r) => r.id),
      );
      expect(ids).toEqual([w1.messageId]);
      const other = await asRunner(
        { orgId: A.orgId, executionId: w1.id, claimToken: token },
        async (c) => (await c.query('SELECT id FROM messages WHERE id = $1', [w2.messageId])).rows,
      );
      expect(other).toEqual([]);
    });

    it('reads nothing without a live claim, with a wrong token, or under another organization (J-S3)', async () => {
      const expired = await liveClaim(w1.id, false);
      for (const ctx of [
        { orgId: A.orgId, executionId: w1.id, claimToken: expired },
        { orgId: A.orgId, executionId: w1.id, claimToken: uuidv7() },
        { orgId: B.orgId, executionId: w1.id, claimToken: expired },
      ])
        expect(
          await asRunner(ctx, async (c) => (await c.query('SELECT id FROM messages')).rows),
        ).toEqual([]);
      const live = await liveClaim(w1.id);
      expect(
        await asRunner(
          { orgId: B.orgId, executionId: w1.id, claimToken: live },
          async (c) => (await c.query('SELECT id FROM messages')).rows,
        ),
      ).toEqual([]);
    });

    it('only the outcome columns are readable; INSERT and UPDATE are refused (J-S4)', async () => {
      const token = await liveClaim(w1.id);
      const ctx = { orgId: A.orgId, executionId: w1.id, claimToken: token };
      for (const column of [
        'recipient_address',
        'payload',
        'contact_id',
        'correlation_id',
        'billable_units',
      ])
        expect([
          column,
          await asRunner(ctx, (c) => refusalCode(c.query(`SELECT ${column} FROM messages`))),
        ]).toEqual([column, '42501']);
      expect(
        await asRunner(ctx, (c) =>
          refusalCode(
            c.query(
              `INSERT INTO messages (org_id, workspace_id, contact_id, channel_id, recipient_address, payload, correlation_id, journey_id, journey_execution_id)
               SELECT org_id, workspace_id, contact_id, $2, 'x', '{}', 'c', journey_id, id FROM journey_executions WHERE id = $1`,
              [w1.id, waChannel],
            ),
          ),
        ),
      ).toBe('42501');
      expect(
        await asRunner(ctx, (c) => refusalCode(c.query(`UPDATE messages SET status = 'failed'`))),
      ).toBe('42501');
    });

    it('the orphan check: every journey-attributed message is named by a step of its execution', async () => {
      const { rows } = await h.admin.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM messages m
         WHERE m.journey_execution_id IS NOT NULL AND m.org_id IN (${A.orgId}, ${B.orgId})
           AND NOT EXISTS (SELECT 1 FROM journey_execution_steps s
                            WHERE s.message_id = m.id AND s.execution_id = m.journey_execution_id)`);
      expect(rows[0]!.n).toBe(0);
    });
  });
});
