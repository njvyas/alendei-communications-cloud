/**
 * Phase 8C PR 8C-1 — journey definitions (`docs/PHASE-8C-JOURNEYS-HANDOVER.md` §§5–7, §12).
 * Disposable clones only (`scripts/with-db-clone.mjs`).
 */
import { ERROR_CODES, PERMISSIONS, defaultJourneyGraph } from '@acc/contracts';
import { schema } from '@acc/db';
import { eq, sql } from 'drizzle-orm';
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
import { journeyGraphSha256 } from '../src/journeys/journeys.service';

const url = (p: string) => `/${PREFIX}${p}`;
const key = () => `journey-test-${uuidv7()}`;
/** The PostgreSQL message behind a Drizzle query error (Drizzle wraps it in `cause`). */
const pgMessage = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (error) {
    const e = error as { cause?: { message?: string }; message?: string };
    return String(e.cause?.message ?? e.message);
  }
  return 'NO ERROR';
};

describe('Phase 8C PR 8C-1: journey definitions', () => {
  let h: Harness;
  let A: TenantFixture;
  let B: TenantFixture;
  let tokenA: string;
  let tokenB: string;
  let ws2A: string;
  let waTemplate: string;
  let smsTemplate: string;
  let pendingTemplate: string;
  let segmentA: string;
  let segmentWs2: string;

  const grant = async (t: TenantFixture, suffix: string, permissions: string[]) => {
    const roleId = uuidv7();
    await h.admin.insert(schema.roles).values({
      id: roleId,
      orgId: t.orgId,
      key: `jrn_${suffix}_${t.slug.replace(/-/g, '_')}`,
      name: `Journeys ${suffix} ${t.slug}`,
      description: 'Journeys test role',
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
    await h.admin.insert(schema.userRoles).values({
      orgId: t.orgId,
      userId: t.userId,
      roleId,
      scopeType: 'organization',
      scopeId: t.orgId,
    });
  };

  const http = () => request(h.app.getHttpServer());
  const asA = <T extends request.Test>(r: T) => r.set('authorization', `Bearer ${tokenA}`);

  const createJourney = async (name: string, ws = A.workspaceId) => {
    const res = await asA(http().post(url(`/workspaces/${ws}/journeys`)))
      .set('idempotency-key', key())
      .send({ name });
    expect(res.status).toBe(201);
    return res.body.data as { id: string; draftVersion: { id: string; graphSha256: string } };
  };

  const putGraph = (journeyId: string, versionId: string, graph: unknown, sha: string) =>
    asA(
      http().put(
        url(`/workspaces/${A.workspaceId}/journeys/${journeyId}/versions/${versionId}/graph`),
      ),
    ).send({
      graph,
      expectedGraphSha256: sha,
    });

  const publish = (journeyId: string, versionId: string, sha: string, k: string | null = key()) => {
    const r = asA(
      http().post(
        url(`/workspaces/${A.workspaceId}/journeys/${journeyId}/versions/${versionId}/publish`),
      ),
    );
    if (k) r.set('idempotency-key', k);
    return r.send({ expectedGraphSha256: sha });
  };

  const sendGraph = (templateId: string, channel: string, variables: Record<string, unknown>) => ({
    schemaVersion: 1,
    entry: 'start',
    nodes: {
      start: { type: 'entry', trigger: { kind: 'api' }, next: 'send' },
      send: {
        type: 'send_message',
        channel,
        templateId,
        variables,
        onSuppressed: 'continue',
        onRefused: 'exit',
        next: 'seg',
      },
      seg: {
        type: 'condition',
        rule: { kind: 'segment', segmentId: segmentA, member: true },
        onTrue: 'hook',
        onFalse: 'done',
      },
      hook: { type: 'webhook', next: 'done' },
      done: { type: 'exit' },
    },
  });

  beforeAll(async () => {
    h = await startHarness();
    const credentials = h.app.get(CredentialService);
    A = await createTenant(h.admin, 'jrn-a', credentials);
    B = await createTenant(h.admin, 'jrn-b', credentials);
    await grant(A, 'all', [PERMISSIONS.JOURNEYS_READ, PERMISSIONS.JOURNEYS_MANAGE]);
    // Tenant B holds journeys.read only: enough to prove cross-tenant 404s, and a manage 403.
    await grant(B, 'read', [PERMISSIONS.JOURNEYS_READ]);
    const [ws2] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId: A.orgId, name: 'Second', slug: 'jrn-second' })
      .returning({ id: schema.workspaces.id });
    ws2A = ws2!.id;
    const channel = async (code: string) =>
      (
        await h.admin
          .select({ id: schema.channels.id })
          .from(schema.channels)
          .where(eq(schema.channels.code, code))
      )[0]!.id;
    const wa = await channel('whatsapp');
    const sms = await channel('sms');
    const tpl = async (channelId: string, body: string, approvalStatus: 'approved' | 'pending') =>
      (
        await h.admin
          .insert(schema.templates)
          .values({
            orgId: A.orgId,
            channelId,
            name: `t-${uuidv7()}`,
            body,
            variables: [],
            approvalStatus,
          })
          .returning({ id: schema.templates.id })
      )[0]!.id;
    waTemplate = await tpl(wa, 'Hello {{name}}', 'approved');
    smsTemplate = await tpl(sms, 'Code {{code}}', 'approved');
    pendingTemplate = await tpl(wa, 'Hi', 'pending');
    const seg = async (ws: string) =>
      (
        await h.admin
          .insert(schema.segments)
          .values({ orgId: A.orgId, workspaceId: ws, name: `s-${uuidv7()}`, criteria: {} })
          .returning({ id: schema.segments.id })
      )[0]!.id;
    segmentA = await seg(A.workspaceId);
    segmentWs2 = await seg(ws2A);
    const login = async (t: TenantFixture) =>
      (await http().post(url('/auth/login')).send({ email: t.email, password: PASSWORD })).body.data
        .accessToken as string;
    tokenA = await login(A);
    tokenB = await login(B);
  }, 60_000);

  afterAll(async () => {
    if (!h) return;
    for (const t of [A, B].filter(Boolean)) {
      // Versions are never deleted in production (trg_journey_versions_guard); teardown only.
      await h.admin.execute(
        sql`ALTER TABLE journey_versions DISABLE TRIGGER trg_journey_versions_guard`,
      );
      await h.admin.execute(sql`DELETE FROM journey_versions WHERE org_id = ${t.orgId}`);
      await h.admin.execute(
        sql`ALTER TABLE journey_versions ENABLE TRIGGER trg_journey_versions_guard`,
      );
      await h.admin.execute(sql`DELETE FROM journeys WHERE org_id = ${t.orgId}`);
      await h.admin.execute(sql`DELETE FROM segments WHERE org_id = ${t.orgId}`);
      await destroyTenant(h.admin, t);
    }
    await h.close();
  }, 60_000);

  describe('create, read, list, update, delete', () => {
    it('requires an Idempotency-Key, creates version 1 as the default draft, audits, and replays', async () => {
      const missing = await asA(http().post(url(`/workspaces/${A.workspaceId}/journeys`))).send({
        name: 'x',
      });
      expect(missing.status).toBe(400);
      expect(missing.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED);

      const k = key();
      const first = await asA(http().post(url(`/workspaces/${A.workspaceId}/journeys`)))
        .set('idempotency-key', k)
        .send({ name: 'Welcome series', description: 'Onboarding' });
      expect(first.status).toBe(201);
      const j = first.body.data;
      expect(j).toMatchObject({
        name: 'Welcome series',
        description: 'Onboarding',
        status: 'draft',
        latestPublishedVersion: null,
      });
      expect(j.draftVersion).toMatchObject({
        versionNumber: 1,
        status: 'draft',
        graphSha256: journeyGraphSha256(defaultJourneyGraph()),
      });

      const replay = await asA(http().post(url(`/workspaces/${A.workspaceId}/journeys`)))
        .set('idempotency-key', k)
        .send({ name: 'Welcome series', description: 'Onboarding' });
      expect(replay.status).toBe(201);
      expect(replay.body.data.id).toBe(j.id);
      const mismatch = await asA(http().post(url(`/workspaces/${A.workspaceId}/journeys`)))
        .set('idempotency-key', k)
        .send({ name: 'Other' });
      expect(mismatch.status).toBe(422);
      const [{ n }] = (
        await h.admin.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM journeys WHERE org_id = ${A.orgId} AND name = 'Welcome series'`,
        )
      ).rows as { n: string }[];
      expect(n).toBe('1');
      const audit = await h.admin.execute<{ action: string }>(
        sql`SELECT action FROM audit_logs WHERE org_id = ${A.orgId} AND resource_id = ${j.id}`,
      );
      expect(audit.rows.map((r) => r.action)).toEqual(['journey.created']);
    });

    it('reads, lists (status/query filters, keyset paging) and updates', async () => {
      const j1 = await createJourney('Alpha list');
      await createJourney('Beta list');
      const got = await asA(http().get(url(`/workspaces/${A.workspaceId}/journeys/${j1.id}`)));
      expect(got.status).toBe(200);
      expect(got.body.data.id).toBe(j1.id);

      const page1 = await asA(
        http().get(url(`/workspaces/${A.workspaceId}/journeys?query=list&limit=1`)),
      );
      expect(page1.body.data.map((x: { name: string }) => x.name)).toEqual(['Alpha list']);
      const page2 = await asA(
        http().get(
          url(
            `/workspaces/${A.workspaceId}/journeys?query=list&limit=1&cursor=${encodeURIComponent(page1.body.page.nextCursor)}`,
          ),
        ),
      );
      expect(page2.body.data.map((x: { name: string }) => x.name)).toEqual(['Beta list']);
      const drafts = await asA(
        http().get(url(`/workspaces/${A.workspaceId}/journeys?status=active`)),
      );
      expect(drafts.body.data).toEqual([]);
      const pct = await asA(http().get(url(`/workspaces/${A.workspaceId}/journeys?query=%25`)));
      expect(pct.body.data).toEqual([]); // `%` is matched literally

      const upd = await asA(
        http().patch(url(`/workspaces/${A.workspaceId}/journeys/${j1.id}`)),
      ).send({ name: 'Alpha renamed', description: null });
      expect(upd.status).toBe(200);
      expect(upd.body.data).toMatchObject({ name: 'Alpha renamed', description: null });
    });

    it('soft-deletes a draft journey; it is then 404', async () => {
      const j = await createJourney('To delete');
      const del = await asA(http().delete(url(`/workspaces/${A.workspaceId}/journeys/${j.id}`)));
      expect(del.status).toBe(204);
      const gone = await asA(http().get(url(`/workspaces/${A.workspaceId}/journeys/${j.id}`)));
      expect(gone.status).toBe(404);
      expect(gone.body.error.code).toBe(ERROR_CODES.JOURNEY_NOT_FOUND);
    });
  });

  describe('isolation and authorisation', () => {
    it('another workspace of the same organisation, and another organisation, see 404', async () => {
      const j = await createJourney('Isolated');
      const otherWs = await asA(http().get(url(`/workspaces/${ws2A}/journeys/${j.id}`)));
      expect(otherWs.status).toBe(404);
      const otherOrgPath = await http()
        .get(url(`/workspaces/${A.workspaceId}/journeys/${j.id}`))
        .set('authorization', `Bearer ${tokenB}`);
      expect(otherOrgPath.status).toBe(404);
      const ownWsForeignId = await http()
        .get(url(`/workspaces/${B.workspaceId}/journeys/${j.id}`))
        .set('authorization', `Bearer ${tokenB}`);
      expect(ownWsForeignId.status).toBe(404);
      const listB = await http()
        .get(url(`/workspaces/${B.workspaceId}/journeys`))
        .set('authorization', `Bearer ${tokenB}`);
      expect(listB.status).toBe(200);
      expect(listB.body.data).toEqual([]);
    });

    it('journeys.manage is required to create (journeys.read alone is 403)', async () => {
      const res = await http()
        .post(url(`/workspaces/${B.workspaceId}/journeys`))
        .set('authorization', `Bearer ${tokenB}`)
        .set('idempotency-key', key())
        .send({ name: 'nope' });
      expect(res.status).toBe(403);
    });
  });

  describe('drafts, validation and publication', () => {
    it('saves drafts with optimistic concurrency; refuses only unsaveable graphs', async () => {
      const j = await createJourney('Drafting');
      const v = j.draftVersion;
      const stale = await putGraph(j.id, v.id, defaultJourneyGraph(), 'f'.repeat(64));
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe(ERROR_CODES.JOURNEY_GRAPH_CONFLICT);

      const v2graph = { schemaVersion: 2, entry: 'a', nodes: {} };
      const unsaveable = await putGraph(j.id, v.id, v2graph, v.graphSha256);
      expect(unsaveable.status).toBe(422);
      expect(unsaveable.body.error.code).toBe(ERROR_CODES.JOURNEY_GRAPH_INVALID);

      // Structurally incomplete, but a v1 object: a draft may hold it.
      const wip = {
        schemaVersion: 1,
        entry: 'start',
        nodes: { start: { type: 'entry', trigger: { kind: 'api' } } },
      };
      const saved = await putGraph(j.id, v.id, wip, v.graphSha256);
      expect(saved.status).toBe(200);
      expect(saved.body.data.graphSha256).toBe(journeyGraphSha256(wip));
      expect(saved.body.data.graph).toEqual(wip);

      const report = await asA(
        http().post(url(`/workspaces/${A.workspaceId}/journeys/${j.id}/versions/${v.id}/validate`)),
      );
      expect(report.status).toBe(200);
      expect(report.body.data.valid).toBe(false);
      expect(report.body.data.errors.map((e: { code: string }) => e.code)).toContain(
        'EDGE_MISSING',
      );

      const refused = await publish(j.id, v.id, saved.body.data.graphSha256);
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe(ERROR_CODES.JOURNEY_GRAPH_INVALID);
      expect(refused.body.error.details.report.valid).toBe(false);
    });

    it('referential validation: templates (approval, channel, variables) and segments (this workspace)', async () => {
      const j = await createJourney('Referential');
      const v = j.draftVersion;
      const bad = sendGraph(pendingTemplate, 'sms', { extra: { source: 'literal', value: 'x' } });
      (bad.nodes.seg.rule as { segmentId: string }).segmentId = segmentWs2;
      const saved = await putGraph(j.id, v.id, bad, v.graphSha256);
      expect(saved.status).toBe(200);
      const report = (
        await asA(
          http().post(
            url(`/workspaces/${A.workspaceId}/journeys/${j.id}/versions/${v.id}/validate`),
          ),
        )
      ).body.data;
      expect(report.errors.map((e: { code: string }) => e.code).sort()).toEqual(
        ['SEGMENT_NOT_FOUND', 'TEMPLATE_CHANNEL_MISMATCH', 'TEMPLATE_NOT_APPROVED'].sort(),
      );
      expect(report.warnings.map((w: { code: string }) => w.code).sort()).toEqual([
        'PLACEHOLDER_NODE',
        'TEMPLATE_VARIABLE_UNKNOWN',
      ]);

      const unmapped = sendGraph(waTemplate, 'whatsapp', {});
      const s2 = await putGraph(j.id, v.id, unmapped, saved.body.data.graphSha256);
      const r2 = (
        await asA(
          http().post(
            url(`/workspaces/${A.workspaceId}/journeys/${j.id}/versions/${v.id}/validate`),
          ),
        )
      ).body.data;
      expect(r2.errors.map((e: { code: string; path: string }) => `${e.code}:${e.path}`)).toEqual([
        'TEMPLATE_VARIABLE_UNMAPPED:variables.name',
      ]);

      const foreign = sendGraph(uuidv7(), 'whatsapp', {});
      await putGraph(j.id, v.id, foreign, s2.body.data.graphSha256);
      const r3 = (
        await asA(
          http().post(
            url(`/workspaces/${A.workspaceId}/journeys/${j.id}/versions/${v.id}/validate`),
          ),
        )
      ).body.data;
      expect(r3.errors.map((e: { code: string }) => e.code)).toEqual(['TEMPLATE_NOT_FOUND']);
      void smsTemplate;
    });

    it('publishes a valid draft once, freezes it, and activates or sends nothing', async () => {
      const j = await createJourney('Publish me');
      const v = j.draftVersion;
      const graph = sendGraph(waTemplate, 'whatsapp', {
        name: { source: 'contact_field', field: 'firstName' },
      });
      const saved = await putGraph(j.id, v.id, graph, v.graphSha256);
      const sha = saved.body.data.graphSha256;

      const noKey = await publish(j.id, v.id, sha, null);
      expect(noKey.status).toBe(400);
      expect(noKey.body.error.code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED);
      const staleSha = await publish(j.id, v.id, v.graphSha256);
      expect(staleSha.status).toBe(409);

      const k = key();
      const ok = await publish(j.id, v.id, sha, k);
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({
        status: 'published',
        versionNumber: 1,
        graphSha256: sha,
      });
      expect(ok.body.data.publishedAt).not.toBeNull();
      const replay = await publish(j.id, v.id, sha, k);
      expect(replay.status).toBe(200);
      expect(replay.body.data.publishedAt).toBe(ok.body.data.publishedAt);

      const again = await publish(j.id, v.id, sha);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe(ERROR_CODES.JOURNEY_VERSION_IMMUTABLE);
      const edit = await putGraph(j.id, v.id, defaultJourneyGraph(), sha);
      expect(edit.status).toBe(409);
      expect(edit.body.error.code).toBe(ERROR_CODES.JOURNEY_VERSION_IMMUTABLE);

      const journey = (await asA(http().get(url(`/workspaces/${A.workspaceId}/journeys/${j.id}`))))
        .body.data;
      expect(journey.status).toBe('draft'); // publication activates nothing (activation is 8C-2)
      expect(journey.draftVersion).toBeNull();
      expect(journey.latestPublishedVersion.id).toBe(v.id);

      const counts = (
        await h.admin.execute<{ m: string; q: string }>(
          sql`SELECT (SELECT count(*) FROM messages WHERE org_id = ${A.orgId})::text AS m,
                     (SELECT count(*) FROM message_dispatch_queue WHERE org_id = ${A.orgId})::text AS q`,
        )
      ).rows[0]!;
      expect(counts).toEqual({ m: '0', q: '0' });
      const actions = await h.admin.execute<{ action: string }>(
        sql`SELECT action FROM audit_logs WHERE org_id = ${A.orgId} AND resource_id = ${j.id} ORDER BY created_at, id`,
      );
      expect(actions.rows.map((r) => r.action)).toEqual([
        'journey.created',
        'journey.graph_updated',
        'journey.version_published',
      ]);
    });

    it('new drafts copy the latest published version; one draft at a time, also under concurrency', async () => {
      const j = await createJourney('Versioned');
      const v1 = j.draftVersion;
      const early = await asA(
        http().post(url(`/workspaces/${A.workspaceId}/journeys/${j.id}/versions`)),
      ).set('idempotency-key', key());
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe(ERROR_CODES.JOURNEY_DRAFT_EXISTS);
      await publish(j.id, v1.id, v1.graphSha256);

      const [r1, r2] = await Promise.all(
        [key(), key()].map((k) =>
          asA(http().post(url(`/workspaces/${A.workspaceId}/journeys/${j.id}/versions`))).set(
            'idempotency-key',
            k,
          ),
        ),
      );
      expect([r1!.status, r2!.status].sort()).toEqual([201, 409]);
      const created = (r1!.status === 201 ? r1 : r2)!.body.data;
      expect(created).toMatchObject({
        versionNumber: 2,
        status: 'draft',
        graphSha256: v1.graphSha256,
      });

      const list = await asA(
        http().get(url(`/workspaces/${A.workspaceId}/journeys/${j.id}/versions`)),
      );
      expect(
        list.body.data.map(
          (x: { versionNumber: number; status: string }) => `${x.versionNumber}:${x.status}`,
        ),
      ).toEqual(['2:draft', '1:published']);
      const full = await asA(
        http().get(url(`/workspaces/${A.workspaceId}/journeys/${j.id}/versions/${v1.id}`)),
      );
      expect(full.body.data.graph).toEqual(defaultJourneyGraph());
    });
  });

  describe('database guards (trg_journey_versions_guard, constraints)', () => {
    it('a published version cannot change or be deleted; only retirement is allowed', async () => {
      const j = await createJourney('Guarded');
      const v = j.draftVersion;
      await publish(j.id, v.id, v.graphSha256);
      expect(
        await pgMessage(
          h.admin.execute(
            sql`UPDATE journey_versions SET graph = '{"x":1}'::jsonb WHERE id = ${v.id}`,
          ),
        ),
      ).toMatch(/immutable/);
      expect(
        await pgMessage(h.admin.execute(sql`DELETE FROM journey_versions WHERE id = ${v.id}`)),
      ).toMatch(/never deleted/);
      expect(
        await pgMessage(
          h.admin.execute(
            sql`UPDATE journey_versions SET status = 'draft', published_at = NULL WHERE id = ${v.id}`,
          ),
        ),
      ).toMatch(/immutable/);
      await h.admin.execute(sql`UPDATE journey_versions SET status = 'retired' WHERE id = ${v.id}`);
      expect(
        await pgMessage(
          h.admin.execute(sql`UPDATE journey_versions SET status = 'published' WHERE id = ${v.id}`),
        ),
      ).toMatch(/immutable/);
    });

    it('a draft cannot be retired, and its identity columns never change', async () => {
      const j = await createJourney('Draft guard');
      const v = j.draftVersion;
      expect(
        await pgMessage(
          h.admin.execute(
            sql`UPDATE journey_versions SET status = 'retired', published_at = now() WHERE id = ${v.id}`,
          ),
        ),
      ).toMatch(/cannot be retired/);
      expect(
        await pgMessage(
          h.admin.execute(sql`UPDATE journey_versions SET version_number = 9 WHERE id = ${v.id}`),
        ),
      ).toMatch(/identity is immutable/);
    });

    it('a version cannot name a journey of another workspace or organisation (composite FK)', async () => {
      const j = await createJourney('FK');
      expect(
        await pgMessage(
          h.admin.insert(schema.journeyVersions).values({
            orgId: B.orgId,
            workspaceId: B.workspaceId,
            journeyId: j.id,
            versionNumber: 5,
            status: 'published', // a draft would hit the one-draft index first
            publishedAt: new Date(),
            graphSchemaVersion: 1,
            graph: {},
            graphSha256: 'a'.repeat(64),
          }),
        ),
      ).toMatch(/journey_versions_journey_fk/);
    });
  });
});
