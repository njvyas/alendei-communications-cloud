/**
 * Phase 1B.4 advisory-identifier security suite (`TENANCY.md` §2b, ADR-004).
 *
 * A client-supplied organization, workspace or team identifier is advisory. The
 * authoritative context was resolved from the credential before the handler
 * ran; the identifier is only ever cross-checked against it. Every test here
 * asserts that one of the forbidden outcomes does not happen:
 *
 *   - the supplied identifier is silently substituted for the resolved one;
 *   - the mismatch is hidden behind an empty `200`;
 *   - the check is skipped because the parameter arrived in an odd shape.
 *
 * Everything runs over real HTTP against the real application, with the real
 * guard, because that is the surface an attacker reaches.
 */
import { ERROR_CODES } from '@acc/contracts';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { AdvisoryProbeController } from './advisory-probe.controller';
import {
  PASSWORD,
  PREFIX,
  createScopedUser,
  createTenant,
  destroyTenant,
  destroyUser,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (path: string) => `/${PREFIX}${path}`;

describe('Phase 1B.4 advisory tenant identifiers', () => {
  let h: Harness;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  let workspaceUser: { userId: string; email: string };
  let teamUser: { userId: string; email: string };

  const login = (email: string) =>
    request(h.app.getHttpServer()).post(url('/auth/login')).send({ email, password: PASSWORD });

  const tokenFor = async (email: string): Promise<string> => {
    const res = await login(email).expect(200);
    return (res.body as { accessToken: string }).accessToken;
  };

  const get = (path: string, token: string) =>
    request(h.app.getHttpServer()).get(url(path)).set('authorization', `Bearer ${token}`);

  beforeAll(async () => {
    h = await startHarness({ controllers: [AdvisoryProbeController] });
    const credentials = h.app.get(CredentialService);
    orgA = await createTenant(h.admin, 'adv-a', credentials);
    orgB = await createTenant(h.admin, 'adv-b', credentials);

    // Principals whose *only* grant sits below organization level. These are
    // the ones whose resolved context pins a workspace or a team, and therefore
    // the only ones against which those levels can be cross-checked.
    workspaceUser = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'workspace',
      orgA.workspaceId,
      'adv-ws',
    );
    teamUser = await createScopedUser(h.admin, orgA, credentials, 'team', orgA.teamId, 'adv-team');
  }, 60_000);

  afterAll(async () => {
    await destroyUser(h.admin, workspaceUser.userId);
    await destroyUser(h.admin, teamUser.userId);
    for (const t of [orgA, orgB]) await destroyTenant(h.admin, t);
    await h.close();
  }, 60_000);

  afterEach(() => purgeAudit(h.admin, sql`true`));
  beforeEach(() => h.clearRateLimits());

  // ---------------------------------------------------------------------------
  describe('organization identifier', () => {
    it('accepts the identifier that matches the resolved context', async () => {
      const token = await tokenFor(orgA.email);
      const res = await get(`/test-advisory/organization?orgId=${orgA.orgId}`, token).expect(200);
      expect(res.body.reached).toBe(true);
    });

    it("refuses another tenant's organization identifier", async () => {
      const token = await tokenFor(orgA.email);
      const res = await get(`/test-advisory/organization?orgId=${orgB.orgId}`, token).expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
      // Refused, never substituted and never emptied — the handler is a no-op,
      // so a body here would mean the request ran under some organization.
      expect(res.body).not.toHaveProperty('reached');
    });

    it('refuses an organization identifier that exists nowhere, identically', async () => {
      // A mismatch and a non-existent identifier must be indistinguishable, or
      // the endpoint becomes an existence oracle.
      const token = await tokenFor(orgA.email);
      const unknown = await get(`/test-advisory/organization?orgId=${uuidv7()}`, token).expect(403);
      const other = await get(`/test-advisory/organization?orgId=${orgB.orgId}`, token).expect(403);
      expect(unknown.body.error.code).toBe(other.body.error.code);
      expect(unknown.body.error.message).toBe(other.body.error.message);
    });

    it('never echoes the supplied identifier back', async () => {
      const token = await tokenFor(orgA.email);
      const res = await get(`/test-advisory/organization?orgId=${orgB.orgId}`, token).expect(403);
      expect(JSON.stringify(res.body)).not.toContain(orgB.orgId);
    });

    it('passes when an optional identifier is absent', async () => {
      const token = await tokenFor(orgA.email);
      await get('/test-advisory/organization', token).expect(200);
    });

    it('requires an identifier the handler declares as required', async () => {
      const token = await tokenFor(orgA.email);
      const res = await get('/test-advisory/organization-required', token).expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_REQUIRED);
    });

    it('cross-checks a path parameter as well as a query parameter', async () => {
      const token = await tokenFor(orgA.email);
      await get(`/test-advisory/path/${orgA.orgId}`, token).expect(200);
      const res = await get(`/test-advisory/path/${orgB.orgId}`, token).expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
    });

    it('cross-checks a body field as well', async () => {
      const token = await tokenFor(orgA.email);
      const server = h.app.getHttpServer();
      await request(server)
        .post(url('/test-advisory/body'))
        .set('authorization', `Bearer ${token}`)
        .send({ orgId: orgA.orgId })
        .expect(201);
      const res = await request(server)
        .post(url('/test-advisory/body'))
        .set('authorization', `Bearer ${token}`)
        .send({ orgId: orgB.orgId })
        .expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
    });

    it('leaves an undeclared parameter alone', async () => {
      // The mechanism is opt-in per handler. A parameter no handler declared is
      // not a tenant identifier, and is not silently policed as one.
      const token = await tokenFor(orgA.email);
      await get(`/test-advisory/undeclared?orgId=${orgB.orgId}`, token).expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('workspace identifier', () => {
    it('accepts the workspace the resolved context pins', async () => {
      const token = await tokenFor(workspaceUser.email);
      await get(`/test-advisory/workspace?workspaceId=${orgA.workspaceId}`, token).expect(200);
    });

    it("refuses another tenant's workspace identifier", async () => {
      const token = await tokenFor(workspaceUser.email);
      const res = await get(
        `/test-advisory/workspace?workspaceId=${orgB.workspaceId}`,
        token,
      ).expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
      expect(res.body).not.toHaveProperty('reached');
    });

    it('defers to the layers that can answer it for an organization-scoped principal', async () => {
      // An organization grant covers every workspace beneath it, so this
      // mechanism has nothing to contradict — deciding it here would mean
      // loading tenancy rows, which is the resolver it must not become. The
      // narrowing is decided by target-scope authorization and RLS instead,
      // asserted by the `404`-not-`403` case in the Phase 1B.3 suite.
      const token = await tokenFor(orgA.email);
      await get(`/test-advisory/workspace?workspaceId=${orgA.workspaceId}`, token).expect(200);
      await get(`/test-advisory/workspace?workspaceId=${orgB.workspaceId}`, token).expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('team identifier', () => {
    it('accepts the team the resolved context pins', async () => {
      const token = await tokenFor(teamUser.email);
      await get(`/test-advisory/team?teamId=${orgA.teamId}`, token).expect(200);
    });

    it("refuses another tenant's team identifier", async () => {
      const token = await tokenFor(teamUser.email);
      const res = await get(`/test-advisory/team?teamId=${orgB.teamId}`, token).expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
    });

    it('refuses a sibling team in the principal’s own organization', async () => {
      // Horizontal isolation below the organization, where RLS carries no term
      // at all (`TENANCY.md` §3a) — the application layer is the whole defence.
      const [sibling] = await h.admin
        .execute<{ id: string }>(
          sql`INSERT INTO teams (org_id, workspace_id, name) VALUES (${orgA.orgId}, ${orgA.workspaceId}, 'Sibling') RETURNING id`,
        )
        .then((r) => r.rows);
      try {
        const token = await tokenFor(teamUser.email);
        const res = await get(`/test-advisory/team?teamId=${sibling!.id}`, token).expect(403);
        expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
      } finally {
        await h.admin.execute(sql`DELETE FROM teams WHERE id = ${sibling!.id}`);
      }
    });

    it('pins the workspace of a team-scoped principal to the team’s own workspace', async () => {
      // The workspace is derived from the team grant, never supplied.
      const token = await tokenFor(teamUser.email);
      await get(`/test-advisory/workspace?workspaceId=${orgA.workspaceId}`, token).expect(200);
      await get(`/test-advisory/workspace?workspaceId=${orgB.workspaceId}`, token).expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  describe('parameter shape', () => {
    it('refuses a duplicated parameter rather than choosing one', async () => {
      // `?orgId=<mine>&orgId=<theirs>`: honouring either order would make the
      // decision depend on parameter order, so both orders are refused.
      const token = await tokenFor(orgA.email);
      for (const query of [
        `orgId=${orgA.orgId}&orgId=${orgB.orgId}`,
        `orgId=${orgB.orgId}&orgId=${orgA.orgId}`,
        `orgId=${orgA.orgId}&orgId=${orgA.orgId}`,
      ]) {
        const res = await get(`/test-advisory/organization?${query}`, token).expect(400);
        expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
        expect(res.body).not.toHaveProperty('reached');
      }
    });

    it('treats a repeated parameter as the array it actually is', async () => {
      // Express 5 parses repeated keys into an array with its default `simple`
      // query parser, so this is the shape the guard's array handling meets in
      // production. The object form `?orgId[id]=…` only arises under the
      // `extended` parser and is covered by the unit suite, which exercises the
      // normalizer directly rather than depending on a parser setting.
      const token = await tokenFor(orgA.email);
      const res = await get(
        `/test-advisory/organization?orgId=${orgA.orgId}&orgId=${orgB.orgId}`,
        token,
      ).expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('does not let bracket syntax smuggle a value into a declared parameter', async () => {
      // Under the `simple` parser `orgId[]=x` is a parameter literally named
      // `orgId[]`, so the declared identifier is absent and the resolved
      // context governs untouched. That is safe, but only if the bracketed
      // value truly has no effect — which is what this asserts, on the real
      // endpoint where the effect would be visible as rows.
      const token = await tokenFor(orgA.email);
      const res = await get(
        `/tenants/workspaces?orgId[]=${orgB.orgId}&orgId[id]=${orgB.orgId}`,
        token,
      ).expect(200);
      const ids = res.body.workspaces.map((w: { id: string }) => w.id);
      expect(ids).toContain(orgA.workspaceId);
      expect(ids).not.toContain(orgB.workspaceId);
    });

    it('refuses a malformed identifier', async () => {
      const token = await tokenFor(orgA.email);
      for (const value of ['not-a-uuid', '%20', `${orgA.orgId}x`, "'%20OR%201=1--"]) {
        const res = await get(`/test-advisory/organization?orgId=${value}`, token).expect(400);
        expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      }
    });

    it('refuses an empty identifier rather than treating it as absent', async () => {
      const token = await tokenFor(orgA.email);
      const res = await get('/test-advisory/organization?orgId=', token).expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    });

    it('never echoes a malformed value back to the caller', async () => {
      const token = await tokenFor(orgA.email);
      const res = await get(
        `/test-advisory/organization?orgId=${encodeURIComponent('<script>alert(1)</script>')}`,
        token,
      ).expect(400);
      expect(JSON.stringify(res.body)).not.toContain('script');
    });
  });

  // ---------------------------------------------------------------------------
  describe('several identifiers on one route', () => {
    it('accepts a request whose every identifier agrees with the context', async () => {
      const token = await tokenFor(teamUser.email);
      await get(
        `/test-advisory/combined?orgId=${orgA.orgId}&workspaceId=${orgA.workspaceId}&teamId=${orgA.teamId}`,
        token,
      ).expect(200);
    });

    it('refuses when any one of them disagrees', async () => {
      const token = await tokenFor(teamUser.email);
      const cases = [
        `orgId=${orgB.orgId}&workspaceId=${orgA.workspaceId}&teamId=${orgA.teamId}`,
        `orgId=${orgA.orgId}&workspaceId=${orgB.workspaceId}&teamId=${orgA.teamId}`,
        `orgId=${orgA.orgId}&workspaceId=${orgA.workspaceId}&teamId=${orgB.teamId}`,
      ];
      for (const query of cases) {
        const res = await get(`/test-advisory/combined?${query}`, token).expect(403);
        expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('authentication boundary', () => {
    it('refuses an unauthenticated request before any cross-check', async () => {
      const res = await request(h.app.getHttpServer())
        .get(url(`/test-advisory/organization?orgId=${orgA.orgId}`))
        .expect(401);
      expect(res.body.error.code).toBe(ERROR_CODES.AUTH_CREDENTIAL_REQUIRED);
    });
  });

  // ---------------------------------------------------------------------------
  describe('the production surface uses the same mechanism', () => {
    it('refuses another tenant’s organization id on /tenants/workspaces', async () => {
      const token = await tokenFor(orgA.email);
      const res = await get(`/tenants/workspaces?orgId=${orgB.orgId}`, token).expect(403);
      expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);
      // A refusal, not an empty listing — the two stay distinguishable.
      expect(res.body).not.toHaveProperty('workspaces');
    });

    it('accepts its own organization id and returns the real listing', async () => {
      const token = await tokenFor(orgA.email);
      const res = await get(`/tenants/workspaces?orgId=${orgA.orgId}`, token).expect(200);
      expect(res.body.workspaces.map((w: { id: string }) => w.id)).toContain(orgA.workspaceId);
    });

    it('refuses a duplicated orgId on the real endpoint too', async () => {
      const token = await tokenFor(orgA.email);
      const res = await get(
        `/tenants/workspaces?orgId=${orgA.orgId}&orgId=${orgB.orgId}`,
        token,
      ).expect(400);
      expect(res.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
      expect(res.body).not.toHaveProperty('workspaces');
    });
  });
});
