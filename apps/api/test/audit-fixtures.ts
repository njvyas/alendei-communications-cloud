/**
 * Tenant fixtures for the audit integration tests.
 *
 * Planted with the schema owner because a test needs rows across two unrelated
 * tenants, which is precisely what the application principal must never be able
 * to do. Mirrors `packages/db/src/test/harness.ts`; kept local because that
 * harness is not part of `@acc/db`'s public surface.
 */
import { createDatabase, createPool, schema, type Database } from '@acc/db';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';

export interface AdminHandle {
  readonly pool: Pool;
  readonly db: Database;
  close(): Promise<void>;
}

export function connectAdmin(): AdminHandle {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL must be set to run audit integration tests');
  const pool = createPool({ connectionString: url, max: 4, applicationName: 'acc-test-audit' });
  return {
    pool,
    db: createDatabase(pool),
    async close() {
      await pool.end();
    },
  };
}

export interface TenantFixture {
  readonly resellerId: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly userId: string;
  readonly apiKeyId: string;
  readonly slug: string;
}

export async function createTenant(admin: Database, label: string): Promise<TenantFixture> {
  // The random low bits, not the UUIDv7 timestamp prefix, which is identical
  // for every fixture inside the same ~65-second window.
  const slug = `${label}-${uuidv7().replace(/-/g, '').slice(-12)}`;

  const [reseller] = await admin
    .insert(schema.resellers)
    .values({ name: `Reseller ${slug}`, slug: `rs-${slug}` })
    .returning({ id: schema.resellers.id });
  const [org] = await admin
    .insert(schema.organizations)
    .values({ name: `Org ${slug}`, slug: `org-${slug}`, resellerId: reseller!.id })
    .returning({ id: schema.organizations.id });
  const [workspace] = await admin
    .insert(schema.workspaces)
    .values({ orgId: org!.id, name: 'Default', slug: 'default', isDefault: true })
    .returning({ id: schema.workspaces.id });
  const [team] = await admin
    .insert(schema.teams)
    .values({ orgId: org!.id, workspaceId: workspace!.id, name: 'Support' })
    .returning({ id: schema.teams.id });
  const [user] = await admin
    .insert(schema.users)
    .values({ email: `${slug}@example.test`, status: 'invited' })
    .returning({ id: schema.users.id });
  const [apiKey] = await admin
    .insert(schema.apiKeys)
    .values({
      orgId: org!.id,
      name: `Key ${slug}`,
      keyPrefix: `ak_test_${uuidv7().replace(/-/g, '').slice(0, 16)}`,
      keyHash: 'not-a-real-hash',
    })
    .returning({ id: schema.apiKeys.id });

  return {
    resellerId: reseller!.id,
    orgId: org!.id,
    workspaceId: workspace!.id,
    teamId: team!.id,
    userId: user!.id,
    apiKeyId: apiKey!.id,
    slug,
  };
}

/**
 * Removes a tenant's audit rows as the schema owner.
 *
 * `audit_logs` is append-only and its trigger refuses DELETE for every
 * principal, the owner included — so the only way past it is to disable the
 * trigger, which requires table ownership. That is the same capability
 * retention and archival will use, and stating it plainly is more honest than
 * carving a back door into the trigger (`SECURITY.md` §4a).
 */
export async function purgeAudit(admin: Database, where = sql`true`): Promise<void> {
  await admin.execute(sql`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only`);
  try {
    await admin.execute(sql`DELETE FROM audit_logs WHERE ${where}`);
  } finally {
    await admin.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only`);
  }
}

export async function destroyTenant(admin: Database, tenant: TenantFixture): Promise<void> {
  await purgeAudit(admin, sql`org_id = ${tenant.orgId} OR reseller_id = ${tenant.resellerId}`);
  await purgeAudit(admin, sql`actor_user_id = ${tenant.userId}`);
  for (const table of [
    'user_roles',
    'role_permissions',
    'roles',
    'ws_tickets',
    'api_keys',
    'idempotency_keys',
    'teams',
    'workspaces',
  ]) {
    await admin.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id = ${tenant.orgId}`);
  }
  await admin.execute(sql`DELETE FROM users WHERE id = ${tenant.userId}`);
  await admin.execute(sql`DELETE FROM organizations WHERE id = ${tenant.orgId}`);
  await admin.execute(sql`DELETE FROM resellers WHERE id = ${tenant.resellerId}`);
}

/** Flattens a driver error chain so an assertion matches the database's reason. */
export function reasonOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    const detail = (current as { detail?: unknown }).detail;
    if (typeof detail === 'string') parts.push(detail);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

export async function expectRejected(work: Promise<unknown>, matching?: RegExp): Promise<string> {
  let caught: unknown;
  let threw = false;
  try {
    await work;
  } catch (error) {
    caught = error;
    threw = true;
  }
  if (!threw) throw new Error('expected the statement to be rejected, but it succeeded');
  const reason = reasonOf(caught);
  if (matching && !matching.test(reason)) {
    throw new Error(`rejected for the wrong reason: ${reason}`);
  }
  return reason;
}
