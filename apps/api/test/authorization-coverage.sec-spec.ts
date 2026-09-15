/**
 * `AuthorizationCoverageInterceptor` — the runtime half of `@RequiresPermission`
 * (Phase 1B.5.7).
 *
 * `@RequiresPermission` cannot enforce from a guard: the chain a decision rests
 * on must be read inside the request's own tenant transaction (ADR-005 D-5),
 * which does not exist until the handler opens it. A guard that authorized would
 * put the decision and the mutation in two different transactions and open a
 * window between them — the time-of-check/time-of-use defect that is precisely
 * why 1B.5.2 deferred this decorator rather than shipping a guard that looked
 * right.
 *
 * So enforcement stays in `AuthorizationService.assert`, and this interceptor
 * closes the gap that leaves: a handler that declares a permission and then
 * forgets to ask for it. What it buys is stated exactly, because the difference
 * matters — for a read the response is suppressed before it reaches the caller;
 * for a mutation the write has already committed, and the guarantee comes from
 * the service's check running before it plus §6n case 30's route-table
 * assertion, which fails the build rather than the request.
 */
import { ERROR_CODES } from '@acc/contracts';
import { sql } from 'drizzle-orm';
import request from 'supertest';

import { CredentialService } from '../src/iam/credential.service';
import { AuthorizationCoverageProbeController } from './authorization-coverage.controller';
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

const url = (p: string) => `/${PREFIX}${p}`;

describe('authorization coverage interceptor', () => {
  let h: Harness;
  let orgA: TenantFixture;
  let token: string;
  let strangerToken: string;

  beforeAll(async () => {
    h = await startHarness({ controllers: [AuthorizationCoverageProbeController] });
    const credentials = h.app.get(CredentialService);
    orgA = await createTenant(h.admin, 'azcov', credentials);
    token = await tokenFor(orgA.email);

    const stranger = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'workspace',
      orgA.workspaceId,
      'azcov-ws',
    );
    strangerToken = await tokenFor(stranger.email);
    strangerUserId = stranger.userId;
  }, 90_000);

  let strangerUserId: string;

  afterAll(async () => {
    await destroyUser(h.admin, strangerUserId);
    await destroyTenant(h.admin, orgA);
    await h.close();
  }, 60_000);

  beforeEach(() => purgeAudit(h.admin, sql`true`));
  afterEach(() => purgeAudit(h.admin, sql`true`));

  async function tokenFor(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { accessToken: string }).accessToken;
  }

  const get = (path: string, credential: string) =>
    request(h.app.getHttpServer()).get(url(path)).set('authorization', `Bearer ${credential}`);

  it('lets a handler that checked what it declared through — the control', async () => {
    const res = await get('/test-authz-coverage/checked', token).expect(200);
    expect(res.body.reached).toBe(true);
  });

  it('fails a handler that declared a permission and never checked it', async () => {
    // Without the interceptor this returns 200 and the body below.
    const res = await get('/test-authz-coverage/forgotten', token).expect(500);
    expect(res.body.error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
  });

  it('discloses nothing from the unauthorized handler’s response', async () => {
    const res = await get('/test-authz-coverage/forgotten', token).expect(500);
    // The handler ran and produced a body; the caller must not receive it.
    expect(JSON.stringify(res.body)).not.toContain('data the caller was never authorized for');
    expect(res.body.reached).toBeUndefined();
  });

  it('fails a handler that checked a different permission than it declared', async () => {
    // The subtler defect: the request *was* authorized, just not for the thing
    // the route said it required.
    await get('/test-authz-coverage/mismatched', token).expect(500);
  });

  it('tells the caller nothing about which route is misconfigured', async () => {
    const res = await get('/test-authz-coverage/forgotten', token).expect(500);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('RequiresPermission');
    expect(serialized).not.toContain('workspaces.read');
    expect(serialized).not.toContain('coverage');
    // Only the generic message and a correlation id.
    expect(res.body.error.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not mask a genuine authorization refusal', async () => {
    // A principal that legitimately fails the check still gets its `403`: the
    // interceptor runs on the success path and must not convert a refusal into
    // a `500`.
    const res = await get('/test-authz-coverage/checked', strangerToken).expect(403);
    expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
  });

  it('a refused check still counts as a check having happened', async () => {
    // The coverage record is written before the decision, so a denial does not
    // additionally trip the interceptor and turn a clean `403` into a `500`.
    const res = await get('/test-authz-coverage/checked', strangerToken);
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(500);
  });

  it('leaves routes with no declaration alone', async () => {
    // `/auth/me` is `@AuthorizationExempt`, so the interceptor has nothing to
    // compare and must not interfere.
    await get('/auth/me', token).expect(200);
  });
});
