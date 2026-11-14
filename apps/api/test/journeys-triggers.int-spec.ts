/**
 * Phase 8C PR 8C-4 — journey event capture and intake, scheduled-trigger firing
 * (`docs/PHASE-8C-JOURNEYS-HANDOVER.md` §§5, 8.1, 9, 12: J-C4, J-C5).
 * Disposable clones only (`scripts/with-db-clone.mjs`).
 *
 * Processing runs as `acc_journey` (SET ROLE on the clone; the role stays NOLOGIN). The
 * application under test keeps the runner, intake and scheduler disabled (defaults), and the
 * platform capture switch is created OFF; this suite turns capture on for its own tests and off
 * again afterwards.
 */
import { PERMISSIONS } from '@acc/contracts';
import { createDatabase, createPool, schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
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
import { CredentialService } from '../src/iam/credential.service';
import { JourneyTriggerProcessingService } from '../src/journeys/runner/journey-trigger-processing.service';

const url = (p: string) => `/${PREFIX}${p}`;
const key = () => `journey-8c4-${uuidv7()}`;
type Graph = Record<string, unknown>;

const triggerGraph = (trigger: Record<string, unknown>): Graph => ({
  schemaVersion: 1,
  entry: 'start',
  nodes: {
    start: { type: 'entry', trigger, next: 'done' },
    done: { type: 'exit' },
  },
});

describe('Phase 8C PR 8C-4: journey event intake and scheduled triggers', () => {
  let h: Harness;
  let A: TenantFixture;
  let B: TenantFixture;
  let tokenA: string;
  let tokenB: string;
  let ws2A: string;
  let runnerPool: Pool;
  let lockPool: Pool;
  let waChannel: string;

  const http = () => request(h.app.getHttpServer());
  const as = <T extends request.Test>(r: T, token = tokenA) =>
    r.set('authorization', `Bearer ${token}`);
  const base = (ws: string) => `/workspaces/${ws}/journeys`;

  const processor = (opts: Partial<JourneyTriggerProcessingService['options']> = {}) =>
    new JourneyTriggerProcessingService(createDatabase(runnerPool), {
      workerId: `w-${uuidv7().slice(-6)}`,
      leaseSeconds: 30,
      lockTimeoutMs: 300,
      ...opts,
    });

  const capture = (on: boolean) =>
    h.admin.execute(sql`UPDATE journey_event_capture SET enabled = ${on}, updated_at = now()`);

  const contact = async (
    t: TenantFixture,
    ws: string,
    name: string,
    metadata: object = {},
  ): Promise<string> =>
    (
      await h.admin
        .insert(schema.contacts)
        .values({ orgId: t.orgId, workspaceId: ws, firstName: name, metadata })
        .returning({ id: schema.contacts.id })
    )[0]!.id;

  const activeJourney = async (
    name: string,
    graph: Graph,
    opts: { t?: TenantFixture; ws?: string; token?: string } = {},
  ) => {
    const t = opts.t ?? A;
    const ws = opts.ws ?? t.workspaceId;
    const token = opts.token ?? (t === B ? tokenB : tokenA);
    const created = await as(http().post(url(base(ws))), token)
      .set('idempotency-key', key())
      .send({ name });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const v = created.body.data.draftVersion as { id: string; graphSha256: string };
    const saved = await as(http().put(url(`${base(ws)}/${id}/versions/${v.id}/graph`)), token).send(
      {
        graph,
        expectedGraphSha256: v.graphSha256,
      },
    );
    expect(saved.status).toBe(200);
    expect(
      (
        await as(http().post(url(`${base(ws)}/${id}/versions/${v.id}/publish`)), token)
          .set('idempotency-key', key())
          .send({ expectedGraphSha256: saved.body.data.graphSha256 })
      ).status,
    ).toBe(200);
    const act = await as(http().post(url(`${base(ws)}/${id}/activate`)), token);
    expect(act.status).toBe(200);
    return { id, versionId: v.id, triggerId: act.body.data.trigger?.id as string, ws };
  };

  const events = async (contactId: string) =>
    (
      await h.admin.execute<{
        kind: string;
        tag: string | null;
        outcome: string | null;
        enrolled: number;
        subject_id: string | null;
      }>(
        sql`SELECT kind, tag, outcome, enrolled, subject_id FROM automation_events WHERE contact_id = ${contactId} ORDER BY created_at, id`,
      )
    ).rows;
  const executionsOf = async (journeyId: string) =>
    (
      await h.admin.execute<{
        contact_id: string;
        entry_kind: string;
        entry_ref: string;
        current_node_key: string;
      }>(
        sql`SELECT contact_id, entry_kind, entry_ref, current_node_key FROM journey_executions WHERE journey_id = ${journeyId} ORDER BY contact_id`,
      )
    ).rows;
  const triggerRow = async (id: string) =>
    (
      await h.admin.execute<{
        next_fire_at: Date | null;
        last_fired_at: Date | null;
        firing_at: Date | null;
        fire_cursor: string | null;
        claim_token: string | null;
        attempts: number;
        last_error_code: string | null;
        not_before: Date | null;
        epoch: number;
      }>(
        sql`SELECT next_fire_at, last_fired_at, firing_at, fire_cursor, claim_token, attempts, last_error_code, not_before, epoch FROM journey_triggers WHERE id = ${id}`,
      )
    ).rows[0]!;
  const makeDue = (triggerId: string, at = sql`now() - interval '1 minute'`) =>
    h.admin.execute(sql`UPDATE journey_triggers SET next_fire_at = ${at} WHERE id = ${triggerId}`);
  const messageCount = async () =>
    Number(
      (
        await h.admin.execute<{ n: string }>(
          sql`SELECT (SELECT count(*) FROM message_dispatch_queue WHERE org_id IN (${A.orgId}, ${B.orgId}))::text AS n`,
        )
      ).rows[0]!.n,
    );

  beforeAll(async () => {
    h = await startHarness();
    await h.clearRateLimits();
    const credentials = h.app.get(CredentialService);
    A = await createTenant(h.admin, 'j4-a', credentials);
    B = await createTenant(h.admin, 'j4-b', credentials);
    for (const t of [A, B]) {
      const roleId = uuidv7();
      await h.admin.insert(schema.roles).values({
        id: roleId,
        orgId: t.orgId,
        key: `j4_all_${t.slug.replace(/-/g, '_')}`,
        name: `Journeys 8C-4 ${t.slug}`,
        description: 'Journeys 8C-4 test role',
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
    const [ws2] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId: A.orgId, name: 'Second', slug: 'j4-second' })
      .returning({ id: schema.workspaces.id });
    ws2A = ws2!.id;
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
      applicationName: 'acc-test-journey-triggers',
    });
    runnerPool.on('connect', (client) => {
      void client.query('SET ROLE acc_journey');
    });
    lockPool = createPool({
      connectionString: process.env.DATABASE_ADMIN_URL!,
      max: 2,
      applicationName: 'acc-test-journey-trigger-locks',
    });
  }, 90_000);

  afterAll(async () => {
    if (!h) return;
    await capture(false);
    await runnerPool?.end();
    await lockPool?.end();
    for (const t of [A, B].filter(Boolean)) {
      await h.admin.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        for (const table of [
          'automation_events',
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
    it('capture is off, and the application has no intake or scheduler database', async () => {
      const [row] = (
        await h.admin.execute<{ enabled: boolean }>(sql`SELECT enabled FROM journey_event_capture`)
      ).rows;
      expect(row).toEqual({ enabled: false });
      expect(h.app.get(JourneyTriggerProcessingService).available).toBe(false);
      await expect(h.app.get(JourneyTriggerProcessingService).processEvents()).rejects.toThrow(
        /disabled/,
      );
      // An active contact.created journey exists, yet with capture off nothing is recorded.
      await activeJourney('Off', triggerGraph({ kind: 'event', event: 'contact.created' }));
      const c = await contact(A, A.workspaceId, 'off');
      expect(await events(c)).toEqual([]);
    });
  });

  describe('capture (records only; gated by the switch and an active listener)', () => {
    beforeAll(() => capture(true));
    afterAll(() => capture(false));

    it('records contact.created only in the workspace and organisation that listen for it', async () => {
      // 'Off' (above) listens for contact.created in A's default workspace.
      const here = await contact(A, A.workspaceId, 'here');
      const otherWs = await contact(A, ws2A, 'other-ws');
      const otherOrg = await contact(B, B.workspaceId, 'other-org');
      expect(await events(here)).toEqual([
        { kind: 'contact.created', tag: null, outcome: null, enrolled: 0, subject_id: null },
      ]);
      expect(await events(otherWs)).toEqual([]);
      expect(await events(otherOrg)).toEqual([]);
    });

    it('contact.updated on a real change only; contact.tag_added only for a listened tag', async () => {
      await activeJourney('Updated', triggerGraph({ kind: 'event', event: 'contact.updated' }));
      await activeJourney(
        'Tagged',
        triggerGraph({ kind: 'event', event: 'contact.tag_added', tag: 'VIP' }),
      );
      const c = await contact(A, A.workspaceId, 'tagger', { tags: ['old'] });
      await h.admin.execute(sql`UPDATE contacts SET updated_at = now() WHERE id = ${c}`); // no change
      await h.admin.execute(
        sql`UPDATE contacts SET metadata = '{"tags":["old","Vip","other"]}'::jsonb WHERE id = ${c}`,
      );
      const kinds = (await events(c)).map((e) => [e.kind, e.tag]);
      expect(kinds).toEqual([
        ['contact.created', null],
        ['contact.updated', null],
        ['contact.tag_added', 'vip'],
      ]);
    });

    it('records message.delivered, message.read and message.failed once each per message', async () => {
      for (const event of ['message.delivered', 'message.read', 'message.failed'])
        await activeJourney(`Msg ${event}`, triggerGraph({ kind: 'event', event }));
      const c = await contact(A, A.workspaceId, 'msg');
      const plant = async () => {
        const id = uuidv7();
        await h.admin.execute(sql`
          INSERT INTO messages (id, org_id, workspace_id, contact_id, channel_id, status, recipient_address, payload, correlation_id)
          VALUES (${id}, ${A.orgId}, ${A.workspaceId}, ${c}, ${waChannel}, 'submitting', '+12025550111', '{}'::jsonb, ${uuidv7()})`);
        return id;
      };
      const m1 = await plant();
      await h.admin.execute(
        sql`UPDATE messages SET status = 'accepted', completed_at = now(), delivery_status = 'pending' WHERE id = ${m1}`,
      );
      await h.admin.execute(
        sql`UPDATE messages SET delivery_status = 'delivered', delivered_at = now() WHERE id = ${m1}`,
      );
      await h.admin.execute(sql`UPDATE messages SET read_at = now() WHERE id = ${m1}`);
      const m2 = await plant();
      await h.admin.execute(
        sql`UPDATE messages SET status = 'failed', completed_at = now(), failure_reason = 'x' WHERE id = ${m2}`,
      );
      const got = (await events(c)).filter((e) => e.kind.startsWith('message.'));
      expect(got.map((e) => [e.kind, e.subject_id])).toEqual([
        ['message.delivered', m1],
        ['message.read', m1],
        ['message.failed', m2],
      ]);
      // A message capture never creates a message or a dispatch row.
      expect(await messageCount()).toBe(0);
    });

    it('a capture failure never aborts the producer (reported, not raised)', async () => {
      const c = await contact(A, A.workspaceId, 'safe');
      // An over-long dedupe key violates automation_events' CHECK: swallowed with a WARNING.
      await expect(
        h.admin.execute(
          sql`SELECT app_journey_capture_event(${A.orgId}, ${A.workspaceId}, 'contact.created', ${c}, NULL, NULL, now(), repeat('x', 300))`,
        ),
      ).resolves.toBeDefined();
      expect((await events(c)).filter((e) => e.kind === 'contact.created')).toHaveLength(1);
    });
  });

  describe('event intake', () => {
    beforeAll(() => capture(true));
    afterAll(() => capture(false));

    it('enrols the contact after the entry node, marks the event processed, and never twice (J-C4)', async () => {
      const ws = (
        await h.admin
          .insert(schema.workspaces)
          .values({ orgId: A.orgId, name: 'Intake', slug: `j4-intake-${uuidv7().slice(-6)}` })
          .returning({ id: schema.workspaces.id })
      )[0]!.id;
      const j1 = await activeJourney(
        'Intake 1',
        triggerGraph({ kind: 'event', event: 'contact.created' }),
        { ws },
      );
      const j2 = await activeJourney(
        'Intake 2',
        triggerGraph({ kind: 'event', event: 'contact.created' }),
        { ws },
      );
      const c = await contact(A, ws, 'intake');
      const p1 = processor();
      const p2 = processor();
      // Two intake workers at once: SKIP LOCKED gives each event to one of them.
      const [r1, r2] = await Promise.all([p1.processEvents(), p2.processEvents()]);
      const all = [...r1, ...r2];
      // Each event was taken by exactly one of the two workers.
      expect(new Set(all.map((r) => r.eventId)).size).toBe(all.length);
      expect(all.filter((r) => r.enrolled === 2)).toHaveLength(1);
      for (const j of [j1, j2]) {
        const ex = await executionsOf(j.id);
        expect(ex).toHaveLength(1);
        expect(ex[0]).toMatchObject({
          contact_id: c,
          entry_kind: 'event',
          current_node_key: 'done',
        });
        expect(ex[0]!.entry_ref).toMatch(/^event:[0-9a-f-]{36}$/);
      }
      expect(await events(c)).toEqual([
        { kind: 'contact.created', tag: null, outcome: 'enrolled', enrolled: 2, subject_id: null },
      ]);
      // A replay of the same event (processed_at reset) enrols nobody again.
      await h.admin.execute(
        sql`UPDATE automation_events SET processed_at = NULL, outcome = NULL, enrolled = 0 WHERE contact_id = ${c}`,
      );
      await processor().processEvents();
      expect((await events(c))[0]).toMatchObject({ outcome: 'no_match', enrolled: 0 });
      expect(await executionsOf(j1.id)).toHaveLength(1);
      const step = await h.admin.execute<{ details: Record<string, unknown> }>(
        sql`SELECT s.details FROM journey_execution_steps s JOIN journey_executions e ON e.id = s.execution_id WHERE e.journey_id = ${j1.id}`,
      );
      expect(step.rows).toEqual([
        { details: { entryKind: 'event', eventKind: 'contact.created' } },
      ]);
    });

    it('late events: one that occurred before activation, or reaches a paused journey, enrols nobody', async () => {
      const ws = (
        await h.admin
          .insert(schema.workspaces)
          .values({ orgId: A.orgId, name: 'Late', slug: `j4-late-${uuidv7().slice(-6)}` })
          .returning({ id: schema.workspaces.id })
      )[0]!.id;
      const j = await activeJourney(
        'Late',
        triggerGraph({ kind: 'event', event: 'contact.updated' }),
        { ws },
      );
      const early = await contact(A, ws, 'early');
      // An event that occurred before the journey was activated (e.g. delayed in the inbox).
      await h.admin.execute(sql`
        INSERT INTO automation_events (org_id, workspace_id, kind, contact_id, occurred_at, dedupe_key)
        VALUES (${A.orgId}, ${ws}, 'contact.updated', ${early}, now() - interval '1 day', ${`late-${uuidv7()}`})`);
      await processor().processEvents();
      expect((await events(early)).at(-1)).toMatchObject({ outcome: 'no_match' });
      // Captured while active, processed after a pause: the paused trigger enrols nobody.
      const paused = await contact(A, ws, 'paused');
      await h.admin.execute(sql`UPDATE contacts SET first_name = 'changed' WHERE id = ${paused}`);
      expect((await events(paused)).map((e) => e.kind)).toEqual(['contact.updated']);
      await as(http().post(url(`${base(ws)}/${j.id}/pause`)));
      await processor().processEvents();
      expect((await events(paused))[0]).toMatchObject({ outcome: 'no_match', enrolled: 0 });
      expect(await executionsOf(j.id)).toEqual([]);
    });

    it('a failing event is isolated: recorded as failed, and the batch continues', async () => {
      const ws = (
        await h.admin
          .insert(schema.workspaces)
          .values({ orgId: A.orgId, name: 'Poison', slug: `j4-poison-${uuidv7().slice(-6)}` })
          .returning({ id: schema.workspaces.id })
      )[0]!.id;
      const bad = await activeJourney(
        'Bad',
        triggerGraph({ kind: 'event', event: 'contact.created' }),
        { ws },
      );
      const ws3 = (
        await h.admin
          .insert(schema.workspaces)
          .values({ orgId: A.orgId, name: 'Fine', slug: `j4-fine-${uuidv7().slice(-6)}` })
          .returning({ id: schema.workspaces.id })
      )[0]!.id;
      const good = await activeJourney(
        'Good',
        triggerGraph({ kind: 'event', event: 'contact.created' }),
        { ws: ws3 },
      );
      // Every enrolment into the 'Bad' journey now fails inside the database.
      await h.admin.execute(
        sql.raw(
          `ALTER TABLE journey_execution_steps ADD CONSTRAINT tmp_8c4_poison CHECK (workspace_id <> '${ws}'::uuid) NOT VALID`,
        ),
      );
      try {
        const c1 = await contact(A, ws, 'poisoned');
        const c2 = await contact(A, ws3, 'fine');
        await processor().processEvents();
        const e1 = await h.admin.execute<{ outcome: string; error_code: string | null }>(
          sql`SELECT outcome, error_code FROM automation_events WHERE contact_id = ${c1}`,
        );
        expect(e1.rows).toEqual([{ outcome: 'failed', error_code: '23514' }]);
        expect(await executionsOf(bad.id)).toEqual([]);
        expect((await executionsOf(good.id)).map((e) => e.contact_id)).toEqual([c2]);
      } finally {
        await h.admin.execute(
          sql`ALTER TABLE journey_execution_steps DROP CONSTRAINT tmp_8c4_poison`,
        );
      }
    });

    it('retention removes events older than 30 days only', async () => {
      const c = await contact(A, A.workspaceId, 'old');
      await h.admin.execute(sql`
        INSERT INTO automation_events (org_id, workspace_id, kind, contact_id, occurred_at, dedupe_key, created_at, processed_at, outcome)
        VALUES (${A.orgId}, ${A.workspaceId}, 'contact.updated', ${c}, now() - interval '40 days', ${`old-${uuidv7()}`}, now() - interval '31 days', now() - interval '31 days', 'no_match'),
               (${A.orgId}, ${A.workspaceId}, 'contact.updated', ${c}, now() - interval '2 days', ${`new-${uuidv7()}`}, now() - interval '29 days', now() - interval '29 days', 'no_match')`);
      expect(await processor().purgeEvents()).toBeGreaterThanOrEqual(1);
      const left = await h.admin.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM automation_events WHERE contact_id = ${c} AND created_at < now() - interval '30 days'`,
      );
      expect(left.rows[0]!.n).toBe('0');
      expect((await events(c)).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('scheduled triggers', () => {
    let segmentId: string;
    let audience: string[];
    let ws: string;

    beforeAll(async () => {
      ws = (
        await h.admin
          .insert(schema.workspaces)
          .values({ orgId: A.orgId, name: 'Sched', slug: `j4-sched-${uuidv7().slice(-6)}` })
          .returning({ id: schema.workspaces.id })
      )[0]!.id;
      segmentId = (
        await h.admin
          .insert(schema.segments)
          .values({
            orgId: A.orgId,
            workspaceId: ws,
            name: `sched-${uuidv7()}`,
            criteria: { tags: ['sched'] },
          })
          .returning({ id: schema.segments.id })
      )[0]!.id;
      audience = [];
      for (let i = 0; i < 5; i++) audience.push(await contact(A, ws, `s${i}`, { tags: ['Sched'] }));
      await contact(A, ws, 'not-in-segment', { tags: ['other'] });
      await contact(A, ws2A, 'other-ws', { tags: ['sched'] });
      audience.sort();
    });
    const daily = (time = '09:00', timeZone = 'Asia/Kolkata') => ({
      kind: 'schedule',
      segmentId,
      schedule: { type: 'recurring', frequency: 'daily', time, timeZone },
    });
    const enrolledContacts = async (journeyId: string) =>
      (await executionsOf(journeyId)).map((e) => e.contact_id).sort();

    it('fires a due trigger: enrols the segment audience once, schedules the next fire, audits; not-due and paused are not claimed', async () => {
      const j = await activeJourney('Daily', triggerGraph(daily()), { ws });
      const p = processor();
      expect(await p.claimSchedule()).toBeNull(); // not due
      await makeDue(j.triggerId);
      await as(http().post(url(`${base(ws)}/${j.id}/pause`)));
      expect(await p.claimSchedule()).toBeNull(); // paused
      await as(http().post(url(`${base(ws)}/${j.id}/resume`)));
      await makeDue(j.triggerId);
      // Defence in depth: the claim also checks the journey itself, not only its trigger — a
      // journey paused with its trigger still active (set directly) is not claimed either.
      await h.admin.execute(sql`UPDATE journeys SET status = 'paused' WHERE id = ${j.id}`);
      expect(await p.claimSchedule()).toBeNull();
      await h.admin.execute(sql`UPDATE journeys SET status = 'active' WHERE id = ${j.id}`);
      const [result] = await p.fireDueSchedules();
      expect(result).toMatchObject({ triggerId: j.triggerId, result: 'completed', enrolled: 5 });
      expect(await enrolledContacts(j.id)).toEqual(audience);
      const ex = await executionsOf(j.id);
      expect(new Set(ex.map((e) => e.entry_ref)).size).toBe(1);
      expect(ex[0]!.entry_ref).toMatch(
        /^schedule:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
      const t = await triggerRow(j.triggerId);
      expect(t).toMatchObject({
        firing_at: null,
        fire_cursor: null,
        claim_token: null,
        attempts: 0,
      });
      expect(new Date(t.next_fire_at!).getTime()).toBeGreaterThan(Date.now());
      expect(new Date(t.next_fire_at!).toISOString()).toMatch(/T03:30:00\.000Z$/); // 09:00 IST
      const audit = await h.admin.execute<{
        actor_type: string;
        actor_label: string;
        outcome: string;
        metadata: Record<string, unknown>;
      }>(
        sql`SELECT actor_type, actor_label, outcome, metadata FROM audit_logs WHERE resource_id = ${j.id} AND action = 'journey.schedule_fired'`,
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        actor_type: 'system',
        actor_label: 'journey_runner',
        outcome: 'success',
      });
      expect(audit.rows[0]!.metadata).toMatchObject({
        enrolled: 5,
        result: 'completed',
        triggerId: j.triggerId,
      });
      expect(await p.fireDueSchedules()).toEqual([]); // nothing due any more
      expect(await messageCount()).toBe(0);
    });

    it('J-C5: overlapping schedulers on one due trigger enrol each contact once; a stale claim is fenced', async () => {
      const j = await activeJourney('Overlap', triggerGraph(daily()), { ws });
      await makeDue(j.triggerId);
      const [x, y] = await Promise.all([
        processor().fireDueSchedules(),
        processor().fireDueSchedules(),
      ]);
      expect([...x, ...y].filter((r) => r.triggerId === j.triggerId)).toHaveLength(1);
      expect(await enrolledContacts(j.id)).toEqual(audience);

      const k = await activeJourney('Takeover', triggerGraph(daily()), { ws });
      await makeDue(k.triggerId);
      const stale = processor({ scheduleBatch: 2 });
      const claim = (await stale.claimSchedule())!;
      expect(claim.triggerId).toBe(k.triggerId);
      await h.admin.execute(
        sql`UPDATE journey_triggers SET claimed_until = now() - interval '1 second' WHERE id = ${k.triggerId}`,
      );
      const fresh = processor();
      const [taken] = await fresh.fireDueSchedules();
      expect(taken).toMatchObject({ triggerId: k.triggerId, result: 'completed', enrolled: 5 });
      expect(await stale.fire(claim)).toMatchObject({ result: 'fenced', enrolled: 0 });
      expect(await enrolledContacts(k.id)).toEqual(audience);
    });

    it('resumable firing: batches under one frozen fire instant; a re-fire of the same instant enrols nobody', async () => {
      const j = await activeJourney('Batches', triggerGraph(daily()), { ws });
      await makeDue(j.triggerId);
      const p = processor({ scheduleBatch: 2, scheduleBatchesPerClaim: 1 });
      const first = await p.fireDueSchedules(1);
      expect(first[0]).toMatchObject({ result: 'paused', enrolled: 2, batches: 1 });
      const mid = await triggerRow(j.triggerId);
      expect(mid.firing_at).not.toBeNull();
      expect(mid.fire_cursor).toBe(audience[1]);
      const results = [];
      for (let i = 0; i < 5; i++) results.push(...(await p.fireDueSchedules(1)));
      expect(results.at(-1)).toMatchObject({ result: 'completed' });
      expect(await enrolledContacts(j.id)).toEqual(audience);
      const fired = (await triggerRow(j.triggerId)).last_fired_at!;
      // Force the same instant to fire again: the entry reference makes it a no-op.
      await h.admin.execute(
        sql`UPDATE journey_triggers SET firing_at = ${fired}, next_fire_at = ${fired} WHERE id = ${j.triggerId}`,
      );
      const again = await processor().fireDueSchedules(1);
      expect(again[0]).toMatchObject({ result: 'completed', enrolled: 0 });
      expect(await executionsOf(j.id)).toHaveLength(5);
    });

    it('missed fires are not replayed in a burst; a one-off schedule fires once', async () => {
      const j = await activeJourney('Missed', triggerGraph(daily()), { ws });
      await makeDue(j.triggerId, sql`now() - interval '3 days'`);
      const [r] = await processor().fireDueSchedules();
      expect(r).toMatchObject({ result: 'completed', enrolled: 5 });
      expect(new Date((await triggerRow(j.triggerId)).next_fire_at!).getTime()).toBeGreaterThan(
        Date.now(),
      );
      expect(await processor().fireDueSchedules()).toEqual([]);

      const once = await activeJourney(
        'Once',
        triggerGraph({
          kind: 'schedule',
          segmentId,
          schedule: { type: 'once', at: '2099-01-01T00:00:00Z' },
        }),
        { ws },
      );
      await makeDue(once.triggerId);
      const [o] = await processor().fireDueSchedules();
      expect(o).toMatchObject({ result: 'completed', enrolled: 5, nextFireAt: null });
      expect((await triggerRow(once.triggerId)).next_fire_at).toBeNull();
      expect(await processor().claimSchedule()).toBeNull();
    });

    it('DST: the next fire after a fall-back 01:30 skips the repeated hour; after a spring-forward gap it moves to 03:30', async () => {
      const fall = await activeJourney(
        'Fall back',
        triggerGraph(daily('01:30', 'America/New_York')),
        { ws },
      );
      // 01-Nov-2026 01:30 EDT (05:30Z) fires; the second 01:30 (EST, 06:30Z) is not a new fire.
      await makeDue(fall.triggerId, sql`'2026-11-01T05:30:00Z'::timestamptz`);
      const [f] = await processor({ now: () => new Date('2026-11-01T05:31:00Z') }).fireDueSchedules(
        1,
      );
      expect(f).toMatchObject({ result: 'completed', nextFireAt: '2026-11-02T06:30:00.000Z' });
      expect((await executionsOf(fall.id))[0]!.entry_ref).toMatch(/:2026-11-01T05:30:00Z$/);

      const spring = await activeJourney(
        'Spring forward',
        triggerGraph(daily('02:30', 'America/New_York')),
        { ws },
      );
      await makeDue(spring.triggerId, sql`'2026-03-07T07:30:00Z'::timestamptz`);
      const [s] = await processor({ now: () => new Date('2026-03-07T07:31:00Z') }).fireDueSchedules(
        1,
      );
      // 08-Mar-2026 02:30 does not exist in New York: it runs at 03:30 EDT (07:30Z).
      expect(s).toMatchObject({ result: 'completed', nextFireAt: '2026-03-08T07:30:00.000Z' });
      // Those next fires lie before the real clock: archive both so later tests do not claim them.
      for (const j of [fall, spring])
        expect((await as(http().post(url(`${base(ws)}/${j.id}/archive`)))).status).toBe(200);
    });

    it('failures: a missing segment abandons the fire (audited); a transient error retries with backoff; poison abandons', async () => {
      const gone = (
        await h.admin
          .insert(schema.segments)
          .values({
            orgId: A.orgId,
            workspaceId: ws,
            name: `gone-${uuidv7()}`,
            criteria: { tags: ['sched'] },
          })
          .returning({ id: schema.segments.id })
      )[0]!.id;
      const j = await activeJourney(
        'Gone',
        triggerGraph({ kind: 'schedule', segmentId: gone, schedule: daily().schedule }),
        { ws },
      );
      await h.admin.execute(sql`UPDATE segments SET deleted_at = now() WHERE id = ${gone}`);
      await makeDue(j.triggerId);
      const [a] = await processor().fireDueSchedules(1);
      expect(a).toMatchObject({ result: 'abandoned', errorCode: 'SEGMENT_NOT_FOUND', enrolled: 0 });
      expect(await triggerRow(j.triggerId)).toMatchObject({
        firing_at: null,
        last_error_code: 'SEGMENT_NOT_FOUND',
      });
      const audit = await h.admin.execute<{ outcome: string }>(
        sql`SELECT outcome FROM audit_logs WHERE resource_id = ${j.id} AND action = 'journey.schedule_fired'`,
      );
      expect(audit.rows).toEqual([{ outcome: 'failure' }]);

      const t = await activeJourney('Transient', triggerGraph(daily()), { ws });
      await makeDue(t.triggerId);
      const p = processor();
      const claim = (await p.claimSchedule())!;
      const holder = await lockPool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM journey_triggers WHERE id = $1 FOR UPDATE', [
          t.triggerId,
        ]);
        // The enrolment times out on the held row (300 ms); the lock is gone before the retry
        // is recorded, as with a real transient failure.
        const release = new Promise((r) => setTimeout(r, 450)).then(() => holder.query('ROLLBACK'));
        const r = await p.fire(claim);
        await release;
        expect(r).toMatchObject({ result: 'retry', errorCode: '55P03' });
      } finally {
        holder.release();
      }
      const row = await triggerRow(t.triggerId);
      expect(row).toMatchObject({ claim_token: null, last_error_code: '55P03', attempts: 1 });
      expect(row.firing_at).not.toBeNull();
      expect(new Date(row.not_before!).getTime()).toBeGreaterThan(Date.now());
      expect(await p.claimSchedule()).toBeNull(); // backoff
      await h.admin.execute(
        sql`UPDATE journey_triggers SET not_before = NULL WHERE id = ${t.triggerId}`,
      );
      const [done] = await p.fireDueSchedules(1);
      expect(done).toMatchObject({ result: 'completed', enrolled: 5 });

      const poison = await activeJourney('Poison', triggerGraph(daily()), { ws });
      await makeDue(poison.triggerId);
      await h.admin.execute(
        sql`UPDATE journey_triggers SET attempts = 5 WHERE id = ${poison.triggerId}`,
      );
      const [pz] = await processor().fireDueSchedules(1);
      expect(pz).toMatchObject({ result: 'abandoned', errorCode: 'RUNNER_POISONED', enrolled: 0 });
      expect(await executionsOf(poison.id)).toEqual([]);
    });

    it('acc_journey under a schedule claim reads only the trigger’s workspace audience; nothing without the claim', async () => {
      const j = await activeJourney('Scope', triggerGraph(daily()), { ws });
      await makeDue(j.triggerId);
      const claim = (await processor().claimSchedule())!;
      expect(claim.triggerId).toBe(j.triggerId);
      const counts = async (token: string) => {
        const c = await runnerPool.connect();
        try {
          await c.query('BEGIN');
          await c.query(
            `SELECT set_config('app.current_org_id', $1, true), set_config('app.journey_trigger_id', $2, true), set_config('app.journey_trigger_claim_token', $3, true)`,
            [A.orgId, j.triggerId, token],
          );
          const n = async (q: string) => Number((await c.query(q)).rows[0].n);
          return {
            contacts: await n('SELECT count(*) AS n FROM contacts'),
            otherWs: await n(`SELECT count(*) AS n FROM contacts WHERE workspace_id <> '${ws}'`),
            segments: await n('SELECT count(*) AS n FROM segments'),
            executions: await n('SELECT count(*) AS n FROM journey_executions'),
          };
        } finally {
          await c.query('ROLLBACK');
          c.release();
        }
      };
      const total = Number(
        (
          await h.admin.execute<{ n: string }>(
            sql`SELECT count(*)::text AS n FROM contacts WHERE workspace_id = ${ws}`,
          )
        ).rows[0]!.n,
      );
      expect(await counts(claim.claimToken)).toEqual({
        contacts: total,
        otherWs: 0,
        segments: 1,
        executions: 0,
      });
      expect(await counts(uuidv7())).toEqual({
        contacts: 0,
        otherWs: 0,
        segments: 0,
        executions: 0,
      });
      const c = await runnerPool.connect();
      try {
        await expect(
          c.query(
            `INSERT INTO journey_executions (org_id, workspace_id, journey_id, journey_version_id, contact_id, current_node_key, entry_kind, entry_ref) VALUES ($1, $2, $3, $4, $5, 'done', 'schedule', 'x')`,
            [A.orgId, ws, j.id, j.versionId, audience[0]],
          ),
        ).rejects.toThrow(/permission denied/);
        await expect(c.query('SELECT 1 FROM automation_events LIMIT 1')).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        c.release();
      }
      await h.admin.execute(
        sql`UPDATE journey_triggers SET claim_token = NULL, claimed_until = NULL, firing_at = NULL, next_fire_at = now() + interval '1 day' WHERE id = ${j.triggerId}`,
      );
    });
  });
});
