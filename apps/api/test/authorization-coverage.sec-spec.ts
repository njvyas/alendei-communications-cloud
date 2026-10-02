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
import { randomUUID } from 'node:crypto';

import { AUDIT_ACTIONS, ERROR_CODES } from '@acc/contracts';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
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
    return (res.body as { data: { accessToken: string } }).data.accessToken;
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

  // --- mutation containment (Gate C M02/M03) -----------------------------------
  //
  // The interceptor alone runs after the handler's transaction has committed, so
  // on a mutating route it could only answer `500` over a persisted write. The
  // pre-commit check in `TenantDatabase` closes that: these cases read the
  // database after the request, and trace the transaction on the wire, rather
  // than trusting the status code.

  const post = (path: string, credential: string, marker: string) =>
    request(h.app.getHttpServer())
      .post(url(path))
      .set('authorization', `Bearer ${credential}`)
      .send({ marker });

  const newMarker = () => `azcov-${randomUUID().slice(0, 8)}`;

  async function persisted(marker: string) {
    const { rows: ws } = await h.admin.execute<{ n: number }>(
      sql`select count(*)::int as n from workspaces where slug = ${marker}`,
    );
    const { rows: audit } = await h.admin.execute<{ n: number }>(
      sql`select count(*)::int as n from audit_logs
          where action = ${AUDIT_ACTIONS.WORKSPACE_CREATED} and metadata->>'probe' = ${marker}`,
    );
    return { workspaces: ws[0]!.n, successAudits: audit[0]!.n };
  }

  /**
   * Every statement the application's pool clients send while `work` runs, so a
   * test can follow one transaction from `begin` to its end. Wraps
   * `pg.Client#query` — the driver call every Drizzle statement goes through —
   * and restores it afterwards.
   */
  async function traced(work: () => Promise<unknown>) {
    const entries: { client: object; text: string; values: unknown[] }[] = [];
    const original = Client.prototype.query;
    Client.prototype.query = function (this: object, ...args: unknown[]) {
      const first = args[0] as string | { text?: string; values?: unknown[] } | undefined;
      const text = typeof first === 'string' ? first : (first?.text ?? '');
      const values =
        (typeof first === 'object' ? first?.values : undefined) ??
        (Array.isArray(args[1]) ? (args[1] as unknown[]) : []);
      entries.push({ client: this, text, values });
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as typeof original;
    try {
      await work();
    } finally {
      Client.prototype.query = original;
    }
    return entries;
  }

  /** The statements of the one transaction that inserted `marker`, begin to end. */
  function transactionOf(entries: Awaited<ReturnType<typeof traced>>, marker: string) {
    const write = entries.findIndex(
      (e) => /insert into "workspaces"/i.test(e.text) && e.values.includes(marker),
    );
    expect(write).toBeGreaterThanOrEqual(0);
    const own = entries
      .map((e, i) => ({ ...e, i }))
      .filter((e) => e.client === entries[write]!.client);
    const at = own.findIndex((e) => e.i === write);
    const begin = own.slice(0, at).findLast((e) => /^\s*begin\b/i.test(e.text));
    const end = own.slice(at + 1).find((e) => /^\s*(commit|rollback)\b/i.test(e.text));
    expect(begin).toBeDefined();
    expect(end).toBeDefined();
    return own.filter((e) => e.i >= begin!.i && e.i <= end!.i).map((e) => e.text.trim());
  }

  it('commits a write whose declared permission was checked — the control', async () => {
    const marker = newMarker();
    const trace = await traced(() =>
      post('/test-authz-coverage/checked-write', token, marker).expect(201),
    );
    const tx = transactionOf(trace, marker);
    expect(tx.at(-1)).toMatch(/^commit/i);
    expect(tx.some((t) => /^rollback/i.test(t))).toBe(false);
    expect(await persisted(marker)).toEqual({ workspaces: 1, successAudits: 1 });
  });

  it('rolls back, before commit, a write whose declared permission was never checked', async () => {
    // M02's shape. The old behavior committed the row and the success audit,
    // then answered `500`; this fails if that is reintroduced.
    const marker = newMarker();
    let status = 0;
    const trace = await traced(async () => {
      status = (await post('/test-authz-coverage/forgotten-write', token, marker)).status;
    });
    // The database first: nothing the request wrote may remain.
    expect(await persisted(marker)).toEqual({ workspaces: 0, successAudits: 0 });

    const tx = transactionOf(trace, marker);
    // begin → … → the write → the audit row → the coverage probe → rollback.
    expect(tx[0]).toMatch(/^begin/i);
    const insert = tx.findIndex((t) => /insert into "workspaces"/i.test(t));
    const audit = tx.findIndex((t) => /insert into "audit_logs"/i.test(t));
    const probe = tx.findIndex((t) => t.includes('pg_current_xact_id_if_assigned'));
    expect(insert).toBeGreaterThan(0);
    expect(audit).toBeGreaterThan(insert);
    expect(probe).toBeGreaterThan(audit);
    expect(tx.at(-1)).toMatch(/^rollback/i);
    expect(tx.some((t) => /^commit/i.test(t))).toBe(false);
    expect(status).toBe(500);
  });

  it('rolls back a write that checked a different permission than it declared', async () => {
    // M03's shape: authorized for something, not for what the route requires.
    const marker = newMarker();
    const trace = await traced(() =>
      post('/test-authz-coverage/mismatched-write', token, marker).expect(500),
    );
    expect(await persisted(marker)).toEqual({ workspaces: 0, successAudits: 0 });
    expect(transactionOf(trace, marker).at(-1)).toMatch(/^rollback/i);
  });

  it('tells the caller nothing on a contained write', async () => {
    const res = await post('/test-authz-coverage/forgotten-write', token, newMarker());
    const serialized = JSON.stringify(res.body);
    expect(res.body.error.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(serialized).not.toContain('coverage');
    expect(serialized).not.toContain('workspaces.read');
    expect(res.body.reached).toBeUndefined();
  });

  it('keeps a refused precondition a 403 with its committed denial record', async () => {
    // The denial record commits in its own transaction before the declared
    // permission is ever reached; it is exempt, so the refusal is unchanged.
    const marker = newMarker();
    const res = await post('/test-authz-coverage/refused-precondition', token, marker).expect(403);
    expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_SCOPE_DENIED);
    const { rows } = await h.admin.execute<{ n: number }>(
      sql`select count(*)::int as n from audit_logs
          where action = ${AUDIT_ACTIONS.AUTHORIZATION_DENIED} and actor_user_id = ${orgA.userId}
            and metadata->>'permission' = 'platform.tenants.manage'`,
    );
    expect(rows[0]!.n).toBe(1);
    expect(await persisted(marker)).toEqual({ workspaces: 0, successAudits: 0 });
  });

  it('does not refuse a read transaction that runs before the check', async () => {
    const marker = newMarker();
    await post('/test-authz-coverage/read-then-checked-write', token, marker).expect(201);
    expect(await persisted(marker)).toEqual({ workspaces: 1, successAudits: 1 });
  });

  it('keeps a genuine refusal of a write a 403 that persists nothing', async () => {
    const marker = newMarker();
    await post('/test-authz-coverage/checked-write', strangerToken, marker).expect(403);
    expect(await persisted(marker)).toEqual({ workspaces: 0, successAudits: 0 });
  });
});
