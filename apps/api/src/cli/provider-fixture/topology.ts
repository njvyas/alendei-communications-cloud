/**
 * Phase 2 provider-console fixture topology (`TESTING.md` §6v) — development and
 * test only, for the Phase 2.6 console and its browser tests (Gate D.6).
 *
 * An opt-in extension run **after** the Phase 1C.4a fixture (`fixture:dev`); it
 * never changes what that fixture created. Every object is identified by a
 * natural key, never by a generated id:
 *
 *   PROVIDERS (created through the real API by the platform administrator)
 *   ├─ SMS   "ACC Fixture SMS Primary"    active,   one capability
 *   ├─ SMS   "ACC Fixture SMS Secondary"  draining
 *   └─ Email "ACC Fixture Email"          disabled
 *
 *   PLATFORM PERSONAS (owner-level, as the bootstrap makes its platform grant)
 *   ├─ providers-reader@…   fixture role: providers.read
 *   ├─ providers-tester@…   fixture role: providers.read + providers.test_send
 *   └─ platform-support@…   seeded alendei_support (no providers.* — refused)
 *
 * The platform administrator is the Phase 1C.4a operator. No persona holds
 * `providers.manage`, `alendei_super_admin`, or any tenant or reseller grant.
 */
import { PERMISSIONS, PLATFORM_ROLE_KEYS, type ChannelCode } from '@acc/contracts';

import { FIXTURE_EMAIL_DOMAIN } from '../dev-fixture/topology';

export const PROVIDER_FIXTURE_NAME = 'acc-provider-fixture';
export const PROVIDER_FIXTURE_VERSION = 1;

/** Sent on every API request of the extension, and therefore on the audit rows it causes. */
export const PROVIDER_FIXTURE_USER_AGENT = `${PROVIDER_FIXTURE_NAME}/${PROVIDER_FIXTURE_VERSION} (Phase 2.6)`;

/** The `actor_label` of the owner-level audit rows (cf. `platform_bootstrap`). */
export const PROVIDER_FIXTURE_ACTOR_LABEL = 'provider_fixture';

export type ProviderRef = 'smsPrimary' | 'smsSecondary' | 'email';
export type FixtureStatus = 'active' | 'draining' | 'disabled';

export const PROVIDERS: Readonly<
  Record<
    ProviderRef,
    {
      readonly channel: ChannelCode;
      readonly name: string;
      readonly status: FixtureStatus;
      readonly capabilities: readonly { readonly key: string; readonly value: unknown }[];
    }
  >
> = Object.freeze({
  smsPrimary: {
    channel: 'sms',
    name: 'ACC Fixture SMS Primary',
    status: 'active',
    capabilities: [{ key: 'max_segments', value: 10 }],
  },
  smsSecondary: {
    channel: 'sms',
    name: 'ACC Fixture SMS Secondary',
    status: 'draining',
    capabilities: [],
  },
  email: { channel: 'email', name: 'ACC Fixture Email', status: 'disabled', capabilities: [] },
});

export type FixtureRoleRef = 'reader' | 'tester';

/** Fixture-owned platform roles: platform roles have no API (D22), so these are owner-level. */
export const PLATFORM_ROLES: Readonly<
  Record<
    FixtureRoleRef,
    { readonly key: string; readonly name: string; readonly permissions: readonly string[] }
  >
> = Object.freeze({
  reader: {
    key: 'acc_fixture_providers_reader',
    name: 'ACC Fixture Providers Reader',
    permissions: [PERMISSIONS.PROVIDERS_READ],
  },
  tester: {
    key: 'acc_fixture_providers_tester',
    name: 'ACC Fixture Providers Tester',
    permissions: [PERMISSIONS.PROVIDERS_READ, PERMISSIONS.PROVIDERS_TEST_SEND].sort(),
  },
});

export type PersonaRef = 'providersReader' | 'providersTester' | 'platformSupport';

export const PERSONAS: Readonly<
  Record<
    PersonaRef,
    { readonly email: string; readonly role: { fixture: FixtureRoleRef } | { seeded: string } }
  >
> = Object.freeze({
  providersReader: {
    email: `providers-reader@${FIXTURE_EMAIL_DOMAIN}`,
    role: { fixture: 'reader' },
  },
  providersTester: {
    email: `providers-tester@${FIXTURE_EMAIL_DOMAIN}`,
    role: { fixture: 'tester' },
  },
  platformSupport: {
    email: `platform-support@${FIXTURE_EMAIL_DOMAIN}`,
    role: { seeded: PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT },
  },
});

export const PROVIDER_REFS = Object.keys(PROVIDERS) as ProviderRef[];
export const ROLE_REFS = Object.keys(PLATFORM_ROLES) as FixtureRoleRef[];
export const PERSONA_REFS = Object.keys(PERSONAS) as PersonaRef[];

/** The role key a persona's single platform grant must carry. */
export function personaRoleKey(ref: PersonaRef): string {
  const role = PERSONAS[ref].role;
  return 'fixture' in role ? PLATFORM_ROLES[role.fixture].key : role.seeded;
}
