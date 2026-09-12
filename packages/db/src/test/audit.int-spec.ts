/**
 * Audit-log integration tests (`TESTING.md` §6j, ADR-002).
 *
 * Everything asserted here exists only in the database — RLS policies, the
 * scope-derivation trigger, the append-only guard, the check constraints and the
 * composite foreign keys. None of it can be demonstrated against a mock, and
 * none of it is application-level filtering (`TESTING.md` §1, §6g).
 */
import { AUDIT_ACTIONS, AUTH_ROLE_AUDIT_ACTIONS } from '@acc/contracts';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import {
  asTenant,
  connect,
  createTenant,
  destroyTenant,
  purgeAuditRows,
  type Db,
  type Principals,
  type TenantFixture,
} from './harness';

const PLATFORM = { isPlatformAdmin: true } as const;

/** A complete audit row with every non-derived column set to something valid. */
function auditRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope_type: 'platform',
    scope_id: null,
    actor_type: 'system',
    actor_user_id: null,
    actor_api_key_id: null,
    actor_label: 'test',
    action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
    resource_type: 'organization',
    resource_id: null,
    outcome: 'success',
    metadata: '{}',
    correlation_id: uuidv7(),
    causation_id: null,
    ...over,
  };
}

/** Inserts through raw SQL so a test can supply columns the ORM would derive. */
function insertAudit(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  row: Record<string, unknown>,
): Promise<unknown> {
  const cols = Object.keys(row);
  const names = sql.join(
    cols.map((c) => sql.raw(`"${c}"`)),
    sql`, `,
  );
  const vals = sql.join(
    cols.map((c) => {
      const v = row[c];
      return c === 'metadata' ? sql`${v}::jsonb` : sql`${v}`;
    }),
    sql`, `,
  );
  return tx.execute(sql`INSERT INTO audit_logs (${names}) VALUES (${vals})`);
}

/**
 * Drizzle wraps a driver error in a generic "Failed query" Error, so the text a
 * test needs — the constraint name, the policy violation, the trigger's own
 * message — is only on the cause chain. This flattens the chain so an assertion
 * matches the reason the database gave, not the wrapper.
 */
function reasonOf(error: unknown): string {
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

async function expectRejected(work: Promise<unknown>, matching?: RegExp): Promise<string> {
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

describe('audit_logs', () => {
  let db: Principals;
  let orgA: TenantFixture;
  let orgB: TenantFixture;

  beforeAll(async () => {
    db = connect();
    orgA = await createTenant(db.admin, 'audit-a');
    orgB = await createTenant(db.admin, 'audit-b');
  });

  afterAll(async () => {
    await destroyTenant(db.admin, orgA);
    await destroyTenant(db.admin, orgB);
    await db.close();
  });

  // ---------------------------------------------------------------------------
  // Structure
  // ---------------------------------------------------------------------------
  describe('structure', () => {
    it('creates the table', async () => {
      const { rows } = await db.admin.execute<{ tablename: string }>(
        sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='audit_logs'`,
      );
      expect(rows).toHaveLength(1);
    });

    it('defines every documented column', async () => {
      const { rows } = await db.admin.execute<{ column_name: string; is_nullable: string }>(
        sql`SELECT column_name, is_nullable FROM information_schema.columns
            WHERE table_schema='public' AND table_name='audit_logs'`,
      );
      const byName = new Map(rows.map((r) => [r.column_name, r.is_nullable]));
      for (const expected of [
        'id',
        'scope_type',
        'scope_id',
        'reseller_id',
        'org_id',
        'workspace_id',
        'team_id',
        'actor_type',
        'actor_user_id',
        'actor_api_key_id',
        'actor_label',
        'action',
        'resource_type',
        'resource_id',
        'outcome',
        'before',
        'after',
        'metadata',
        'correlation_id',
        'causation_id',
        'ip',
        'user_agent',
        'occurred_at',
        'created_at',
      ]) {
        expect(byName.has(expected)).toBe(true);
      }
      // correlation_id groups a chain and is always known; causation_id orders it
      // and is absent for the action that began the chain (ADR-002).
      expect(byName.get('correlation_id')).toBe('NO');
      expect(byName.get('causation_id')).toBe('YES');
      expect(byName.get('scope_type')).toBe('NO');
    });

    it('creates every expected index', async () => {
      const { rows } = await db.admin.execute<{ indexname: string }>(
        sql`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='audit_logs'`,
      );
      const names = new Set(rows.map((r) => r.indexname));
      for (const expected of [
        'audit_logs_org_occurred_idx',
        'audit_logs_scope_idx',
        'audit_logs_correlation_idx',
        'audit_logs_causation_idx',
        'audit_logs_actor_idx',
        'audit_logs_action_idx',
        'audit_logs_resource_idx',
        'audit_logs_reseller_idx',
      ]) {
        expect(names.has(expected)).toBe(true);
      }
    });

    it('creates every expected foreign key, including the composite ones', async () => {
      const { rows } = await db.admin.execute<{ conname: string }>(
        sql`SELECT conname FROM pg_constraint
            WHERE conrelid='audit_logs'::regclass AND contype='f'`,
      );
      const names = new Set(rows.map((r) => r.conname));
      for (const expected of [
        'audit_logs_reseller_id_resellers_id_fk',
        'audit_logs_org_id_organizations_id_fk',
        'audit_logs_actor_user_id_users_id_fk',
        'audit_logs_workspace_org_fk',
        'audit_logs_team_org_fk',
        'audit_logs_actor_api_key_org_fk',
        'audit_logs_actor_api_key_id_fk',
      ]) {
        expect(names.has(expected)).toBe(true);
      }
    });

    it('references the organization with RESTRICT, never SET NULL', async () => {
      // SET NULL would mutate audit history as a side effect of deleting an
      // organization — and would collide with the append-only trigger (ADR-002).
      const { rows } = await db.admin.execute<{ conname: string; confdeltype: string }>(
        sql`SELECT conname, confdeltype FROM pg_constraint
            WHERE conrelid='audit_logs'::regclass AND contype='f'`,
      );
      for (const row of rows) {
        expect(row.confdeltype).toBe('r');
      }
    });

    it('defines the scope and actor check constraints', async () => {
      const { rows } = await db.admin.execute<{ conname: string }>(
        sql`SELECT conname FROM pg_constraint
            WHERE conrelid='audit_logs'::regclass AND contype='c'`,
      );
      const names = new Set(rows.map((r) => r.conname));
      expect(names.has('audit_logs_scope_shape')).toBe(true);
      expect(names.has('audit_logs_actor_shape')).toBe(true);
    });

    it('enables row-level security', async () => {
      const { rows } = await db.admin.execute<{ rowsecurity: boolean }>(
        sql`SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='audit_logs'`,
      );
      expect(rows[0]?.rowsecurity).toBe(true);
    });

    it('defines exactly the expected policies, and no UPDATE or DELETE policy', async () => {
      const { rows } = await db.admin.execute<{ policyname: string; cmd: string }>(
        sql`SELECT policyname, cmd FROM pg_policies
            WHERE schemaname='public' AND tablename='audit_logs'`,
      );
      const names = new Set(rows.map((r) => r.policyname));
      expect(names.has('audit_logs_select')).toBe(true);
      expect(names.has('audit_logs_insert')).toBe(true);
      expect(names.has('audit_logs_auth_insert')).toBe(true);
      // Append-only expressed in RLS: even if a grant were added by mistake,
      // no policy would admit a row for mutation.
      expect(rows.some((r) => r.cmd === 'UPDATE' || r.cmd === 'DELETE')).toBe(false);
    });

    it('installs the append-only and scope-integrity triggers', async () => {
      const { rows } = await db.admin.execute<{ tgname: string }>(
        sql`SELECT tgname FROM pg_trigger
            WHERE tgrelid='audit_logs'::regclass AND NOT tgisinternal`,
      );
      const names = new Set(rows.map((r) => r.tgname));
      expect(names.has('trg_audit_logs_append_only')).toBe(true);
      expect(names.has('trg_audit_logs_no_truncate')).toBe(true);
      expect(names.has('trg_audit_logs_validate_scope')).toBe(true);
    });

    it('grants no principal UPDATE, DELETE or TRUNCATE', async () => {
      const { rows } = await db.admin.execute<{ grantee: string; privilege_type: string }>(
        sql`SELECT grantee, privilege_type FROM information_schema.table_privileges
            WHERE table_schema='public' AND table_name='audit_logs'
              AND grantee IN ('acc_app','acc_auth','acc_relay')`,
      );
      const held = rows.map((r) => `${r.grantee}:${r.privilege_type}`);
      expect(held).toContain('acc_app:SELECT');
      expect(held).toContain('acc_app:INSERT');
      expect(held).toContain('acc_auth:INSERT');
      expect(held).toContain('acc_relay:SELECT');
      for (const row of rows) {
        expect(['SELECT', 'INSERT']).toContain(row.privilege_type);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Append-only
  // ---------------------------------------------------------------------------
  describe('append-only', () => {
    let rowId: string;

    beforeAll(async () => {
      const { rows } = await db.admin.execute<{ id: string }>(
        sql`INSERT INTO audit_logs (scope_type, actor_type, action, resource_type, outcome, correlation_id)
            VALUES ('platform','system','system.test','platform','success', ${uuidv7()})
            RETURNING id`,
      );
      rowId = rows[0]!.id;
    });

    afterAll(async () => {
      await db.admin.execute(
        sql`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only`,
      );
      await db.admin.execute(sql`DELETE FROM audit_logs WHERE id = ${rowId}`);
      await db.admin.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only`);
    });

    it('rejects UPDATE even for the schema owner', async () => {
      await expectRejected(
        db.admin.execute(sql`UPDATE audit_logs SET action='tampered' WHERE id=${rowId}`),
        /append-only/,
      );
    });

    it('rejects DELETE even for the schema owner', async () => {
      await expectRejected(
        db.admin.execute(sql`DELETE FROM audit_logs WHERE id=${rowId}`),
        /append-only/,
      );
    });

    it('rejects TRUNCATE even for the schema owner', async () => {
      await expectRejected(db.admin.execute(sql`TRUNCATE audit_logs`), /append-only/);
    });

    it('gives the application role no way to mutate a row', async () => {
      await expectRejected(
        asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
          tx.execute(sql`UPDATE audit_logs SET action='tampered' WHERE id=${rowId}`),
        ),
      );
      await expectRejected(
        asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
          tx.execute(sql`DELETE FROM audit_logs WHERE id=${rowId}`),
        ),
      );
    });

    it('leaves the row exactly as written', async () => {
      const { rows } = await db.admin.execute<{ action: string }>(
        sql`SELECT action FROM audit_logs WHERE id=${rowId}`,
      );
      expect(rows[0]?.action).toBe('system.test');
    });
  });

  // ---------------------------------------------------------------------------
  // Scope derivation and integrity
  // ---------------------------------------------------------------------------
  describe('scope integrity', () => {
    afterEach(async () => {
      await purgeAuditRows(db.admin, orgA.orgId);
      await purgeAuditRows(db.admin, orgB.orgId);
    });

    it('accepts an organization-scoped row and derives org_id', async () => {
      await asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
        insertAudit(tx, auditRow({ scope_type: 'organization', scope_id: orgA.orgId })),
      );
      const { rows } = await db.admin.execute<{ org_id: string; workspace_id: string | null }>(
        sql`SELECT org_id, workspace_id FROM audit_logs WHERE org_id=${orgA.orgId}`,
      );
      expect(rows[0]?.org_id).toBe(orgA.orgId);
      expect(rows[0]?.workspace_id).toBeNull();
    });

    it('accepts a workspace-scoped row and derives org_id from the workspace', async () => {
      await asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
        insertAudit(tx, auditRow({ scope_type: 'workspace', scope_id: orgA.workspaceId })),
      );
      const { rows } = await db.admin.execute<{ org_id: string; workspace_id: string }>(
        sql`SELECT org_id, workspace_id FROM audit_logs WHERE org_id=${orgA.orgId}`,
      );
      expect(rows[0]?.org_id).toBe(orgA.orgId);
      expect(rows[0]?.workspace_id).toBe(orgA.workspaceId);
    });

    it('accepts a team-scoped row and derives the full org/workspace chain', async () => {
      await asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
        insertAudit(tx, auditRow({ scope_type: 'team', scope_id: orgA.teamId })),
      );
      const { rows } = await db.admin.execute<{
        org_id: string;
        workspace_id: string;
        team_id: string;
      }>(sql`SELECT org_id, workspace_id, team_id FROM audit_logs WHERE org_id=${orgA.orgId}`);
      expect(rows[0]?.org_id).toBe(orgA.orgId);
      expect(rows[0]?.workspace_id).toBe(orgA.workspaceId);
      expect(rows[0]?.team_id).toBe(orgA.teamId);
    });

    it('accepts a platform-scoped row from a platform admin', async () => {
      await asTenant(db.app, PLATFORM, (tx) =>
        insertAudit(tx, auditRow({ scope_type: 'platform', scope_id: null })),
      );
      const { rows } = await db.admin.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM audit_logs WHERE scope_type='platform' AND action=${AUDIT_ACTIONS.ORGANIZATION_UPDATED}`,
      );
      expect(Number(rows[0]!.count)).toBeGreaterThan(0);
      await db.admin.execute(
        sql`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only`,
      );
      await db.admin.execute(
        sql`DELETE FROM audit_logs WHERE scope_type='platform' AND action=${AUDIT_ACTIONS.ORGANIZATION_UPDATED}`,
      );
      await db.admin.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only`);
    });

    it('accepts a reseller-scoped row in reseller context', async () => {
      await asTenant(db.app, { resellerId: orgA.resellerId }, (tx) =>
        insertAudit(tx, auditRow({ scope_type: 'reseller', scope_id: orgA.resellerId })),
      );
      const { rows } = await db.admin.execute<{ reseller_id: string; org_id: string | null }>(
        sql`SELECT reseller_id, org_id FROM audit_logs WHERE reseller_id=${orgA.resellerId}`,
      );
      expect(rows[0]?.reseller_id).toBe(orgA.resellerId);
      expect(rows[0]?.org_id).toBeNull();
      await db.admin.execute(
        sql`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only`,
      );
      await db.admin.execute(sql`DELETE FROM audit_logs WHERE reseller_id=${orgA.resellerId}`);
      await db.admin.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only`);
    });

    it('overrides a forged org_id with the value derived from the scope', async () => {
      // The writer names Org A's workspace but claims Org B. The trigger derives
      // org_id from the workspace, so the claim is discarded rather than honoured.
      await asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
        insertAudit(
          tx,
          auditRow({
            scope_type: 'workspace',
            scope_id: orgA.workspaceId,
            org_id: orgB.orgId,
          }),
        ),
      );
      const { rows } = await db.admin.execute<{ org_id: string }>(
        sql`SELECT org_id FROM audit_logs WHERE workspace_id=${orgA.workspaceId}`,
      );
      expect(rows[0]?.org_id).toBe(orgA.orgId);
    });

    it('rejects a scope_id that does not exist', async () => {
      await expectRejected(
        asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
          insertAudit(tx, auditRow({ scope_type: 'workspace', scope_id: uuidv7() })),
        ),
        /workspace scope .* does not exist/,
      );
    });

    it('rejects a platform scope that carries a scope_id', async () => {
      await expectRejected(
        asTenant(db.app, PLATFORM, (tx) =>
          insertAudit(tx, auditRow({ scope_type: 'platform', scope_id: orgA.orgId })),
        ),
        /platform scope carries no scope_id/,
      );
    });

    it('rejects a non-platform scope with no scope_id', async () => {
      await expectRejected(
        asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
          insertAudit(tx, auditRow({ scope_type: 'organization', scope_id: null })),
        ),
        /requires a scope_id/,
      );
    });

    it('makes a workspace/organization mismatch unrepresentable', async () => {
      // Bypasses the trigger entirely by disabling it, to prove the composite
      // foreign key — not just the trigger — refuses the impossible pair.
      await db.admin.execute(
        sql`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_validate_scope`,
      );
      try {
        await expectRejected(
          db.admin.execute(
            sql`INSERT INTO audit_logs (scope_type, scope_id, org_id, workspace_id, actor_type, action, resource_type, outcome, correlation_id)
                VALUES ('workspace', ${orgA.workspaceId}, ${orgB.orgId}, ${orgA.workspaceId}, 'system', 'x.y', 'workspace', 'success', ${uuidv7()})`,
          ),
          /audit_logs_workspace_org_fk/,
        );
      } finally {
        await db.admin.execute(
          sql`ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_validate_scope`,
        );
      }
    });

    it('makes a team/organization mismatch unrepresentable', async () => {
      await db.admin.execute(
        sql`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_validate_scope`,
      );
      try {
        await expectRejected(
          db.admin.execute(
            sql`INSERT INTO audit_logs (scope_type, scope_id, org_id, workspace_id, team_id, actor_type, action, resource_type, outcome, correlation_id)
                VALUES ('team', ${orgA.teamId}, ${orgB.orgId}, ${orgB.workspaceId}, ${orgA.teamId}, 'system', 'x.y', 'team', 'success', ${uuidv7()})`,
          ),
          /audit_logs_team_org_fk|audit_logs_workspace_org_fk/,
        );
      } finally {
        await db.admin.execute(
          sql`ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_validate_scope`,
        );
      }
    });

    it('rejects a scope shape the check constraint forbids', async () => {
      await db.admin.execute(
        sql`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_validate_scope`,
      );
      try {
        await expectRejected(
          db.admin.execute(
            sql`INSERT INTO audit_logs (scope_type, scope_id, org_id, actor_type, action, resource_type, outcome, correlation_id)
                VALUES ('platform', NULL, ${orgA.orgId}, 'system', 'x.y', 'platform', 'success', ${uuidv7()})`,
          ),
          /audit_logs_scope_shape/,
        );
      } finally {
        await db.admin.execute(
          sql`ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_validate_scope`,
        );
      }
    });

    it('refuses to record an action at a scope the writer does not hold', async () => {
      // Org A's context, Org B's workspace: the trigger derives org_id = B, and
      // the INSERT policy then refuses because B is not in A's scope.
      await expectRejected(
        asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
          insertAudit(tx, auditRow({ scope_type: 'workspace', scope_id: orgB.workspaceId })),
        ),
        /row-level security/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Actor integrity
  // ---------------------------------------------------------------------------
  describe('actor integrity', () => {
    afterEach(async () => {
      await purgeAuditRows(db.admin, orgA.orgId);
    });

    it('accepts a user actor', async () => {
      await asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
        insertAudit(
          tx,
          auditRow({
            scope_type: 'organization',
            scope_id: orgA.orgId,
            actor_type: 'user',
            actor_user_id: orgA.userId,
          }),
        ),
      );
      const { rows } = await db.admin.execute<{ actor_user_id: string }>(
        sql`SELECT actor_user_id FROM audit_logs WHERE org_id=${orgA.orgId}`,
      );
      expect(rows[0]?.actor_user_id).toBe(orgA.userId);
    });

    it('accepts an API-key actor belonging to the same organization', async () => {
      await asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
        insertAudit(
          tx,
          auditRow({
            scope_type: 'organization',
            scope_id: orgA.orgId,
            actor_type: 'api_key',
            actor_api_key_id: orgA.apiKeyId,
          }),
        ),
      );
      const { rows } = await db.admin.execute<{ actor_api_key_id: string }>(
        sql`SELECT actor_api_key_id FROM audit_logs WHERE org_id=${orgA.orgId}`,
      );
      expect(rows[0]?.actor_api_key_id).toBe(orgA.apiKeyId);
    });

    it('rejects a user actor with no user id', async () => {
      await expectRejected(
        asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
          insertAudit(
            tx,
            auditRow({
              scope_type: 'organization',
              scope_id: orgA.orgId,
              actor_type: 'user',
              actor_user_id: null,
            }),
          ),
        ),
        /audit_logs_actor_shape/,
      );
    });

    it('rejects a user actor carrying an API-key id', async () => {
      await expectRejected(
        asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
          insertAudit(
            tx,
            auditRow({
              scope_type: 'organization',
              scope_id: orgA.orgId,
              actor_type: 'user',
              actor_user_id: orgA.userId,
              actor_api_key_id: orgA.apiKeyId,
            }),
          ),
        ),
        /audit_logs_actor_shape/,
      );
    });

    it('rejects a system actor claiming an identity', async () => {
      await expectRejected(
        asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
          insertAudit(
            tx,
            auditRow({
              scope_type: 'organization',
              scope_id: orgA.orgId,
              actor_type: 'system',
              actor_user_id: orgA.userId,
            }),
          ),
        ),
        /audit_logs_actor_shape/,
      );
    });

    it('rejects an oauth_client actor with no label to identify it', async () => {
      await expectRejected(
        asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
          insertAudit(
            tx,
            auditRow({
              scope_type: 'organization',
              scope_id: orgA.orgId,
              actor_type: 'oauth_client',
              actor_label: null,
            }),
          ),
        ),
        /audit_logs_actor_shape/,
      );
    });

    it('rejects an API-key actor belonging to another organization', async () => {
      // Org A records an action, naming Org B's API key as the actor. The
      // composite foreign key refuses the pair outright.
      await expectRejected(
        asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
          insertAudit(
            tx,
            auditRow({
              scope_type: 'organization',
              scope_id: orgA.orgId,
              actor_type: 'api_key',
              actor_api_key_id: orgB.apiKeyId,
            }),
          ),
        ),
        /audit_logs_actor_api_key_org_fk/,
      );
    });

    it('rejects an actor id that does not exist at all', async () => {
      await expectRejected(
        asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
          insertAudit(
            tx,
            auditRow({
              scope_type: 'organization',
              scope_id: orgA.orgId,
              actor_type: 'user',
              actor_user_id: uuidv7(),
            }),
          ),
        ),
        /audit_logs_actor_user_id_users_id_fk/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant and platform isolation
  // ---------------------------------------------------------------------------
  describe('tenant isolation', () => {
    beforeAll(async () => {
      await asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
        insertAudit(tx, auditRow({ scope_type: 'organization', scope_id: orgA.orgId })),
      );
      await asTenant(db.app, { orgId: orgB.orgId }, (tx) =>
        insertAudit(tx, auditRow({ scope_type: 'organization', scope_id: orgB.orgId })),
      );
      await asTenant(db.app, PLATFORM, (tx) =>
        insertAudit(tx, auditRow({ scope_type: 'platform', action: 'platform.only.marker' })),
      );
    });

    afterAll(async () => {
      await purgeAuditRows(db.admin, orgA.orgId);
      await purgeAuditRows(db.admin, orgB.orgId);
      await db.admin.execute(
        sql`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only`,
      );
      await db.admin.execute(sql`DELETE FROM audit_logs WHERE action='platform.only.marker'`);
      await db.admin.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only`);
    });

    const countVisible = (db_: Db, session: Parameters<typeof asTenant>[1]): Promise<number> =>
      asTenant(db_, session, async (tx) => {
        const { rows } = await tx.execute<{ count: string }>(
          sql`SELECT count(*)::text AS count FROM audit_logs`,
        );
        return Number(rows[0]!.count);
      });

    it('lets an organization read its own audit records', async () => {
      const visible = await asTenant(db.app, { orgId: orgA.orgId }, async (tx) => {
        const { rows } = await tx.execute<{ org_id: string }>(
          sql`SELECT org_id FROM audit_logs WHERE org_id IS NOT NULL`,
        );
        return rows;
      });
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.every((r) => r.org_id === orgA.orgId)).toBe(true);
    });

    it('hides Org B audit records from Org A', async () => {
      const visible = await asTenant(db.app, { orgId: orgA.orgId }, async (tx) => {
        const { rows } = await tx.execute(
          sql`SELECT id FROM audit_logs WHERE org_id=${orgB.orgId}`,
        );
        return rows;
      });
      expect(visible).toHaveLength(0);
    });

    it('hides Org A audit records from Org B', async () => {
      const visible = await asTenant(db.app, { orgId: orgB.orgId }, async (tx) => {
        const { rows } = await tx.execute(
          sql`SELECT id FROM audit_logs WHERE org_id=${orgA.orgId}`,
        );
        return rows;
      });
      expect(visible).toHaveLength(0);
    });

    it('refuses to let a tenant insert an audit record for another tenant', async () => {
      await expectRejected(
        asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
          insertAudit(tx, auditRow({ scope_type: 'organization', scope_id: orgB.orgId })),
        ),
        /row-level security/,
      );
    });

    it('refuses to let a tenant create a platform-level record', async () => {
      await expectRejected(
        asTenant(db.app, { orgId: orgA.orgId }, (tx) =>
          insertAudit(tx, auditRow({ scope_type: 'platform', scope_id: null })),
        ),
        /row-level security/,
      );
    });

    it('hides platform-level records from a tenant', async () => {
      const visible = await asTenant(db.app, { orgId: orgA.orgId }, async (tx) => {
        const { rows } = await tx.execute(
          sql`SELECT id FROM audit_logs WHERE action='platform.only.marker'`,
        );
        return rows;
      });
      expect(visible).toHaveLength(0);
    });

    it('lets a platform admin read platform-level records', async () => {
      const visible = await asTenant(db.app, PLATFORM, async (tx) => {
        const { rows } = await tx.execute(
          sql`SELECT id FROM audit_logs WHERE action='platform.only.marker'`,
        );
        return rows;
      });
      expect(visible.length).toBeGreaterThan(0);
    });

    it('lets a reseller read the audit trail of organizations beneath it', async () => {
      const visible = await asTenant(db.app, { resellerId: orgA.resellerId }, async (tx) => {
        const { rows } = await tx.execute<{ org_id: string }>(
          sql`SELECT org_id FROM audit_logs WHERE org_id IS NOT NULL`,
        );
        return rows;
      });
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.every((r) => r.org_id === orgA.orgId)).toBe(true);
    });

    it('sees strictly more as a platform admin than as one tenant', async () => {
      const asOrgA = await countVisible(db.app, { orgId: orgA.orgId });
      const asPlatform = await countVisible(db.app, PLATFORM);
      expect(asPlatform).toBeGreaterThan(asOrgA);
    });

    /**
     * Negative control (`TESTING.md` §6g): the isolation assertions above must
     * fail if RLS is weakened. Dropping the SELECT policy's tenancy term makes
     * Org B's rows visible from Org A — proving the earlier tests measure the
     * policy rather than an incidental absence of data.
     */
    it('would fail if the SELECT policy were weakened', async () => {
      const before = await asTenant(db.app, { orgId: orgA.orgId }, async (tx) => {
        const { rows } = await tx.execute(
          sql`SELECT id FROM audit_logs WHERE org_id=${orgB.orgId}`,
        );
        return rows.length;
      });
      expect(before).toBe(0);

      await db.admin.execute(sql`ALTER POLICY audit_logs_select ON audit_logs USING (true)`);
      try {
        const after = await asTenant(db.app, { orgId: orgA.orgId }, async (tx) => {
          const { rows } = await tx.execute(
            sql`SELECT id FROM audit_logs WHERE org_id=${orgB.orgId}`,
          );
          return rows.length;
        });
        expect(after).toBeGreaterThan(0);
      } finally {
        await db.admin.execute(
          sql`ALTER POLICY audit_logs_select ON audit_logs USING (
                app_is_platform_admin()
                OR (org_id IS NOT NULL AND app_org_in_scope(org_id))
                OR (scope_type = 'reseller' AND reseller_id = app_current_reseller_id())
              )`,
        );
      }

      const restored = await asTenant(db.app, { orgId: orgA.orgId }, async (tx) => {
        const { rows } = await tx.execute(
          sql`SELECT id FROM audit_logs WHERE org_id=${orgB.orgId}`,
        );
        return rows.length;
      });
      expect(restored).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // acc_auth — the identity role
  // ---------------------------------------------------------------------------
  describe('acc_auth', () => {
    afterEach(async () => {
      await db.admin.execute(
        sql`ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only`,
      );
      await db.admin.execute(sql`DELETE FROM audit_logs WHERE resource_type='auth'`);
      await db.admin.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_logs_append_only`);
    });

    const authRow = (over: Record<string, unknown> = {}): Record<string, unknown> =>
      auditRow({
        scope_type: 'platform',
        scope_id: null,
        actor_type: 'user',
        actor_user_id: orgA.userId,
        actor_label: null,
        action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        resource_type: 'auth',
        outcome: 'failure',
        ...over,
      });

    it('accepts a pre-tenant authentication record', async () => {
      await insertAudit(db.auth, authRow());
      const { rows } = await db.admin.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM audit_logs WHERE resource_type='auth'`,
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });

    it('accepts an API-key authentication record', async () => {
      await insertAudit(
        db.auth,
        authRow({
          actor_type: 'api_key',
          actor_user_id: null,
          actor_api_key_id: orgA.apiKeyId,
          action: AUDIT_ACTIONS.API_KEY_AUTHENTICATED,
          outcome: 'success',
        }),
      );
      const { rows } = await db.admin.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM audit_logs WHERE resource_type='auth'`,
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });

    it('refuses to write a record scoped to an organization', async () => {
      await expectRejected(
        insertAudit(db.auth, authRow({ scope_type: 'organization', scope_id: orgA.orgId })),
        /row-level security/,
      );
    });

    it('refuses to write a record scoped to a reseller', async () => {
      await expectRejected(
        insertAudit(db.auth, authRow({ scope_type: 'reseller', scope_id: orgA.resellerId })),
        /row-level security/,
      );
    });

    it('refuses a non-auth action', async () => {
      await expectRejected(
        insertAudit(db.auth, authRow({ action: AUDIT_ACTIONS.USER_ROLE_GRANTED })),
        /row-level security/,
      );
    });

    it('refuses an invented action outside the vocabulary', async () => {
      await expectRejected(
        insertAudit(db.auth, authRow({ action: 'auth.login.succeeded.but.also.everything' })),
        /row-level security/,
      );
    });

    it('refuses to impersonate the system actor', async () => {
      await expectRejected(
        insertAudit(
          db.auth,
          authRow({ actor_type: 'system', actor_user_id: null, actor_label: 'sys' }),
        ),
        /row-level security/,
      );
    });

    it('refuses to impersonate an oauth_client actor', async () => {
      await expectRejected(
        insertAudit(
          db.auth,
          authRow({ actor_type: 'oauth_client', actor_user_id: null, actor_label: 'client' }),
        ),
        /row-level security/,
      );
    });

    it('cannot manufacture a successful privileged action for a tenant', async () => {
      await expectRejected(
        insertAudit(
          db.auth,
          authRow({
            scope_type: 'organization',
            scope_id: orgB.orgId,
            action: AUDIT_ACTIONS.USER_ROLE_GRANTED,
            outcome: 'success',
          }),
        ),
        /row-level security/,
      );
    });

    it('cannot read the audit log at all', async () => {
      await expectRejected(db.auth.execute(sql`SELECT id FROM audit_logs`), /permission denied/);
    });

    it('confines the database vocabulary to exactly the shared contract', async () => {
      // The policy calls app_is_auth_audit_action(); this asserts that SQL list
      // has not drifted from AUTH_ROLE_AUDIT_ACTIONS in @acc/contracts.
      for (const action of AUTH_ROLE_AUDIT_ACTIONS) {
        const { rows } = await db.admin.execute<{ allowed: boolean }>(
          sql`SELECT app_is_auth_audit_action(${action}) AS allowed`,
        );
        expect(rows[0]?.allowed).toBe(true);
      }
      const everyOther = Object.values(AUDIT_ACTIONS).filter(
        (a) => !(AUTH_ROLE_AUDIT_ACTIONS as readonly string[]).includes(a),
      );
      for (const action of everyOther) {
        const { rows } = await db.admin.execute<{ allowed: boolean }>(
          sql`SELECT app_is_auth_audit_action(${action}) AS allowed`,
        );
        expect(rows[0]?.allowed).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Organization deletion
  // ---------------------------------------------------------------------------
  describe('organization deletion', () => {
    it('refuses to hard-delete an organization that has audit history', async () => {
      const doomed = await createTenant(db.admin, 'audit-doomed');
      await asTenant(db.app, { orgId: doomed.orgId }, (tx) =>
        insertAudit(tx, auditRow({ scope_type: 'organization', scope_id: doomed.orgId })),
      );

      // Remove every other child first, so the only thing still referencing the
      // organization is its audit history. Without this the test would pass on
      // the pre-existing `teams_org_id_organizations_id_fk` and prove nothing
      // about audit retention.
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
        await db.admin.execute(sql`DELETE FROM ${sql.raw(table)} WHERE org_id = ${doomed.orgId}`);
      }

      // A clean foreign-key refusal, not a confusing append-only trigger error:
      // audit history is retained and the organization is deactivated instead
      // (ADR-002, `TENANCY.md` §1b).
      const reason = await expectRejected(
        db.admin.execute(sql`DELETE FROM organizations WHERE id=${doomed.orgId}`),
        /audit_logs/,
      );
      expect(reason).toMatch(/violates foreign key constraint/);

      await db.admin.execute(
        sql`UPDATE organizations SET status='closed' WHERE id=${doomed.orgId}`,
      );
      const { rows } = await db.admin.execute<{ status: string }>(
        sql`SELECT status FROM organizations WHERE id=${doomed.orgId}`,
      );
      expect(rows[0]?.status).toBe('closed');

      await destroyTenant(db.admin, doomed);
    });
  });
});
