/**
 * Phase 8C PR 8C-2 — journey lifecycle, derived triggers, API enrolment, executions, operator
 * cancel and statistics (`docs/PHASE-8C-JOURNEYS-HANDOVER.md` §§5, 7, 8.1, 8.5, 11, 12).
 * Disposable clones only (`scripts/with-db-clone.mjs`).
 *
 * Throughout: no runner exists, so an enrolled execution stays `running` at its first node
 * with an unclaimed queue row, and no message or dispatch-queue row is ever created.
 */
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import {
  PASSWORD,
  PREFIX,
  createTenant,
  destroyTenant,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';
import { CredentialService } from '../src/iam/credential.service';
import { apiEntryRef } from '../src/journeys/journey-executions.service';

const url = (p: string) => `/${PREFIX}${p}`;
const key = () => `journey-8c2-${uuidv7()}`;
const pgMessage = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (error) {
    const e = error as { cause?: { message?: string }; message?: string };
    return String(e.cause?.message ?? e.message);
  }
  return 'NO ERROR';
};

type Graph = Record<string, unknown>;
const apiGraph = (waitSeconds = 3600): Graph => ({
  schemaVersion: 1,
  entry: 'start',
  nodes: {
    start: { type: 'entry', trigger: { kind: 'api' }, next: 'pause' },
    pause: { type: 'wait_duration', seconds: waitSeconds, next: 'done' },
    done: { type: 'exit' },
  },
});
const triggerGraph = (trigger: Record<string, unknown>): Graph => ({
  schemaVersion: 1,
  entry: 'start',
  nodes: {
    start: { type: 'entry', trigger, next: 'done' },
    done: { type: 'exit' },
  },
});

describe('Phase 8C PR 8C-2: journey lifecycle and executions', () => {
  let h: Harness;
  let A: TenantFixture;
  let B: TenantFixture;
  let tokenA: string; // journeys.read, journeys.manage, messages.send
  let tokenNoSend: string; // journeys.read, journeys.manage (org A)
  let tokenReadOnly: string; // journeys.read (org A)
  let tokenB: string; // org B: journeys.*, messages.send
  let ws2A: string;
  let segmentA: string;
  let waTemplate: string;
  let contactsA: string[];
  let contactWs2: string;
  let contactB: string;
  const extraUsers: string[] = [];

  const http = () => request(h.app.getHttpServer());
  const as = <T extends request.Test>(r: T, token = tokenA) =>
    r.set('authorization', `Bearer ${token}`);
  const base = (ws = A.workspaceId) => `/workspaces/${ws}/journeys`;

  const roleWith = async (t: TenantFixture, suffix: string, permissions: string[]) => {
    const roleId = uuidv7();
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: t.orgId,
      key: `j2_${suffix}_${t.slug.replace(/-/g, '_')}`,
      name: `Journeys 8C-2 ${suffix} ${t.slug}`,
      description: 'Journeys 8C-2 test role',
      isSystemRole: false,
      allowedScopeTypes: ['organization', 'workspace'],
    });
    for (const k of permissions) {
      const [p] = await h.admin
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(eq(schema.permissions.key, k));
      await h.admin.insert(schema.rolePermissions).values({ roleId, permissionId: p!.id });
    }
    return roleId;
  };
  const grantRole = (t: TenantFixture, userId: string, roleId: string) =>
    h.admin.insert(schema.userRoles).values({
      orgId: t.orgId,
      userId,
      roleId,
      scopeType: 'organization',
      scopeId: t.orgId,
    });
  const login = async (email: string) =>
    (await http().post(url('/auth/login')).send({ email, password: PASSWORD })).body.data
      .accessToken as string;
  const extraUser = async (t: TenantFixture, label: string, permissions: string[]) => {
    const credentials = h.app.get(CredentialService);
    const email = `${label}-${uuidv7().replace(/-/g, '').slice(-12)}@example.test`;
    const [user] = await h.admin
      .insert(schema.users)
      .values({
        email,
        status: 'active',
        passwordHash: await credentials.hash(PASSWORD),
        passwordUpdatedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    extraUsers.push(user!.id);
    await grantRole(t, user!.id, await roleWith(t, label.replace(/-/g, '_'), permissions));
    return login(email);
  };
  const contact = async (t: TenantFixture, ws: string, name: string) =>
    (
      await h.admin
        .insert(schema.contacts)
        .values({ orgId: t.orgId, workspaceId: ws, firstName: name })
        .returning({ id: schema.contacts.id })
    )[0]!.id;

  /** Creates a journey, saves `graph` as v1 and publishes it. */
  const published = async (name: string, graph: Graph, token = tokenA, ws = A.workspaceId) => {
    const created = await as(http().post(url(base(ws))), token)
      .set('idempotency-key', key())
      .send({ name });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const v = created.body.data.draftVersion as { id: string; graphSha256: string };
    const saved = await as(http().put(url(`${base(ws)}/${id}/versions/${v.id}/graph`)), token).send(
      { graph, expectedGraphSha256: v.graphSha256 },
    );
    expect(saved.status).toBe(200);
    const pub = await as(http().post(url(`${base(ws)}/${id}/versions/${v.id}/publish`)), token)
      .set('idempotency-key', key())
      .send({ expectedGraphSha256: saved.body.data.graphSha256 });
    expect(pub.status).toBe(200);
    return { id, versionId: v.id };
  };
  const lifecycle = (id: string, action: string, token = tokenA, ws = A.workspaceId) =>
    as(http().post(url(`${base(ws)}/${id}/${action}`)), token);
  const enrol = (id: string, contactIds: string[], k: string | null = key(), token = tokenA) => {
    const r = as(http().post(url(`${base()}/${id}/enrollments`)), token);
    if (k) r.set('idempotency-key', k);
    return r.send({ contactIds });
  };
  const newDraft = async (id: string) => {
    const r = await as(http().post(url(`${base()}/${id}/versions`))).set('idempotency-key', key());
    expect(r.status).toBe(201);
    return r.body.data as { id: string; graphSha256: string };
  };
  const publishDraft = async (
    id: string,
    draft: { id: string; graphSha256: string },
    graph: Graph,
  ) => {
    const saved = await as(http().put(url(`${base()}/${id}/versions/${draft.id}/graph`))).send({
      graph,
      expectedGraphSha256: draft.graphSha256,
    });
    expect(saved.status).toBe(200);
    return as(http().post(url(`${base()}/${id}/versions/${draft.id}/publish`)))
      .set('idempotency-key', key())
      .send({ expectedGraphSha256: saved.body.data.graphSha256 });
  };
  const audits = async (resourceId: string) =>
    (
      await h.admin.execute<{ action: string }>(
        sql`SELECT action FROM audit_logs WHERE resource_id = ${resourceId} ORDER BY created_at, id`,
      )
    ).rows.map((r) => r.action);
  const count = async (q: ReturnType<typeof sql>) =>
    Number(((await h.admin.execute<{ n: string }>(q)).rows[0] as { n: string }).n);

  beforeAll(async () => {
    h = await startHarness();
    // The suite signs in four identities; earlier suites on the same Redis share the window.
    await h.clearRateLimits();
    const credentials = h.app.get(CredentialService);
    A = await createTenant(h.admin, 'j2-a', credentials);
    B = await createTenant(h.admin, 'j2-b', credentials);
    const all = [PERMISSIONS.JOURNEYS_READ, PERMISSIONS.JOURNEYS_MANAGE, PERMISSIONS.MESSAGES_SEND];
    await grantRole(A, A.userId, await roleWith(A, 'all', all));
    await grantRole(B, B.userId, await roleWith(B, 'all', all));
    const [ws2] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId: A.orgId, name: 'Second', slug: 'j2-second' })
      .returning({ id: schema.workspaces.id });
    ws2A = ws2!.id;
    segmentA = (
      await h.admin
        .insert(schema.segments)
        .values({ orgId: A.orgId, workspaceId: A.workspaceId, name: `s-${uuidv7()}`, criteria: {} })
        .returning({ id: schema.segments.id })
    )[0]!.id;
    const [wa] = await h.admin
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.code, 'whatsapp'));
    waTemplate = (
      await h.admin
        .insert(schema.templates)
        .values({
          orgId: A.orgId,
          channelId: wa!.id,
          name: `t-${uuidv7()}`,
          body: 'Hello',
          variables: [],
          approvalStatus: 'approved',
        })
        .returning({ id: schema.templates.id })
    )[0]!.id;
    contactsA = [];
    for (let i = 0; i < 12; i++) contactsA.push(await contact(A, A.workspaceId, `c${i}`));
    contactWs2 = await contact(A, ws2A, 'other-ws');
    contactB = await contact(B, B.workspaceId, 'other-org');
    tokenA = await login(A.email);
    tokenB = await login(B.email);
    tokenNoSend = await extraUser(A, 'j2-nosend', [
      PERMISSIONS.JOURNEYS_READ,
      PERMISSIONS.JOURNEYS_MANAGE,
    ]);
    tokenReadOnly = await extraUser(A, 'j2-read', [PERMISSIONS.JOURNEYS_READ]);
  }, 90_000);

  afterAll(async () => {
    if (!h) return;
    for (const t of [A, B].filter(Boolean)) {
      // Executions, history and versions are never deleted in production (guard triggers);
      // teardown removes them as the owner with triggers suspended.
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
    for (const id of extraUsers) {
      await purgeAudit(h.admin, sql`actor_user_id = ${id}`);
      await h.admin.execute(sql`DELETE FROM sessions WHERE user_id = ${id}`);
      await h.admin.execute(sql`DELETE FROM users WHERE id = ${id}`);
    }
    await h.close();
  }, 90_000);

  describe('lifecycle and trigger derivation', () => {
    it('activation needs a published version; activates the highest one; derives an api trigger; a repeat is a no-op', async () => {
      const created = await as(http().post(url(base())))
        .set('idempotency-key', key())
        .send({ name: 'Unpublished' });
      const draftOnly = await lifecycle(created.body.data.id, 'activate');
      expect(draftOnly.status).toBe(409);
      expect(draftOnly.body.error.code).toBe(ERROR_CODES.JOURNEY_NO_PUBLISHED_VERSION);

      const j = await published('Activate me', apiGraph());
      const v2 = await newDraft(j.id);
      expect((await publishDraft(j.id, v2, apiGraph(7200))).status).toBe(200);

      const first = await lifecycle(j.id, 'activate');
      expect(first.status).toBe(200);
      expect(first.body.data).toMatchObject({
        status: 'active',
        activeVersionId: v2.id,
        activatedBy: A.userId,
        trigger: {
          kind: 'api',
          journeyVersionId: v2.id,
          status: 'active',
          nextFireAt: null,
          eventKind: null,
        },
      });
      // Older published versions stop being enrollable.
      const versions = await as(http().get(url(`${base()}/${j.id}/versions`)));
      expect(versions.body.data.map((v: { status: string }) => v.status)).toEqual([
        'published',
        'retired',
      ]);
      const again = await lifecycle(j.id, 'activate');
      expect(again.status).toBe(200);
      expect(again.body.data.activatedAt).toBe(first.body.data.activatedAt);
      expect((await audits(j.id)).filter((a) => a === 'journey.activated')).toHaveLength(1);
    });

    it('derives event and schedule triggers (next fire computed); refuses an elapsed one-off schedule', async () => {
      const ev = await published(
        'Event trigger',
        triggerGraph({ kind: 'event', event: 'contact.tag_added', tag: 'vip' }),
      );
      const evA = await lifecycle(ev.id, 'activate');
      expect(evA.status).toBe(200);
      expect(evA.body.data.trigger).toMatchObject({
        kind: 'event',
        eventKind: 'contact.tag_added',
        eventTag: 'vip',
        nextFireAt: null,
      });

      const daily = await published(
        'Daily schedule',
        triggerGraph({
          kind: 'schedule',
          segmentId: segmentA,
          schedule: {
            type: 'recurring',
            frequency: 'daily',
            time: '09:00',
            timeZone: 'Asia/Kolkata',
          },
        }),
      );
      const before = Date.now();
      const dA = await lifecycle(daily.id, 'activate');
      expect(dA.status).toBe(200);
      expect(dA.body.data.trigger).toMatchObject({ kind: 'schedule', segmentId: segmentA });
      const fire = Date.parse(dA.body.data.trigger.nextFireAt);
      expect(fire).toBeGreaterThan(before);
      expect(fire - before).toBeLessThanOrEqual(24 * 3600 * 1000);
      expect(new Date(fire).getUTCHours() * 60 + new Date(fire).getUTCMinutes()).toBe(3 * 60 + 30);

      const past = await published(
        'Past one-off',
        triggerGraph({
          kind: 'schedule',
          segmentId: segmentA,
          schedule: { type: 'once', at: '2020-01-01T00:00:00Z' },
        }),
      );
      const pA = await lifecycle(past.id, 'activate');
      expect(pA.status).toBe(422);
      expect(pA.body.error.code).toBe(ERROR_CODES.JOURNEY_GRAPH_INVALID);
      expect(pA.body.error.details.report.errors[0].code).toBe('SCHEDULE_ELAPSED');
      const still = await as(http().get(url(`${base()}/${past.id}`)));
      expect(still.body.data).toMatchObject({
        status: 'draft',
        trigger: null,
        activeVersionId: null,
      });
    });

    it('J-S5: activation requires messages.send; a send node is refused (JOURNEY_SEND_DISABLED); referential re-validation', async () => {
      const j = await published('No send right', apiGraph());
      const denied = await lifecycle(j.id, 'activate', tokenNoSend);
      expect(denied.status).toBe(403);
      const unchanged = await as(http().get(url(`${base()}/${j.id}`)));
      expect(unchanged.body.data.status).toBe('draft');

      const sender = await published('Sender', {
        schemaVersion: 1,
        entry: 'start',
        nodes: {
          start: { type: 'entry', trigger: { kind: 'api' }, next: 'send' },
          send: {
            type: 'send_message',
            channel: 'whatsapp',
            templateId: waTemplate,
            variables: {},
            onSuppressed: 'continue',
            onRefused: 'exit',
            next: 'done',
          },
          done: { type: 'exit' },
        },
      });
      const refused = await lifecycle(sender.id, 'activate');
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe(ERROR_CODES.JOURNEY_SEND_DISABLED);
      expect((await as(http().get(url(`${base()}/${sender.id}`)))).body.data.status).toBe('draft');

      // The segment a published schedule names was deleted since: activation re-validates.
      const seg = (
        await h.admin
          .insert(schema.segments)
          .values({
            orgId: A.orgId,
            workspaceId: A.workspaceId,
            name: `s-${uuidv7()}`,
            criteria: {},
          })
          .returning({ id: schema.segments.id })
      )[0]!.id;
      const sched = await published(
        'Revalidated',
        triggerGraph({
          kind: 'schedule',
          segmentId: seg,
          schedule: { type: 'once', at: '2099-01-01T00:00:00Z' },
        }),
      );
      await h.admin.execute(sql`UPDATE segments SET deleted_at = now() WHERE id = ${seg}`);
      const stale = await lifecycle(sched.id, 'activate');
      expect(stale.status).toBe(422);
      expect(stale.body.error.details.report.errors[0].code).toBe('SEGMENT_NOT_FOUND');
    });

    it('pause, resume and invalid transitions; enrolment refused while paused; archive is terminal', async () => {
      const j = await published('Pausable', apiGraph());
      expect((await lifecycle(j.id, 'pause')).status).toBe(409); // draft
      expect((await lifecycle(j.id, 'resume')).status).toBe(409); // draft
      await lifecycle(j.id, 'activate');

      const paused = await lifecycle(j.id, 'pause');
      expect(paused.status).toBe(200);
      expect(paused.body.data).toMatchObject({ status: 'paused', trigger: { status: 'paused' } });
      expect((await lifecycle(j.id, 'pause')).status).toBe(200); // no-op
      expect((await lifecycle(j.id, 'activate')).status).toBe(409); // paused → activate refused
      const whilePaused = await enrol(j.id, [contactsA[0]!]);
      expect(whilePaused.status).toBe(409);
      expect(whilePaused.body.error.code).toBe(ERROR_CODES.JOURNEY_LIFECYCLE_CONFLICT);

      const resumed = await lifecycle(j.id, 'resume');
      expect(resumed.status).toBe(200);
      expect(resumed.body.data).toMatchObject({ status: 'active', trigger: { status: 'active' } });
      const resumeDenied = await lifecycle(j.id, 'pause').then(() =>
        lifecycle(j.id, 'resume', tokenNoSend),
      );
      expect(resumeDenied.status).toBe(403); // resume re-checks messages.send
      await lifecycle(j.id, 'resume');

      const archived = await lifecycle(j.id, 'archive');
      expect(archived.status).toBe(200);
      expect(archived.body.data).toMatchObject({ status: 'archived', trigger: null });
      expect((await lifecycle(j.id, 'archive')).status).toBe(200); // no-op
      for (const action of ['activate', 'pause', 'resume'])
        expect((await lifecycle(j.id, action)).status).toBe(409);
      expect(await audits(j.id)).toEqual([
        'journey.created',
        'journey.graph_updated',
        'journey.version_published',
        'journey.activated',
        'journey.paused',
        'journey.resumed',
        'journey.paused',
        'journey.resumed',
        'journey.archived',
      ]);
      // A draft can be archived directly.
      const d = await published('Draft archive', apiGraph());
      expect((await lifecycle(d.id, 'archive')).body.data.status).toBe('archived');
    });

    it('journeys.manage is required for lifecycle operations (journeys.read alone is 403)', async () => {
      const j = await published('Read only', apiGraph());
      for (const action of ['activate', 'pause', 'resume', 'archive'])
        expect((await lifecycle(j.id, action, tokenReadOnly)).status).toBe(403);
    });
  });

  describe('API enrolment', () => {
    it('enrols live contacts of the workspace once; reports unknown and foreign ids; positions after entry; nothing runs or sends', async () => {
      const j = await published('Enrol', apiGraph());
      await lifecycle(j.id, 'activate');

      const missingKey = await enrol(j.id, [contactsA[0]!], null);
      expect(missingKey.status).toBe(400);
      expect(missingKey.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED);
      const tooMany = await enrol(
        j.id,
        Array.from({ length: 1001 }, () => uuidv7()),
      );
      expect(tooMany.status).toBe(400);
      const dupes = await enrol(j.id, [contactsA[0]!, contactsA[0]!]);
      expect(dupes.status).toBe(400);

      const unknown = uuidv7();
      const k = key();
      const res = await enrol(
        j.id,
        [contactsA[0]!, contactsA[1]!, contactWs2, contactB, unknown],
        k,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        journeyId: j.id,
        journeyVersionId: j.versionId,
        enrolled: 2,
        alreadyEnrolled: 0,
        contactNotFound: 3,
      });
      expect(res.body.data.results.map((r: { outcome: string }) => r.outcome)).toEqual([
        'enrolled',
        'enrolled',
        'contact_not_found',
        'contact_not_found',
        'contact_not_found',
      ]);
      const execId = res.body.data.results[0].executionId as string;

      const detail = await as(http().get(url(`${base()}/${j.id}/executions/${execId}`)));
      expect(detail.status).toBe(200);
      expect(detail.body.data).toMatchObject({
        status: 'running',
        currentNodeKey: 'pause',
        stateVersion: 1,
        transitions: 1,
        entryKind: 'api',
        enrolledBy: A.userId,
        contactId: contactsA[0],
        journeyVersionId: j.versionId,
        endedAt: null,
      });
      expect(detail.body.data.steps).toEqual([
        expect.objectContaining({
          seq: 1,
          nodeKey: 'start',
          nodeType: 'entry',
          outcome: 'entered',
          details: { entryKind: 'api' },
          messageId: null,
        }),
      ]);
      const [row] = (
        await h.admin.execute<{ entry_ref: string }>(
          sql`SELECT entry_ref FROM journey_executions WHERE id = ${execId}`,
        )
      ).rows;
      expect(row!.entry_ref).toBe(apiEntryRef(A.orgId, j.id, k));
      expect(row!.entry_ref).not.toContain(k);

      // The queue row exists and is unclaimed; nothing was sent or dispatched.
      const queue = await h.admin.execute<{ claim_token: string | null; epoch: number }>(
        sql`SELECT claim_token, epoch FROM journey_execution_queue WHERE execution_id = ${execId}`,
      );
      expect(queue.rows).toEqual([{ claim_token: null, epoch: 0 }]);
      expect(
        await count(
          sql`SELECT ((SELECT count(*) FROM messages WHERE org_id = ${A.orgId}) + (SELECT count(*) FROM message_dispatch_queue WHERE org_id = ${A.orgId}))::text AS n`,
        ),
      ).toBe(0);

      // Entry policy `once`: a second key does not enrol the same contact again.
      const second = await enrol(j.id, [contactsA[0]!, contactsA[2]!]);
      expect(second.body.data.results).toEqual([
        { contactId: contactsA[0], outcome: 'already_enrolled', executionId: execId },
        expect.objectContaining({ contactId: contactsA[2], outcome: 'enrolled' }),
      ]);
      expect(await audits(j.id)).toEqual(
        expect.arrayContaining(['journey.enrolled', 'journey.enrolled']),
      );
    });

    it('J-C6: a replay with the same key returns the same response and enrols nothing; a different body is 422', async () => {
      const j = await published('Replay', apiGraph());
      await lifecycle(j.id, 'activate');
      const k = key();
      const first = await enrol(j.id, [contactsA[3]!, contactsA[4]!], k);
      expect(first.status).toBe(200);
      const replay = await enrol(j.id, [contactsA[3]!, contactsA[4]!], k);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      const mismatch = await enrol(j.id, [contactsA[3]!], k);
      expect(mismatch.status).toBe(422);
      expect(
        await count(
          sql`SELECT count(*)::text AS n FROM journey_executions WHERE journey_id = ${j.id}`,
        ),
      ).toBe(2);
      expect((await audits(j.id)).filter((a) => a === 'journey.enrolled')).toHaveLength(1);
    });

    it('concurrent enrolments of one contact under different keys create exactly one execution', async () => {
      const j = await published('Race', apiGraph());
      await lifecycle(j.id, 'activate');
      const target = contactsA[5]!;
      const responses = await Promise.all(Array.from({ length: 6 }, () => enrol(j.id, [target])));
      expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      const outcomes = responses.map((r) => r.body.data.results[0].outcome).sort();
      expect(outcomes).toEqual([
        'already_enrolled',
        'already_enrolled',
        'already_enrolled',
        'already_enrolled',
        'already_enrolled',
        'enrolled',
      ]);
      expect(
        await count(
          sql`SELECT count(*)::text AS n FROM journey_executions WHERE journey_id = ${j.id}`,
        ),
      ).toBe(1);
      expect(
        await count(
          sql`SELECT count(*)::text AS n FROM journey_execution_queue q JOIN journey_executions e ON e.id = q.execution_id WHERE e.journey_id = ${j.id}`,
        ),
      ).toBe(1);
    });

    it('refuses journeys entered by an event or schedule trigger, inactive journeys, and callers without journeys.manage', async () => {
      const ev = await published(
        'Event only',
        triggerGraph({ kind: 'event', event: 'contact.created' }),
      );
      await lifecycle(ev.id, 'activate');
      const notApi = await enrol(ev.id, [contactsA[0]!]);
      expect(notApi.status).toBe(409);
      expect(notApi.body.error.code).toBe(ERROR_CODES.JOURNEY_TRIGGER_NOT_API);

      const draft = await published('Not active', apiGraph());
      const inactive = await enrol(draft.id, [contactsA[0]!]);
      expect(inactive.status).toBe(409);
      expect(inactive.body.error.code).toBe(ERROR_CODES.JOURNEY_LIFECYCLE_CONFLICT);

      expect((await enrol(draft.id, [contactsA[0]!], key(), tokenReadOnly)).status).toBe(403);
    });
  });

  describe('versioning while active (J-V1 at the data level)', () => {
    it('publishing while active promotes the new version for new enrolments; in-flight executions keep theirs', async () => {
      const j = await published('Promote', apiGraph());
      await lifecycle(j.id, 'activate');
      const onV1 = (await enrol(j.id, [contactsA[6]!])).body.data.results[0].executionId as string;

      const v2 = await newDraft(j.id);
      const pub = await publishDraft(j.id, v2, apiGraph(120));
      expect(pub.status).toBe(200);
      const journey = (await as(http().get(url(`${base()}/${j.id}`)))).body.data;
      expect(journey).toMatchObject({
        status: 'active',
        activeVersionId: v2.id,
        trigger: { journeyVersionId: v2.id, status: 'active' },
      });
      const triggers = await h.admin.execute<{ v: string; status: string }>(
        sql`SELECT journey_version_id AS v, status FROM journey_triggers WHERE journey_id = ${j.id} ORDER BY created_at`,
      );
      expect(triggers.rows).toEqual([
        { v: j.versionId, status: 'retired' },
        { v: v2.id, status: 'active' },
      ]);
      const onV2 = await enrol(j.id, [contactsA[7]!]);
      expect(onV2.body.data.journeyVersionId).toBe(v2.id);
      const v1Exec = (await as(http().get(url(`${base()}/${j.id}/executions/${onV1}`)))).body.data;
      expect(v1Exec).toMatchObject({ journeyVersionId: j.versionId, status: 'running' });

      // Promotion applies the activation rules: a send node is refused and the draft stays a draft.
      const v3 = await newDraft(j.id);
      const sendPub = await publishDraft(j.id, v3, {
        schemaVersion: 1,
        entry: 'start',
        nodes: {
          start: { type: 'entry', trigger: { kind: 'api' }, next: 'send' },
          send: {
            type: 'send_message',
            channel: 'whatsapp',
            templateId: waTemplate,
            variables: {},
            onSuppressed: 'continue',
            onRefused: 'exit',
            next: 'done',
          },
          done: { type: 'exit' },
        },
      });
      expect(sendPub.status).toBe(400);
      expect(sendPub.body.error.code).toBe(ERROR_CODES.JOURNEY_SEND_DISABLED);
      const v3Now = await as(http().get(url(`${base()}/${j.id}/versions/${v3.id}`)));
      expect(v3Now.body.data.status).toBe('draft');

      // While paused, a published version is promoted with a paused trigger.
      await lifecycle(j.id, 'pause');
      const v3Pub = await publishDraft(
        j.id,
        { id: v3.id, graphSha256: v3Now.body.data.graphSha256 },
        apiGraph(300),
      );
      expect(v3Pub.status).toBe(200);
      const pausedJ = (await as(http().get(url(`${base()}/${j.id}`)))).body.data;
      expect(pausedJ).toMatchObject({
        status: 'paused',
        activeVersionId: v3.id,
        trigger: { journeyVersionId: v3.id, status: 'paused' },
      });
    });
  });

  describe('executions: reads, isolation, cancel, archive, statistics', () => {
    let j: { id: string; versionId: string };
    let execs: string[];

    beforeAll(async () => {
      j = await published('Executions', apiGraph());
      await lifecycle(j.id, 'activate');
      const r = await enrol(j.id, [contactsA[8]!, contactsA[9]!, contactsA[10]!]);
      execs = r.body.data.results.map((x: { executionId: string }) => x.executionId);
    });

    it('lists newest first with keyset paging and filters', async () => {
      const newestFirst = [...execs].sort().reverse();
      const page1 = await as(http().get(url(`${base()}/${j.id}/executions?limit=2`)));
      expect(page1.status).toBe(200);
      expect(page1.body.data.map((e: { id: string }) => e.id)).toEqual(newestFirst.slice(0, 2));
      const page2 = await as(
        http().get(
          url(
            `${base()}/${j.id}/executions?limit=2&cursor=${encodeURIComponent(page1.body.page.nextCursor)}`,
          ),
        ),
      );
      expect(page2.body.data.map((e: { id: string }) => e.id)).toEqual(newestFirst.slice(2));
      const byContact = await as(
        http().get(url(`${base()}/${j.id}/executions?contactId=${contactsA[9]}`)),
      );
      expect(byContact.body.data.map((e: { id: string }) => e.id)).toEqual([execs[1]]);
      const cancelled = await as(http().get(url(`${base()}/${j.id}/executions?status=cancelled`)));
      expect(cancelled.body.data).toEqual([]);
    });

    it('J-S3: other workspaces, other organisations and other journeys see 404', async () => {
      const id = execs[0]!;
      expect((await as(http().get(url(`${base(ws2A)}/${j.id}/executions/${id}`)))).status).toBe(
        404,
      );
      expect((await as(http().get(url(`${base(ws2A)}/${j.id}/executions`)))).status).toBe(404);
      const foreign = await as(http().get(url(`${base()}/${j.id}/executions/${id}`)), tokenB);
      expect(foreign.status).toBe(404);
      const ownWs = await as(
        http().get(url(`${base(B.workspaceId)}/${j.id}/executions/${id}`)),
        tokenB,
      );
      expect(ownWs.status).toBe(404);
      const cancelForeign = await as(
        http().post(url(`${base(B.workspaceId)}/${j.id}/executions/${id}/cancel`)),
        tokenB,
      );
      expect(cancelForeign.status).toBe(404);
      const enrolForeign = await as(
        http().post(url(`${base(B.workspaceId)}/${j.id}/enrollments`)),
        tokenB,
      )
        .set('idempotency-key', key())
        .send({ contactIds: [contactB] });
      expect(enrolForeign.status).toBe(404);
      const statsForeign = await as(
        http().get(url(`${base(B.workspaceId)}/${j.id}/stats`)),
        tokenB,
      );
      expect(statsForeign.status).toBe(404);
      const other = await published('Other journey', apiGraph());
      const wrongJourney = await as(http().get(url(`${base()}/${other.id}/executions/${id}`)));
      expect(wrongJourney.status).toBe(404);
      expect(wrongJourney.body.error.code).toBe(ERROR_CODES.JOURNEY_EXECUTION_NOT_FOUND);
    });

    it('operator cancel: fenced transition, history row, queue row removed; a repeat is a no-op; read-only is 403', async () => {
      const id = execs[0]!;
      const cancelUrl = url(`${base()}/${j.id}/executions/${id}/cancel`);
      expect((await as(http().post(cancelUrl), tokenReadOnly)).status).toBe(403);
      const [a, b] = await Promise.all([as(http().post(cancelUrl)), as(http().post(cancelUrl))]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const res = a.body.data.stateVersion === 2 ? a : b;
      expect(res.body.data).toMatchObject({
        status: 'cancelled',
        endReason: 'operator_cancelled',
        stateVersion: 2,
        currentNodeKey: 'pause',
      });
      expect(res.body.data.endedAt).not.toBeNull();
      expect(
        res.body.data.steps.map((s: { seq: number; outcome: string; nodeType: string }) => [
          s.seq,
          s.outcome,
          s.nodeType,
        ]),
      ).toEqual([
        [1, 'entered', 'entry'],
        [2, 'cancelled', 'wait_duration'],
      ]);
      expect(
        await count(
          sql`SELECT count(*)::text AS n FROM journey_execution_queue WHERE execution_id = ${id}`,
        ),
      ).toBe(0);
      expect(
        await count(
          sql`SELECT count(*)::text AS n FROM journey_execution_steps WHERE execution_id = ${id}`,
        ),
      ).toBe(2);
      expect((await audits(j.id)).filter((x) => x === 'journey.execution_cancelled')).toHaveLength(
        1,
      );
      // Once cancelled the contact does not re-enter (entry policy `once`).
      const again = await enrol(j.id, [contactsA[8]!]);
      expect(again.body.data.results[0]).toMatchObject({
        outcome: 'already_enrolled',
        executionId: id,
      });
    });

    it('statistics per version and node', async () => {
      const stats = await as(http().get(url(`${base()}/${j.id}/stats`)));
      expect(stats.status).toBe(200);
      expect(stats.body.data.journeyId).toBe(j.id);
      expect(stats.body.data.versions).toHaveLength(1);
      const v = stats.body.data.versions[0];
      expect(v).toMatchObject({ versionId: j.versionId, versionNumber: 1 });
      expect(v.executions).toEqual({
        running: 2,
        waiting: 0,
        completed: 0,
        exited: 0,
        failed: 0,
        cancelled: 1,
        total: 3,
      });
      expect(v.nodes).toEqual([
        { nodeKey: 'start', nodeType: 'entry', running: 0, waiting: 0, outcomes: { entered: 3 } },
        {
          nodeKey: 'pause',
          nodeType: 'wait_duration',
          running: 2,
          waiting: 0,
          outcomes: { cancelled: 1 },
        },
        { nodeKey: 'done', nodeType: 'exit', running: 0, waiting: 0, outcomes: {} },
      ]);
      const narrowed = await as(
        http().get(url(`${base()}/${j.id}/stats?versionId=${j.versionId}`)),
      );
      expect(narrowed.body.data.versions).toHaveLength(1);
      const unknown = await as(http().get(url(`${base()}/${j.id}/stats?versionId=${uuidv7()}`)));
      expect(unknown.status).toBe(404);
    });

    it('archive ends every live execution as cancelled (journey_archived) and empties their queue rows', async () => {
      const archived = await lifecycle(j.id, 'archive');
      expect(archived.status).toBe(200);
      expect(archived.body.data.trigger).toBeNull();
      const rows = await h.admin.execute<{
        status: string;
        end_reason: string;
        state_version: number;
      }>(
        sql`SELECT status, end_reason, state_version FROM journey_executions WHERE journey_id = ${j.id} ORDER BY end_reason DESC, id`,
      );
      expect(rows.rows).toEqual([
        { status: 'cancelled', end_reason: 'operator_cancelled', state_version: 2 },
        { status: 'cancelled', end_reason: 'journey_archived', state_version: 2 },
        { status: 'cancelled', end_reason: 'journey_archived', state_version: 2 },
      ]);
      expect(
        await count(
          sql`SELECT count(*)::text AS n FROM journey_execution_queue q JOIN journey_executions e ON e.id = q.execution_id WHERE e.journey_id = ${j.id}`,
        ),
      ).toBe(0);
      expect(
        await count(
          sql`SELECT count(*)::text AS n FROM journey_execution_steps s JOIN journey_executions e ON e.id = s.execution_id WHERE e.journey_id = ${j.id} AND s.outcome = 'cancelled' AND s.details->>'reason' = 'journey_archived'`,
        ),
      ).toBe(2);
      const auditRow = await h.admin.execute<{ metadata: { cancelledExecutions: number } }>(
        sql`SELECT metadata FROM audit_logs WHERE resource_id = ${j.id} AND action = 'journey.archived'`,
      );
      expect(auditRow.rows[0]!.metadata.cancelledExecutions).toBe(2);
      const cancelAfter = await as(
        http().post(url(`${base()}/${j.id}/executions/${execs[1]}/cancel`)),
      );
      expect(cancelAfter.status).toBe(200); // already cancelled: no-op
      expect((await enrol(j.id, [contactsA[11]!])).status).toBe(409);
    });
  });

  describe('database guards (0063)', () => {
    let j: { id: string; versionId: string };
    let exec: string;

    beforeAll(async () => {
      j = await published('Guards', apiGraph());
      await lifecycle(j.id, 'activate');
      exec = (await enrol(j.id, [contactsA[11]!])).body.data.results[0].executionId;
    });

    it('step history is append-only', async () => {
      expect(
        await pgMessage(
          h.admin.execute(
            sql`UPDATE journey_execution_steps SET outcome = 'failed' WHERE execution_id = ${exec}`,
          ),
        ),
      ).toMatch(/append-only/);
      expect(
        await pgMessage(
          h.admin.execute(sql`DELETE FROM journey_execution_steps WHERE execution_id = ${exec}`),
        ),
      ).toMatch(/append-only/);
      expect(
        await pgMessage(
          h.admin.execute(
            sql`INSERT INTO journey_execution_steps (org_id, workspace_id, execution_id, seq, node_key, node_type, outcome) VALUES (${A.orgId}, ${A.workspaceId}, ${exec}, 1, 'start', 'entry', 'entered')`,
          ),
        ),
      ).toMatch(/uq_journey_execution_steps_seq/);
    });

    it('executions: identity immutable, state_version monotonic, no deletes, one live per contact, contact in the same workspace', async () => {
      expect(
        await pgMessage(
          h.admin.execute(
            sql`UPDATE journey_executions SET contact_id = ${contactsA[0]} WHERE id = ${exec}`,
          ),
        ),
      ).toMatch(/identity is immutable/);
      expect(
        await pgMessage(
          h.admin.execute(sql`UPDATE journey_executions SET state_version = 0 WHERE id = ${exec}`),
        ),
      ).toMatch(/cannot move backwards/);
      expect(
        await pgMessage(h.admin.execute(sql`DELETE FROM journey_executions WHERE id = ${exec}`)),
      ).toMatch(/never deleted/);
      const insert = (contactId: string, ws: string, ref: string) =>
        h.admin.execute(
          sql`INSERT INTO journey_executions (org_id, workspace_id, journey_id, journey_version_id, contact_id, current_node_key, entry_kind, entry_ref)
              VALUES (${A.orgId}, ${ws}, ${j.id}, ${j.versionId}, ${contactId}, 'pause', 'api', ${ref})`,
        );
      expect(await pgMessage(insert(contactsA[11]!, A.workspaceId, 'other-ref'))).toMatch(
        /uq_journey_executions_live_contact/,
      );
      expect(await pgMessage(insert(contactWs2, ws2A, 'x'))).toMatch(
        /journey_executions_journey_fk/,
      );
      expect(await pgMessage(insert(contactWs2, A.workspaceId, 'y'))).toMatch(
        /journey_executions_contact_fk/,
      );
    });

    it('an ended execution never changes', async () => {
      await as(http().post(url(`${base()}/${j.id}/executions/${exec}/cancel`)));
      expect(
        await pgMessage(
          h.admin.execute(
            sql`UPDATE journey_executions SET status = 'running', ended_at = NULL, end_reason = NULL WHERE id = ${exec}`,
          ),
        ),
      ).toMatch(/has ended/);
    });

    it('journeys: the lifecycle guard refuses invalid transitions and a non-published active version', async () => {
      expect(
        await pgMessage(
          h.admin.execute(sql`UPDATE journeys SET status = 'draft' WHERE id = ${j.id}`),
        ),
      ).toMatch(/cannot move from active to draft/);
      const other = await published('Guard other', apiGraph());
      expect(
        await pgMessage(
          h.admin.execute(
            sql`UPDATE journeys SET active_version_id = ${other.versionId} WHERE id = ${j.id}`,
          ),
        ),
      ).toMatch(/journeys_active_version_fk/);
      const v2 = await newDraft(j.id);
      expect(
        await pgMessage(
          h.admin.execute(sql`UPDATE journeys SET active_version_id = ${v2.id} WHERE id = ${j.id}`),
        ),
      ).toMatch(/must be published/);
      expect(
        await pgMessage(
          h.admin.execute(sql`UPDATE journeys SET status = 'active' WHERE id = ${other.id}`),
        ),
      ).toMatch(/journeys_active_version_shape/);
      await lifecycle(j.id, 'archive');
      expect(
        await pgMessage(
          h.admin.execute(sql`UPDATE journeys SET status = 'active' WHERE id = ${j.id}`),
        ),
      ).toMatch(/cannot move from archived to active/);
    });

    it('RLS is enabled on every 0063 table, and another organisation reads none of these executions', async () => {
      // Through the API as tenant B: B's own lists are empty although A has executions.
      const bJourney = await published('B journey', apiGraph(), tokenB, B.workspaceId);
      const list = await as(
        http().get(url(`${base(B.workspaceId)}/${bJourney.id}/executions`)),
        tokenB,
      );
      expect(list.status).toBe(200);
      expect(list.body.data).toEqual([]);
      // The policy shapes themselves are pinned by the table-class and principal suites.
      const { rows } = await h.admin.execute<{ rls: boolean; relname: string }>(
        sql`SELECT relname, relrowsecurity AS rls FROM pg_class WHERE relname IN ('journey_triggers','journey_executions','journey_execution_queue','journey_execution_steps') ORDER BY relname`,
      );
      expect(rows).toEqual([
        { relname: 'journey_execution_queue', rls: true },
        { relname: 'journey_execution_steps', rls: true },
        { relname: 'journey_executions', rls: true },
        { relname: 'journey_triggers', rls: true },
      ]);
    });
  });
});
