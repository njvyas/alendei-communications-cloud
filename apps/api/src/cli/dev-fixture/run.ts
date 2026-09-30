/**
 * Phase 1C.4a — the deterministic development/test fixture (`TESTING.md` §6r).
 *
 * Order of operations, each step deciding before it writes:
 *
 *   1. Environment gate and secret resolution (`environment.ts`) — before any
 *      connection is opened or application module is loaded.
 *   2. Read-only inspection as the owner (`inspect.ts`). A missing prerequisite
 *      or any conflicting object aborts with nothing written.
 *   3. Nothing missing → a no-op: no write, no application boot, no sign-in,
 *      no session, no audit row.
 *   4. Otherwise, in dependency order:
 *        - the platform bootstrap, through the unchanged `runBootstrap`;
 *        - Reseller B, the owner-level exception (`owner-operations.ts`);
 *        - organizations, the team, users and every grant through the real
 *          HTTP API of an in-process instance built by `createApp()` — the
 *          function `main.ts` uses — signed in as the platform administrator
 *          through `POST /auth/login` and signed out through `POST /auth/logout`;
 *        - credential activation of the new invited identities, the second
 *          owner-level exception.
 *   5. Verification: a fresh inspection must find nothing missing and nothing
 *      conflicting, and the audit evidence must exist.
 */
import { createDatabase, createPool, type Database } from '@acc/db';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';

import { AuditWriter } from '../../audit/audit-writer.service';
import { CredentialService } from '../../iam/credential.service';
import { UserLifecycleService } from '../../iam/user-lifecycle.service';
import { ownerAuditWriter, runBootstrap } from '../bootstrap';
import { FixtureApiClient } from './api-client';
import { FixtureRefusal, resolveFixtureInputs, type FixtureInputs } from './environment';
import {
  digestLines,
  fixtureLines,
  inspectFixture,
  type Inspection,
  type PlanStep,
} from './inspect';
import { activateFixtureUser, createFixtureReseller } from './owner-operations';
import {
  FIXTURE_NAME,
  FIXTURE_VERSION,
  grantKey,
  ORG_REFS,
  ORGANIZATIONS,
  RESELLERS,
  TEAM,
  USER_REFS,
  USERS,
  type OrgRef,
  type UserRef,
} from './topology';

export interface FixtureManifest {
  readonly fixture: string;
  readonly version: number;
  readonly outcome: 'created' | 'unchanged';
  readonly fingerprint: { readonly logical: string; readonly identity: string };
  readonly resellers: Record<'A' | 'B', { id: string; slug: string }>;
  readonly organizations: Record<
    OrgRef,
    { id: string; slug: string; reseller: 'A' | 'B'; defaultWorkspaceId: string }
  >;
  readonly team: { id: string; org: OrgRef; workspaceId: string; name: string };
  readonly users: Record<UserRef, { id: string; email: string; grants: string[] }>;
  readonly operator: { readonly id: string; readonly email: string };
  /** Where the fixture users' password comes from — a variable name, never a value. */
  readonly credentials: { readonly passwordReference: string };
}

type Log = (line: string) => void;

function argon2Config(env: NodeJS.ProcessEnv) {
  return {
    auth: {
      argon2: {
        memoryCost: Number(env.AUTH_ARGON2_MEMORY_KIB ?? 19456),
        timeCost: Number(env.AUTH_ARGON2_TIME_COST ?? 2),
        parallelism: Number(env.AUTH_ARGON2_PARALLELISM ?? 1),
      },
    },
  };
}

function refuseOn(inspection: Inspection): void {
  const problems = [...inspection.refusals, ...inspection.conflicts];
  if (problems.length > 0) {
    throw new FixtureRefusal(`nothing was changed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

const has = (plan: readonly PlanStep[], kind: PlanStep['kind']) =>
  plan.some((s) => s.kind === kind);

/**
 * Builds the real application and listens on an ephemeral loopback port. The
 * outbox relay is off in this short-lived operator process (the running API's
 * relay publishes what it leaves pending) and application logs are limited to
 * errors so the manifest on stdout stays machine-readable. Nothing else about
 * the application is changed.
 */
async function startApi(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const overrides = { OUTBOX_RELAY_ENABLED: 'false', LOG_LEVEL: 'error' };
  const saved = Object.fromEntries(Object.keys(overrides).map((k) => [k, process.env[k]]));
  Object.assign(process.env, overrides);
  try {
    const { createApp } = await import('../../app.factory');
    const { AppConfigService } = await import('../../config/app-config.service');
    const app = await createApp();
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    const prefix = app.get(AppConfigService).http.globalPrefix;
    return { baseUrl: `http://127.0.0.1:${port}/${prefix}`, close: () => app.close() };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function apiPhases(
  db: Database,
  inputs: FixtureInputs,
  credentials: CredentialService,
  log: Log,
): Promise<void> {
  const api = await startApi();
  const client = new FixtureApiClient(api.baseUrl);
  const inspect = async () => {
    const inspection = await inspectFixture(db, inputs, credentials);
    refuseOn(inspection);
    return inspection;
  };
  const roleId = async (org: { id: string }, key: string) => {
    const roles = await client.get<{ id: string; key: string; orgId: string | null }[]>(
      `/roles?key=${encodeURIComponent(key)}&limit=100`,
      org.id,
    );
    const role = roles.find((r) => r.key === key && r.orgId === org.id);
    if (!role) throw new FixtureRefusal(`role ${key} is missing in organization ${org.id}`);
    return role.id;
  };

  try {
    await client.login(inputs.operatorEmail, inputs.operatorPassword);
    log(`signed in as ${inputs.operatorEmail} (correlation ${client.correlationId})`);

    // Organizations (each with its system roles and default workspace).
    let { state, plan } = await inspect();
    for (const step of plan) {
      if (step.kind !== 'create-organization') continue;
      const spec = ORGANIZATIONS[step.org];
      const reseller = state.resellers[spec.reseller]!;
      const created = await client.post<{ id: string }>('/organizations', {
        name: spec.name,
        slug: spec.slug,
        resellerId: reseller.id,
      });
      log(`organization ${spec.slug} created (${created.id}) under ${reseller.slug}`);
    }

    // The markup-bearing team, in A1's default workspace.
    ({ state, plan } = await inspect());
    if (has(plan, 'create-team')) {
      const org = state.orgs[TEAM.org]!;
      const created = await client.post<{ id: string }>(
        '/teams',
        { workspaceId: org.defaultWorkspaceId, name: TEAM.name },
        org.id,
      );
      log(`team created in ${org.slug}/default (${created.id})`);
    }

    // Users, each with its first grant as the initial role.
    ({ state, plan } = await inspect());
    const target = (ref: UserRef, index: number) => {
      const grant = USERS[ref].grants[index]!;
      const org = state.orgs[grant.org]!;
      return { grant, org, scopeId: grant.scopeType === 'team' ? state.team!.id : org.id };
    };
    for (const step of plan) {
      if (step.kind !== 'create-user') continue;
      const { grant, org, scopeId } = target(step.user, 0);
      const created = await client.post<{ id: string }>(
        '/users',
        {
          email: USERS[step.user].email,
          initialRole: {
            roleId: await roleId(org, grant.roleKey),
            scopeType: grant.scopeType,
            scopeId,
          },
        },
        org.id,
      );
      log(
        `user ${USERS[step.user].email} created (${created.id}) with ${grant.roleKey} at ${grant.scopeType}`,
      );
    }

    // Every remaining grant, through the role-assignment API.
    ({ state, plan } = await inspect());
    for (const step of plan) {
      if (step.kind !== 'grant') continue;
      const { grant, org, scopeId } = target(step.user, step.index);
      await client.post(
        '/role-assignments',
        {
          userId: state.users[step.user]!.id,
          roleId: await roleId(org, grant.roleKey),
          scopeType: grant.scopeType,
          scopeId,
        },
        org.id,
      );
      log(
        `granted ${grant.roleKey} at ${grant.scopeType} in ${org.slug} to ${USERS[step.user].email}`,
      );
    }
  } finally {
    // The session is ended even when a step failed, so repeated runs never
    // accumulate live sessions.
    try {
      await client.logout();
      log('signed out');
    } finally {
      await api.close();
    }
  }
}

async function verify(db: Database, inputs: FixtureInputs, credentials: CredentialService) {
  const inspection = await inspectFixture(db, inputs, credentials);
  refuseOn(inspection);
  if (inspection.plan.length > 0) {
    throw new FixtureRefusal(
      `verification failed: still missing ${inspection.plan.map((s) => s.kind).join(', ')}`,
    );
  }
  const { state } = inspection;
  const problems: string[] = [];
  for (const ref of ORG_REFS) {
    const [row] = (
      await db.execute(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = ${state.orgs[ref]!.id}`,
      )
    ).rows as { n: number }[];
    if (!row || row.n < 1)
      problems.push(`no audit record exists for organization ${ORGANIZATIONS[ref].slug}`);
  }
  const markup = (
    await db.execute(
      sql`SELECT count(*)::int AS n FROM audit_logs
           WHERE action = 'team.created' AND resource_id = ${state.team!.id}
             AND scope_type = 'team' AND team_id = ${state.team!.id}
             AND org_id = ${state.orgs[TEAM.org]!.id} AND after ->> 'name' = ${TEAM.name}`,
    )
  ).rows as { n: number }[];
  if (!markup[0] || markup[0].n < 1)
    problems.push('the markup-bearing team.created audit record is missing');
  if (problems.length > 0) {
    throw new FixtureRefusal(
      `verification failed (the fixture cannot re-create audit evidence; reset it):\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
  return state;
}

export async function runDevFixture(
  env: NodeJS.ProcessEnv,
  log: Log = () => undefined,
): Promise<FixtureManifest> {
  const inputs = await resolveFixtureInputs(env);
  const credentials = new CredentialService(argon2Config(env) as never);
  const lifecycle = new UserLifecycleService(credentials);

  const pool = createPool({
    connectionString: inputs.adminUrl,
    max: 2,
    applicationName: FIXTURE_NAME,
  });
  const db = createDatabase(pool);
  try {
    const initial = await inspectFixture(db, inputs, credentials);
    refuseOn(initial);
    const outcome = initial.plan.length === 0 ? 'unchanged' : 'created';

    if (outcome === 'created') {
      log(`plan: ${initial.plan.map((s) => s.kind).join(', ')}`);
      if (has(initial.plan, 'bootstrap-operator')) {
        const audit: AuditWriter = ownerAuditWriter();
        await db.transaction((tx) =>
          runBootstrap(tx, {
            email: inputs.operatorEmail,
            password: inputs.operatorPassword,
            credentials,
            users: lifecycle,
            audit,
          }),
        );
        log(`platform administrator ${inputs.operatorEmail} bootstrapped`);
      }
      if (has(initial.plan, 'create-reseller')) {
        const id = await createFixtureReseller(db);
        log(`reseller ${RESELLERS.B.slug} created (${id}) — owner-level exception`);
      }
      const apiKinds: PlanStep['kind'][] = [
        'create-organization',
        'create-team',
        'create-user',
        'grant',
      ];
      if (initial.plan.some((s) => apiKinds.includes(s.kind))) {
        await apiPhases(db, inputs, credentials, log);
      }
      const pending = await inspectFixture(db, inputs, credentials);
      refuseOn(pending);
      for (const step of pending.plan) {
        if (step.kind !== 'activate-user') continue;
        await activateFixtureUser(
          db,
          lifecycle,
          pending.state.users[step.user]!.id,
          inputs.userPassword,
        );
        log(`credential set for ${USERS[step.user].email} — owner-level exception`);
      }
    }

    const state = await verify(db, inputs, credentials);
    const logical = digestLines(await fixtureLines(db, { withIds: false }));
    const identity = digestLines(await fixtureLines(db, { withIds: true }));
    const org = (ref: OrgRef) => ({
      id: state.orgs[ref]!.id,
      slug: ORGANIZATIONS[ref].slug,
      reseller: ORGANIZATIONS[ref].reseller,
      defaultWorkspaceId: state.orgs[ref]!.defaultWorkspaceId!,
    });
    return {
      fixture: FIXTURE_NAME,
      version: FIXTURE_VERSION,
      outcome,
      fingerprint: { logical, identity },
      resellers: {
        A: { id: state.resellers.A!.id, slug: RESELLERS.A.slug },
        B: { id: state.resellers.B!.id, slug: RESELLERS.B.slug },
      },
      organizations: { A1: org('A1'), A2: org('A2'), B1: org('B1') },
      team: {
        id: state.team!.id,
        org: TEAM.org,
        workspaceId: state.team!.workspaceId,
        name: TEAM.name,
      },
      users: Object.fromEntries(
        USER_REFS.map((ref) => [
          ref,
          {
            id: state.users[ref]!.id,
            email: USERS[ref].email,
            grants: USERS[ref].grants.map((g) => grantKey(USERS[ref].email, g)),
          },
        ]),
      ) as FixtureManifest['users'],
      operator: { id: state.operator.userId!, email: inputs.operatorEmail },
      credentials: { passwordReference: inputs.userPasswordReference },
    };
  } finally {
    await pool.end();
  }
}
