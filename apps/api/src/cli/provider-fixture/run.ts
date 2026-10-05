/**
 * Phase 2.6 support — the provider-console fixture (`TESTING.md` §6v).
 *
 * Opt-in, after `fixture:dev`. Order of operations, each step deciding before
 * it writes:
 *
 *   1. The same environment gate and `SecretsPort` inputs as the Phase 1C.4a
 *      fixture (`dev-fixture/environment.ts`), before any connection is opened.
 *   2. Read-only inspection as the owner (`inspect.ts`): a missing prerequisite
 *      (the Phase 1C.4a platform administrator, the seeded `alendei_support`
 *      role) or any conflicting object aborts with nothing written.
 *   3. Nothing missing → a no-op.
 *   4. Otherwise: the fixture platform roles and the platform personas
 *      (`owner-operations.ts`, the two owner-level exceptions), then the
 *      providers through the real HTTP API of an in-process instance, signed in
 *      as the platform administrator — create, enable or drain, capabilities —
 *      and signed out.
 *   5. Verification: a fresh inspection must find nothing missing and nothing
 *      conflicting.
 */
import { createDatabase, createPool, type Database } from '@acc/db';
import type { AddressInfo } from 'node:net';

import { CredentialService } from '../../iam/credential.service';
import { UserLifecycleService } from '../../iam/user-lifecycle.service';
import { ownerAuditWriter } from '../bootstrap';
import { FixtureRefusal, resolveFixtureInputs } from '../dev-fixture/environment';
import { ProviderFixtureApiClient } from './api-client';
import { inspectProviderFixture, type ProviderInspection, type ProviderPlanStep } from './inspect';
import { createFixturePlatformRole, createPlatformPersona } from './owner-operations';
import {
  PERSONA_REFS,
  PERSONAS,
  PLATFORM_ROLES,
  PROVIDER_FIXTURE_NAME,
  PROVIDER_FIXTURE_VERSION,
  PROVIDER_REFS,
  PROVIDERS,
  ROLE_REFS,
  personaRoleKey,
  type FixtureRoleRef,
  type PersonaRef,
  type ProviderRef,
} from './topology';

export interface ProviderFixtureManifest {
  readonly fixture: string;
  readonly version: number;
  readonly outcome: 'created' | 'unchanged';
  readonly platformAdministrator: { readonly id: string; readonly email: string };
  readonly providers: Record<
    ProviderRef,
    { id: string; channel: string; name: string; status: string }
  >;
  readonly roles: Record<FixtureRoleRef, { id: string; key: string; permissions: string[] }>;
  readonly personas: Record<PersonaRef, { id: string; email: string; platformRole: string }>;
  /** Where the personas' password comes from — a variable name, never a value. */
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

function refuseOn(inspection: ProviderInspection): void {
  const problems = [...inspection.refusals, ...inspection.conflicts];
  if (problems.length > 0) {
    throw new FixtureRefusal(`nothing was changed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

/** The real application on an ephemeral loopback port; only its log level is changed. */
async function startApi(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const saved = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'error';
  try {
    const { createApp } = await import('../../app.factory');
    const { AppConfigService } = await import('../../config/app-config.service');
    const app = await createApp();
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    const prefix = app.get(AppConfigService).http.globalPrefix;
    return { baseUrl: `http://127.0.0.1:${port}/${prefix}`, close: () => app.close() };
  } finally {
    if (saved === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = saved;
  }
}

async function providerPhase(
  db: Database,
  operator: { email: string; password: string },
  plan: readonly ProviderPlanStep[],
  log: Log,
): Promise<void> {
  const api = await startApi();
  const client = new ProviderFixtureApiClient(api.baseUrl);
  try {
    await client.login(operator.email, operator.password);
    log(`signed in as ${operator.email} (correlation ${client.correlationId})`);
    const ids: Partial<Record<ProviderRef, string>> = {};
    const idOf = async (ref: ProviderRef) => {
      if (ids[ref]) return ids[ref];
      const inspection = await inspectProviderFixture(db, operator.email);
      refuseOn(inspection);
      return (ids[ref] = inspection.state.providers[ref]!.id);
    };
    const channels = await client.get<{ id: string; code: string }[]>('/channels?limit=100');
    for (const step of plan) {
      if (step.kind === 'create-provider') {
        const spec = PROVIDERS[step.provider];
        const channel = channels.find((c) => c.code === spec.channel)!;
        const created = await client.post<{ id: string }>('/providers', {
          channelId: channel.id,
          name: spec.name,
          adapterKey: 'simulator',
        });
        ids[step.provider] = created.id;
        log(`provider "${spec.name}" created (${created.id}), disabled`);
      } else if (step.kind === 'transition') {
        await client.post(`/providers/${await idOf(step.provider)}/${step.action}`);
        log(`provider "${PROVIDERS[step.provider].name}": ${step.action}`);
      } else if (step.kind === 'replace-capabilities') {
        await client.put(`/providers/${await idOf(step.provider)}/capabilities`, {
          capabilities: PROVIDERS[step.provider].capabilities,
        });
        log(`provider "${PROVIDERS[step.provider].name}": capabilities set`);
      }
    }
  } finally {
    // The session is ended even when a step failed.
    try {
      await client.logout();
      log('signed out');
    } finally {
      await api.close();
    }
  }
}

export async function runProviderFixture(
  env: NodeJS.ProcessEnv,
  log: Log = () => undefined,
): Promise<ProviderFixtureManifest> {
  const inputs = await resolveFixtureInputs(env);
  const credentials = new CredentialService(argon2Config(env) as never);
  const lifecycle = new UserLifecycleService(credentials);
  const audit = ownerAuditWriter();

  const pool = createPool({
    connectionString: inputs.adminUrl,
    max: 2,
    applicationName: PROVIDER_FIXTURE_NAME,
  });
  const db = createDatabase(pool);
  try {
    const initial = await inspectProviderFixture(db, inputs.operatorEmail);
    refuseOn(initial);
    const outcome = initial.plan.length === 0 ? 'unchanged' : 'created';

    if (outcome === 'created') {
      log(`plan: ${initial.plan.map((s) => s.kind).join(', ')}`);
      const roleIds: Partial<Record<FixtureRoleRef, string>> = {};
      for (const ref of ROLE_REFS) roleIds[ref] = initial.state.roles[ref]?.id;
      for (const step of initial.plan) {
        if (step.kind !== 'create-platform-role') continue;
        roleIds[step.role] = await createFixturePlatformRole(db, audit, step.role);
        log(`platform role ${PLATFORM_ROLES[step.role].key} created — owner-level exception`);
      }
      for (const step of initial.plan) {
        if (step.kind !== 'create-persona') continue;
        const role = PERSONAS[step.persona].role;
        const roleId =
          'fixture' in role ? roleIds[role.fixture]! : initial.state.seededRoles[role.seeded]!;
        await createPlatformPersona(
          db,
          lifecycle,
          audit,
          step.persona,
          roleId,
          inputs.userPassword,
        );
        log(
          `persona ${PERSONAS[step.persona].email} created with ${personaRoleKey(step.persona)} at platform — owner-level exception`,
        );
      }
      const apiSteps = initial.plan.filter(
        (s) =>
          s.kind === 'create-provider' ||
          s.kind === 'transition' ||
          s.kind === 'replace-capabilities',
      );
      if (apiSteps.length > 0) {
        await providerPhase(
          db,
          { email: inputs.operatorEmail, password: inputs.operatorPassword },
          apiSteps,
          log,
        );
      }
    }

    const final = await inspectProviderFixture(db, inputs.operatorEmail);
    refuseOn(final);
    if (final.plan.length > 0) {
      throw new FixtureRefusal(
        `verification failed: still missing ${final.plan.map((s) => s.kind).join(', ')}`,
      );
    }
    const { state } = final;
    return {
      fixture: PROVIDER_FIXTURE_NAME,
      version: PROVIDER_FIXTURE_VERSION,
      outcome,
      platformAdministrator: { id: state.operator!.id, email: state.operator!.email },
      providers: Object.fromEntries(
        PROVIDER_REFS.map((ref) => [
          ref,
          {
            id: state.providers[ref]!.id,
            channel: PROVIDERS[ref].channel,
            name: PROVIDERS[ref].name,
            status: state.providers[ref]!.status,
          },
        ]),
      ) as ProviderFixtureManifest['providers'],
      roles: Object.fromEntries(
        ROLE_REFS.map((ref) => [
          ref,
          {
            id: state.roles[ref]!.id,
            key: PLATFORM_ROLES[ref].key,
            permissions: [...PLATFORM_ROLES[ref].permissions],
          },
        ]),
      ) as ProviderFixtureManifest['roles'],
      personas: Object.fromEntries(
        PERSONA_REFS.map((ref) => [
          ref,
          {
            id: state.personas[ref]!.id,
            email: PERSONAS[ref].email,
            platformRole: personaRoleKey(ref),
          },
        ]),
      ) as ProviderFixtureManifest['personas'],
      credentials: { passwordReference: inputs.userPasswordReference },
    };
  } finally {
    await pool.end();
  }
}
