/**
 * WebSocket connection-ticket issuance (Phase 1B.7 preparation, `API.md` §10/§10a).
 *
 * **Issuance only.** Consumption and the socket gateway are deferred
 * (`DECISIONS.md` D15), so `TESTING.md` §6i's consumption, replay and
 * subscription cases are not exercisable and are not simulated here. What *is*
 * provable today is the half the ticket model rests on: that the row a
 * connection will later bind to records the right things, that it records them
 * from the caller's own resolved context, and that nothing the caller sends can
 * widen it.
 *
 * The property that makes the whole design work — a socket that performs no
 * scope resolution of its own — is only as good as the row minted here. If the
 * ticket recorded a scope the caller could not reach over HTTP, the gateway
 * would faithfully honour it.
 */
import { randomBytes } from 'node:crypto';
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';

import { CredentialService } from '../src/iam/credential.service';
import { hashWsTicket } from '../src/iam/ws-ticket';
import { TenantDatabase } from '../src/database/tenant-database.service';
import {
  PASSWORD,
  PREFIX,
  createScopedUser,
  createTenant,
  destroyTenant,
  purgeAudit,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

const url = (p: string) => `/${PREFIX}${p}`;

interface TicketBody {
  id: string;
  ticket: string;
  expiresAt: string;
  scope: string[];
  orgId: string;
  workspaceId: string | null;
}

describe('websocket ticket issuance', () => {
  let h: Harness;
  let credentials: CredentialService;
  let db: TenantDatabase;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  let tokenA: string;
  const plantedUsers: string[] = [];

  beforeAll(async () => {
    h = await startHarness();
    credentials = h.app.get(CredentialService);
    db = h.app.get(TenantDatabase);

    orgA = await createTenant(h.admin, 'ws-a', credentials);
    orgB = await createTenant(h.admin, 'ws-b', credentials);
    tokenA = await tokenFor(orgA.email);
  }, 90_000);

  afterAll(async () => {
    await cleanup();
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  beforeEach(() => purgeAudit(h.admin, sql`true`));
  afterEach(cleanup);

  async function cleanup(): Promise<void> {
    await purgeAudit(h.admin, sql`true`);
    await h.admin.execute(
      sql`DELETE FROM ws_tickets WHERE org_id IN (${orgA.orgId}, ${orgB.orgId})`,
    );
    if (plantedUsers.length > 0) {
      const ids = plantedUsers.splice(0);
      for (const id of ids) {
        await h.admin.execute(sql`DELETE FROM ws_tickets WHERE user_id = ${id}`);
        await h.admin.execute(sql`DELETE FROM sessions WHERE user_id = ${id}`);
        await h.admin.execute(sql`DELETE FROM user_roles WHERE user_id = ${id}`);
        await h.admin.execute(sql`DELETE FROM users WHERE id = ${id}`);
      }
    }
  }

  async function tokenFor(email: string): Promise<string> {
    await h.clearRateLimits();
    const res = await request(h.app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email, password: PASSWORD })
      .expect(200);
    return (res.body as { data: { accessToken: string } }).data.accessToken;
  }

  const mint = (credential: string, org?: string) => {
    const req = request(h.app.getHttpServer())
      .post(url('/ws/ticket'))
      .set('authorization', `Bearer ${credential}`);
    if (org) req.set('x-acc-organization', org);
    return req;
  };

  async function rowFor(id: string) {
    const [row] = await h.admin.select().from(schema.wsTickets).where(eq(schema.wsTickets.id, id));
    return row!;
  }

  // ===========================================================================
  it('case 1 — an authenticated session obtains a ticket', async () => {
    const res = await mint(tokenA).expect(201);
    const body = res.body.data as TicketBody;

    expect(Object.keys(res.body)).toEqual(['data']);
    expect(typeof body.ticket).toBe('string');
    expect(body.ticket.length).toBeGreaterThanOrEqual(32);
    expect(body.orgId).toBe(orgA.orgId);
    expect(res.headers['x-correlation-id']).toBeTruthy();

    // The published projection, and nothing else — in particular no hash.
    expect(Object.keys(body).sort()).toEqual([
      'expiresAt',
      'id',
      'orgId',
      'scope',
      'ticket',
      'workspaceId',
    ]);
  });

  it('case 2 — an unauthenticated request is refused', async () => {
    const res = await request(h.app.getHttpServer()).post(url('/ws/ticket')).expect(401);
    expect(res.body.error.code).toBe(ERROR_CODES.AUTH_CREDENTIAL_REQUIRED);

    const { rows } = await h.admin.execute<{ c: string }>(
      sql`SELECT count(*)::text AS c FROM ws_tickets`,
    );
    expect(rows[0]!.c).toBe('0');
  });

  it('cases 3/4/5 — the row is bound to the tenant, the user and the session', async () => {
    const res = await mint(tokenA).expect(201);
    const body = res.body.data as TicketBody;
    const row = await rowFor(body.id);

    expect(row.orgId).toBe(orgA.orgId);
    expect(row.userId).toBe(orgA.userId);
    expect(row.sessionId).not.toBeNull();

    // The session is the one that made the request, not merely any live session.
    const [session] = await h.admin
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.userId, orgA.userId), eq(schema.sessions.id, row.sessionId!)));
    expect(session).toBeDefined();
  });

  it('case 6 — the ticket expires within the configured TTL', async () => {
    const before = Date.now();
    const res = await mint(tokenA).expect(201);
    const body = res.body.data as TicketBody;
    const row = await rowFor(body.id);

    const ttlMs = new Date(body.expiresAt).getTime() - before;
    expect(ttlMs).toBeGreaterThan(0);
    // `AUTH_WS_TICKET_TTL_SECONDS` is 30 by default and capped at 300 by the
    // schema; anything beyond that is a misconfiguration this asserts against.
    expect(ttlMs).toBeLessThanOrEqual(300_000);
    expect(row.expiresAt.toISOString()).toBe(body.expiresAt);
    expect(row.expiresAt.getTime()).toBeGreaterThan(row.issuedAt.getTime());
  });

  it('case 7 — only a hash is persisted, and it is never returned', async () => {
    const res = await mint(tokenA).expect(201);
    const body = res.body.data as TicketBody;
    const row = await rowFor(body.id);

    // The stored value is the SHA-256 of the plaintext, and not the plaintext.
    expect(row.ticketHash).toBe(hashWsTicket(body.ticket));
    expect(row.ticketHash).not.toBe(body.ticket);
    expect(row.ticketHash).toMatch(/^[0-9a-f]{64}$/);

    // A database read yields nothing presentable, and the response carries no
    // hash under any spelling.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(body.ticket);
    const responseText = JSON.stringify(res.body);
    expect(responseText).not.toContain(row.ticketHash);
    expect(responseText).not.toContain('ticketHash');
    expect(responseText).not.toContain('ticket_hash');
  });

  it('case 8 — the persistence contract supports single use', async () => {
    // Consumption is deferred, so what is provable now is that the row can
    // express "consumed exactly once": it starts unconsumed, and the hash is
    // uniquely indexed so a second row could never present the same ticket.
    const first = await mint(tokenA).expect(201);
    const second = await mint(tokenA).expect(201);
    const a = await rowFor((first.body.data as TicketBody).id);
    const b = await rowFor((second.body.data as TicketBody).id);

    expect(a.consumedAt).toBeNull();
    expect(a.consumedIp).toBeNull();

    // Two calls mint two distinct tickets — a ticket is not reused or replayed
    // back to the caller.
    expect(b.id).not.toBe(a.id);
    expect(b.ticketHash).not.toBe(a.ticketHash);
    expect((second.body.data as TicketBody).ticket).not.toBe(
      (first.body.data as TicketBody).ticket,
    );

    // And the unique index is what makes a duplicate hash impossible.
    await expect(
      h.admin.insert(schema.wsTickets).values({
        ticketHash: a.ticketHash,
        userId: orgA.userId,
        orgId: orgA.orgId,
        expiresAt: new Date(Date.now() + 30_000),
      }),
    ).rejects.toThrow();
  });

  it('case 9 — scope is computed from the caller’s context', async () => {
    const res = await mint(tokenA).expect(201);
    const body = res.body.data as TicketBody;
    const row = await rowFor(body.id);

    // The fixture admin holds an organization-scoped grant, so the ticket
    // carries the organization prefix.
    expect(body.scope).toEqual([`org:${orgA.orgId}`]);
    expect(row.scope).toEqual(body.scope);
    expect(row.workspaceId).toBeNull();
  });

  it('case 9 — a workspace-pinned caller gets the workspace topic and not the organization’s', async () => {
    const pinned = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'workspace',
      orgA.workspaceId,
      'ws-pinned',
    );
    plantedUsers.push(pinned.userId);
    const pinnedToken = await tokenFor(pinned.email);

    const res = await mint(pinnedToken).expect(201);
    const body = res.body.data as TicketBody;

    // Narrowed, and narrowed *exclusively*: admitting the organization prefix
    // as well would hand a workspace user reach it does not have over HTTP.
    expect(body.scope).toEqual([`org:${orgA.orgId}:workspace:${orgA.workspaceId}`]);
    expect(body.scope).not.toContain(`org:${orgA.orgId}`);
    expect(body.workspaceId).toBe(orgA.workspaceId);

    const row = await rowFor(body.id);
    expect(row.workspaceId).toBe(orgA.workspaceId);
  });

  it('case 10 — no request input can widen the recorded scope', async () => {
    // The endpoint accepts no body, so a scope cannot be named. Every attempt
    // below must produce the same computed scope, or be refused outright.
    const attempts: { label: string; send: () => request.Test }[] = [
      {
        label: 'scope in the body',
        send: () => mint(tokenA).send({ scope: [`org:${orgB.orgId}`] }) as unknown as request.Test,
      },
      {
        label: 'organization in the body',
        send: () => mint(tokenA).send({ orgId: orgB.orgId }) as unknown as request.Test,
      },
      {
        label: 'scope in the query string',
        send: () =>
          request(h.app.getHttpServer())
            .post(url(`/ws/ticket?scope=org:${orgB.orgId}&orgId=${orgB.orgId}`))
            .set('authorization', `Bearer ${tokenA}`),
      },
      {
        label: 'scope in a header',
        send: () =>
          mint(tokenA)
            .set('x-ws-scope', `org:${orgB.orgId}`)
            .set('x-tenant-id', orgB.orgId) as unknown as request.Test,
      },
    ];

    for (const attempt of attempts) {
      const res = await attempt.send();
      // Either refused, or honoured with the caller's own computed scope —
      // never organization B's.
      if (res.status === 201) {
        const body = res.body.data as TicketBody;
        expect(body.scope).toEqual([`org:${orgA.orgId}`]);
        expect(body.orgId).toBe(orgA.orgId);
        expect(JSON.stringify(body)).not.toContain(orgB.orgId);
      } else {
        expect(res.status).toBeGreaterThanOrEqual(400);
      }
    }

    // Whatever happened above, nothing was ever written against organization B.
    const { rows } = await h.admin.execute<{ c: string }>(
      sql`SELECT count(*)::text AS c FROM ws_tickets WHERE org_id = ${orgB.orgId}`,
    );
    expect(rows[0]!.c).toBe('0');
  });

  it('case 11 — issuance writes ws_ticket.issued, carrying no ticket material', async () => {
    const res = await mint(tokenA).expect(201);
    const body = res.body.data as TicketBody;
    const row = await rowFor(body.id);

    const { rows } = await h.admin.execute<Record<string, unknown>>(
      sql`SELECT * FROM audit_logs WHERE action = 'ws_ticket.issued'`,
    );
    expect(rows).toHaveLength(1);
    const audit = rows[0]!;

    expect(audit.resource_type).toBe('WsTicket');
    expect(audit.resource_id).toBe(body.id);
    expect(audit.actor_user_id).toBe(orgA.userId);
    expect(audit.outcome).toBe('success');
    // Recorded at the scope the ticket is bound to.
    expect(audit.scope_type).toBe('organization');
    expect(audit.org_id).toBe(orgA.orgId);

    // Neither the plaintext nor the digest reaches the trail.
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(body.ticket);
    expect(serialized).not.toContain(row.ticketHash);
    expect(serialized.toLowerCase()).not.toContain('tickethash');
  });

  it('case 12 — a forged organization header cannot move the ticket to another tenant', async () => {
    const res = await mint(tokenA, orgB.orgId).expect(403);
    expect(res.body.error.code).toBe(ERROR_CODES.TENANCY_CONTEXT_MISMATCH);

    const { rows } = await h.admin.execute<{ c: string }>(
      sql`SELECT count(*)::text AS c FROM ws_tickets`,
    );
    expect(rows[0]!.c).toBe('0');
  });

  it('case 12 — another tenant’s tickets are invisible under RLS', async () => {
    // Planted directly so the row exists without this suite authenticating as B.
    const [theirs] = await h.admin
      .insert(schema.wsTickets)
      .values({
        ticketHash: hashWsTicket(`foreign-${uuidv7()}`),
        userId: orgB.userId,
        orgId: orgB.orgId,
        scope: [`org:${orgB.orgId}`],
        expiresAt: new Date(Date.now() + 30_000),
      })
      .returning({ id: schema.wsTickets.id });

    const visible = await db.withTenant(
      {
        orgId: orgA.orgId,
        workspaceId: null,
        resellerId: orgA.resellerId,
        userId: orgA.userId,
        isPlatformAdmin: false,
      },
      (tx) =>
        tx
          .select({ id: schema.wsTickets.id })
          .from(schema.wsTickets)
          .where(eq(schema.wsTickets.id, theirs!.id)),
    );
    expect(visible).toEqual([]);
  });

  it('an API-key principal cannot obtain a ticket', async () => {
    // `ws_tickets.user_id` is NOT NULL and an API key has no user, so the row is
    // unrepresentable. Refused with a reason rather than producing a ticket
    // bound to nobody.
    const secret = `secret-${uuidv7()}`;
    const prefix = `ak_test_${randomBytes(8).toString('hex')}`;
    await h.admin.insert(schema.apiKeys).values({
      orgId: orgA.orgId,
      name: `ws-key-${prefix}`,
      keyPrefix: prefix,
      keyHash: await credentials.hash(secret),
      createdBy: orgA.userId,
      scopes: [PERMISSIONS.WORKSPACES_READ],
    });

    const res = await mint(`${prefix}.${secret}`).expect(403);
    expect(res.body.error.code).toBe(ERROR_CODES.AUTHZ_PERMISSION_DENIED);

    const { rows } = await h.admin.execute<{ c: string }>(
      sql`SELECT count(*)::text AS c FROM ws_tickets`,
    );
    expect(rows[0]!.c).toBe('0');

    await purgeAudit(h.admin, sql`true`);
    await h.admin.execute(sql`DELETE FROM api_keys WHERE key_prefix = ${prefix}`);
  });

  it('a revoked session’s ticket remains bound to it, so revocation reaches the ticket', async () => {
    // Issuance-side half of "revoking the underlying session invalidates its
    // outstanding tickets" (`API.md` §10a). The enforcement is the gateway's and
    // is deferred; what is provable now is that the row records the session the
    // gateway would check, and that `ON DELETE CASCADE` ties the two together.
    const member = await createScopedUser(
      h.admin,
      orgA,
      credentials,
      'organization',
      orgA.orgId,
      'ws-revoke',
    );
    plantedUsers.push(member.userId);
    const memberToken = await tokenFor(member.email);

    const res = await mint(memberToken).expect(201);
    const row = await rowFor((res.body.data as TicketBody).id);
    expect(row.sessionId).not.toBeNull();

    await h.admin.execute(sql`DELETE FROM sessions WHERE id = ${row.sessionId!}`);

    const { rows } = await h.admin.execute<{ c: string }>(
      sql`SELECT count(*)::text AS c FROM ws_tickets WHERE id = ${row.id}`,
    );
    // The cascade removed the ticket with its session.
    expect(rows[0]!.c).toBe('0');
  });
});
