/**
 * `ScopeChainResolver` — authoritative target ancestry (Phase 1B.5.2, ADR-005 D-5).
 *
 * `scopeCovers` is only as correct as the chain it is handed, so the chain is
 * the thing an attacker would want to influence. These tests establish two
 * properties:
 *
 *   1. the chain matches database truth for every level, and
 *   2. nothing a caller supplies can change it — because the resolver's only
 *      inputs are a transaction and a `(scopeType, scopeId)` reference, and it
 *      reads ancestry from columns rather than from arguments.
 *
 * They run against a real database through the real tenant transaction, so the
 * RLS half of the guarantee is exercised too: a target in another organization
 * is not merely unresolvable in principle, it is invisible in fact.
 */
import { createDatabase, createPool, schema, type Database, type TenantSession } from '@acc/db';
import type { ScopeChain } from '@acc/contracts';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { ScopeChainResolver } from '../src/auth/scope-chain-resolver.service';
import { TenantDatabase } from '../src/database/tenant-database.service';
import { CredentialService } from '../src/iam/credential.service';
import {
  createTenant,
  destroyTenant,
  startHarness,
  type Harness,
  type TenantFixture,
} from './auth-harness';

describe('ScopeChainResolver', () => {
  let h: Harness;
  let resolver: ScopeChainResolver;
  let db: TenantDatabase;
  let orgA: TenantFixture;
  let orgB: TenantFixture;
  let workspaceTwoId: string;

  /** Runs `work` as `acc_app` under an explicit tenant context, as a handler does. */
  const runAs = <T>(session: TenantSession, work: Parameters<TenantDatabase['withTenant']>[1]) =>
    db.withTenant(session, work) as Promise<T>;

  const chainOf = (t: TenantFixture) => ({
    resellerId: t.resellerId,
    orgId: t.orgId,
  });

  beforeAll(async () => {
    h = await startHarness();
    resolver = h.app.get(ScopeChainResolver);
    db = h.app.get(TenantDatabase);
    const credentials = h.app.get(CredentialService);
    orgA = await createTenant(h.admin, 'chain-a', credentials);
    orgB = await createTenant(h.admin, 'chain-b', credentials);

    const [second] = await h.admin
      .insert(schema.workspaces)
      .values({ orgId: orgA.orgId, name: 'Second', slug: 'second' })
      .returning({ id: schema.workspaces.id });
    workspaceTwoId = second!.id;
  }, 60_000);

  afterAll(async () => {
    await h.admin.execute(sql`DELETE FROM workspaces WHERE id = ${workspaceTwoId}`);
    await destroyTenant(h.admin, orgA);
    await destroyTenant(h.admin, orgB);
    await h.close();
  }, 60_000);

  /** The tenant context a request acting in this organization would establish. */
  const sessionFor = (t: TenantFixture): TenantSession => ({
    orgId: t.orgId,
    resellerId: t.resellerId,
    isPlatformAdmin: false,
  });

  const resolve = (session: TenantSession, scopeType: string, scopeId: string | null) =>
    runAs<ScopeChain | null>(session, (tx) =>
      resolver.resolve(tx, { scopeType: scopeType as never, scopeId }),
    );

  // ---------------------------------------------------------------------------
  describe('A-C. every level resolves to database truth', () => {
    it('A. an organization resolves its reseller', async () => {
      const chain = await resolve(sessionFor(orgA), 'organization', orgA.orgId);
      expect(chain).toEqual({ resellerId: orgA.resellerId, orgId: orgA.orgId });
    });

    it('B. a workspace resolves its organization and reseller', async () => {
      const chain = await resolve(sessionFor(orgA), 'workspace', orgA.workspaceId);
      expect(chain).toEqual({
        ...chainOf(orgA),
        workspaceId: orgA.workspaceId,
      });
    });

    it('C. a team resolves its workspace, organization and reseller', async () => {
      const chain = await resolve(sessionFor(orgA), 'team', orgA.teamId);
      expect(chain).toEqual({
        ...chainOf(orgA),
        workspaceId: orgA.workspaceId,
        teamId: orgA.teamId,
      });
    });

    it('resolves a reseller, and the platform as the root with no ancestry', async () => {
      expect(await resolve(sessionFor(orgA), 'reseller', orgA.resellerId)).toEqual({
        resellerId: orgA.resellerId,
      });
      expect(await resolve(sessionFor(orgA), 'platform', null)).toEqual({});
    });

    it('matches what the database says independently', async () => {
      // The assertion above compares against the fixture; this one compares
      // against the rows themselves, so a fixture that drifted could not make
      // the resolver look correct.
      const [truth] = await h.admin
        .select({
          orgId: schema.workspaces.orgId,
          resellerId: schema.organizations.resellerId,
        })
        .from(schema.workspaces)
        .innerJoin(schema.organizations, eq(schema.organizations.id, schema.workspaces.orgId))
        .where(eq(schema.workspaces.id, orgA.workspaceId));

      expect(await resolve(sessionFor(orgA), 'workspace', orgA.workspaceId)).toEqual({
        resellerId: truth!.resellerId,
        orgId: truth!.orgId,
        workspaceId: orgA.workspaceId,
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('D. unresolvable targets', () => {
    it.each(['organization', 'workspace', 'team', 'reseller'])(
      'returns null for a nonexistent %s',
      async (scopeType) => {
        expect(await resolve(sessionFor(orgA), scopeType, uuidv7())).toBeNull();
      },
    );

    it('returns null for a non-platform target with no id', async () => {
      // Fail closed: a missing id must not resolve to an empty chain, which
      // would cover by accident.
      for (const scopeType of ['organization', 'workspace', 'team', 'reseller']) {
        expect(await resolve(sessionFor(orgA), scopeType, null)).toBeNull();
      }
    });

    it('returns null when the id is of the wrong kind', async () => {
      // A workspace id presented as an organization is not an organization.
      // Type confusion resolves to nothing rather than to a partial chain.
      expect(await resolve(sessionFor(orgA), 'organization', orgA.workspaceId)).toBeNull();
      expect(await resolve(sessionFor(orgA), 'team', orgA.workspaceId)).toBeNull();
      expect(await resolve(sessionFor(orgA), 'workspace', orgA.teamId)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  describe('E-F. cross-organization and cross-reseller isolation', () => {
    it('E. cannot resolve another organization’s workspace', async () => {
      // RLS makes the row invisible under Organization A's context, so the
      // ancestry of a foreign target cannot be obtained at all — the chain is
      // never assembled from a partially visible row.
      expect(await resolve(sessionFor(orgA), 'workspace', orgB.workspaceId)).toBeNull();
      expect(await resolve(sessionFor(orgA), 'team', orgB.teamId)).toBeNull();
      expect(await resolve(sessionFor(orgA), 'organization', orgB.orgId)).toBeNull();
    });

    it('F. cannot resolve another reseller', async () => {
      expect(await resolve(sessionFor(orgA), 'reseller', orgB.resellerId)).toBeNull();
    });

    it('resolves each organization’s own workspace under its own context', async () => {
      // The positive control for the two above: both rows exist and are
      // resolvable by their rightful tenant, so the nulls are isolation rather
      // than a broken query.
      expect(await resolve(sessionFor(orgA), 'workspace', orgA.workspaceId)).not.toBeNull();
      expect(await resolve(sessionFor(orgB), 'workspace', orgB.workspaceId)).not.toBeNull();
    });

    it('a sibling workspace in the same organization still resolves', async () => {
      // RLS stops at the organization (`TENANCY.md` §3a), so a sibling
      // workspace is legitimately resolvable; refusing it is the authorization
      // layer's job, not the resolver's. Stating this keeps the boundary
      // honest rather than implying RLS covers workspaces.
      expect(await resolve(sessionFor(orgA), 'workspace', workspaceTwoId)).toEqual({
        ...chainOf(orgA),
        workspaceId: workspaceTwoId,
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('G-K. ancestry cannot be supplied by a caller', () => {
    /**
     * The resolver takes a transaction and a `(scopeType, scopeId)` pair. There
     * is no ancestry parameter to forge — which is the design property, not an
     * accident — so these assert the consequence: the chain for a given target
     * is a function of database state alone.
     */
    it.each([
      ['organization', () => orgA.orgId],
      ['workspace', () => orgA.workspaceId],
      ['team', () => orgA.teamId],
    ])(
      'G-H. a %s resolves identically under any tenant context that can see it',
      async (scopeType, id) => {
        // Organization A's own context, and a platform context that can see
        // every organization, produce byte-identical ancestry. Visibility
        // changes what is *resolvable*; it never changes what the ancestry
        // *is*. A resolver that read the organization or reseller from the
        // session rather than from the row would disagree here — which is the
        // mutation this case exists to catch.
        const own = await resolve(sessionFor(orgA), scopeType, id());
        const platform = await resolve({ isPlatformAdmin: true }, scopeType, id());

        expect(platform).toEqual(own);
        expect(platform!.orgId).toBe(orgA.orgId);
        expect(platform!.resellerId).toBe(orgA.resellerId);
        // And specifically: never Organization B's ancestry, under any context.
        expect(platform!.orgId).not.toBe(orgB.orgId);
        expect(platform!.resellerId).not.toBe(orgB.resellerId);
      },
    );

    it('G-H. resolves under a context belonging to a different organization entirely', async () => {
      // A platform context is the only one that can see across organizations,
      // so this pins the property that the *row* decides: Organization B's
      // workspace resolves to Organization B's ancestry even when the reading
      // session was last used for Organization A.
      expect(await resolve({ isPlatformAdmin: true }, 'workspace', orgB.workspaceId)).toEqual({
        ...chainOf(orgB),
        workspaceId: orgB.workspaceId,
      });
    });

    it('I-J. supplying or omitting the parent makes no difference — there is nowhere to supply it', async () => {
      // Two calls that differ only in a tenant context carrying a *different*
      // workspace narrowing. The resolved ancestry is unchanged, because the
      // resolver reads `workspaces.org_id` rather than any session or request
      // value.
      const withMisleadingNarrowing = await resolve(
        { orgId: orgA.orgId, resellerId: orgA.resellerId, workspaceId: workspaceTwoId },
        'workspace',
        orgA.workspaceId,
      );
      expect(withMisleadingNarrowing).toEqual({
        ...chainOf(orgA),
        workspaceId: orgA.workspaceId,
      });
    });

    it('K. a wholly false context cannot produce a false chain — it produces nothing', async () => {
      // Claiming Organization B while targeting Organization A's workspace does
      // not relabel the workspace; RLS simply refuses to show it. The forged
      // context yields `null`, never a chain naming Organization B.
      const forged = await resolve(
        { orgId: orgB.orgId, resellerId: orgB.resellerId },
        'workspace',
        orgA.workspaceId,
      );
      expect(forged).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  describe('tenant-context hygiene', () => {
    it('leaves no context behind on the pooled connection', async () => {
      // The resolver introduces a new database access path, so the 1B.4
      // pooled-connection guarantee is re-asserted across it: after a resolve,
      // a query with no context established still sees nothing
      // (`TESTING.md` §6h).
      const pool = createPool({
        connectionString: process.env.DATABASE_URL!,
        max: 1,
        applicationName: 'acc-test-chain-hygiene',
      });
      const appDb: Database = createDatabase(pool);
      try {
        const chain = await db.withTenant(sessionFor(orgA), (tx) =>
          resolver.resolve(tx, { scopeType: 'workspace', scopeId: orgA.workspaceId }),
        );
        expect(chain).not.toBeNull();

        const bare = await appDb.select({ id: schema.workspaces.id }).from(schema.workspaces);
        expect(bare).toHaveLength(0);
      } finally {
        await pool.end();
      }
    });
  });
});
