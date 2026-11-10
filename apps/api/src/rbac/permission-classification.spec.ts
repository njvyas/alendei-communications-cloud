import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  ALL_PERMISSION_KEYS,
  API_SURFACE_PERMISSION_KEYS,
  DELEGABLE_TENANT_SYSTEM_ROLES,
  PERMISSIONS,
  PERMISSION_ALLOWED_SCOPES,
  PERMISSION_CLASS,
  PERMISSION_CLASSES,
  PLATFORM_ONLY_PERMISSIONS,
  PLATFORM_ROLE_DEFINITIONS,
  PLATFORM_ROLE_KEYS,
  SCOPE_TYPES,
  SUPER_ADMIN_PERMISSIONS,
  TENANT_CONTENT_PERMISSIONS,
  TENANT_READ_PERMISSIONS,
  TENANT_ROLE_DEFINITIONS,
  TENANT_ROLE_KEYS,
  grantConfers,
  isTenantContentPermission,
  permissionAllowedAt,
} from '@acc/contracts';
import type { AuthPrincipal, PermissionKey, RoleGrant, ScopeType } from '@acc/contracts';

import { creatorAuthorityFromGrants } from '../auth/auth.guard';
import { PermissionEvaluator } from '../auth/permission-evaluator.service';

/**
 * ADR-015 R-5 (HIGH-4) and the contract half of R-6 — the permission
 * classification, the per-permission allowed-scope sets, and the one predicate
 * every authority computation applies (`grantConfers`).
 *
 * The database half (the projection, `fn_validate_role_permission` and the
 * reverse-race guards) is proven in `permission-classification.sec-spec.ts`;
 * the delegation in `role-assignment-delegation.sec-spec.ts`.
 */

/** The eight ADR-014 §6 keys and their table, verbatim. */
const ADR_014_SECTION_6: Readonly<Record<string, readonly ScopeType[]>> = {
  'contacts.read': ['organization', 'workspace'],
  'contacts.manage': ['organization', 'workspace'],
  'templates.read': ['organization'],
  'templates.manage': ['organization'],
  'suppressions.read': ['organization'],
  'suppressions.manage': ['organization'],
  'messages.read': ['organization', 'workspace'],
  'messages.send': ['organization', 'workspace'],
};

/** The 37 keys that existed before ADR-015 (HEAD `ae1b023`). None may be narrowed. */
const PRE_ADR_015_KEYS = [
  'organizations.read',
  'organizations.create',
  'organizations.update',
  'workspaces.read',
  'workspaces.create',
  'workspaces.update',
  'teams.read',
  'teams.create',
  'teams.update',
  'users.read',
  'users.invite',
  'users.update',
  'users.disable',
  'users.reactivate',
  'roles.read',
  'roles.create',
  'roles.update',
  'roles.delete',
  'role_assignments.read',
  'role_assignments.grant',
  'role_assignments.revoke',
  'permissions.read',
  'api_keys.read',
  'api_keys.create',
  'api_keys.revoke',
  'sessions.read',
  'sessions.revoke',
  'audit.read',
  'resellers.read',
  'resellers.update',
  'providers.read',
  'providers.manage',
  'providers.test_send',
  'platform.tenants.read',
  'platform.tenants.manage',
  'platform.roles.assign',
  'platform.audit.read',
] as const;

/**
 * The four Phase 7 keys (PR 7-1, DECISIONS.md §1zi): classification and scopes as approved
 * (DP-1). Inert on the HTTP surface until a later Phase 7 PR adds their routes.
 */
const PHASE_7_KEYS: Readonly<Record<string, { cls: string; scopes: readonly ScopeType[] }>> = {
  'billing.read': { cls: 'tenant_content', scopes: ['organization'] },
  'billing.manage': { cls: 'tenancy_administration', scopes: ['platform'] },
  'pricing.read': { cls: 'platform_catalogue', scopes: ['platform'] },
  'pricing.manage': { cls: 'platform_catalogue', scopes: ['platform'] },
};

const DELEGATE = 'platform.roles.delegate_tenant';
const SUPPORT_READ = 'platform.support.read';
const sorted = (xs: readonly string[]) => [...xs].sort();
const roleDefinition = (key: string) =>
  [...PLATFORM_ROLE_DEFINITIONS, ...TENANT_ROLE_DEFINITIONS].find((r) => r.key === key)!;

describe('permission classification (ADR-015 R-5)', () => {
  it('classifies every key exactly once, into one of the four classes and no other', () => {
    expect(sorted(Object.keys(PERMISSION_CLASS))).toEqual(sorted(ALL_PERMISSION_KEYS));
    expect(sorted(Object.keys(PERMISSION_ALLOWED_SCOPES))).toEqual(sorted(ALL_PERMISSION_KEYS));
    expect([...PERMISSION_CLASSES]).toEqual([
      'platform',
      'platform_catalogue',
      'tenancy_administration',
      'tenant_content',
    ]);
    for (const key of ALL_PERMISSION_KEYS) {
      expect(PERMISSION_CLASSES).toContain(PERMISSION_CLASS[key]);
    }
  });

  it('has exactly the 37 pre-ADR-015 keys, delegate_tenant, platform.support.read, the eight ADR-014 §6 keys, the four Phase 7 keys, the two Phase 8B keys and the two Phase 8A-2 keys', () => {
    expect(ALL_PERMISSION_KEYS).toHaveLength(55);
    expect(sorted(ALL_PERMISSION_KEYS)).toEqual(
      sorted([
        ...PRE_ADR_015_KEYS,
        DELEGATE,
        SUPPORT_READ,
        ...Object.keys(ADR_014_SECTION_6),
        ...Object.keys(PHASE_7_KEYS),
        'campaigns.read',
        'campaigns.manage',
        'contacts.import',
        'contacts.export',
      ]),
    );
  });

  it('classifies and scopes the four Phase 7 keys as approved (DP-1)', () => {
    for (const [key, { cls, scopes }] of Object.entries(PHASE_7_KEYS)) {
      expect([key, PERMISSION_CLASS[key as PermissionKey]]).toEqual([key, cls]);
      expect([key, [...PERMISSION_ALLOWED_SCOPES[key as PermissionKey]]]).toEqual([key, scopes]);
    }
    // billing.read is organization-only: never platform, reseller, workspace or team.
    for (const forbidden of ['platform', 'reseller', 'workspace', 'team'] as const) {
      expect(permissionAllowedAt('billing.read', forbidden)).toBe(false);
    }
    // The platform keys confer nothing below the platform.
    for (const key of ['billing.manage', 'pricing.read', 'pricing.manage']) {
      for (const scope of ['reseller', 'organization', 'workspace', 'team'] as const) {
        expect([key, scope, permissionAllowedAt(key, scope)]).toEqual([key, scope, false]);
      }
    }
  });

  it('platform ⇔ the platform. domain; providers.* is the catalogue; the §6 keys are content; the rest is tenancy administration', () => {
    for (const key of ALL_PERMISSION_KEYS) {
      const expected = key.startsWith('platform.')
        ? 'platform'
        : key.startsWith('providers.')
          ? 'platform_catalogue'
          : key in ADR_014_SECTION_6
            ? 'tenant_content'
            : key in PHASE_7_KEYS
              ? PHASE_7_KEYS[key]!.cls
              : key.startsWith('campaigns.') ||
                  key === 'contacts.import' ||
                  key === 'contacts.export'
                ? 'tenant_content'
                : 'tenancy_administration';
      expect(`${key}=${PERMISSION_CLASS[key]}`).toBe(`${key}=${expected}`);
    }
    expect(sorted(TENANT_CONTENT_PERMISSIONS)).toEqual(
      sorted([
        ...Object.keys(ADR_014_SECTION_6),
        'billing.read',
        'campaigns.read',
        'campaigns.manage',
        'contacts.import',
        'contacts.export',
      ]),
    );
  });

  it('pins the eight content keys to the ADR-014 §6 scope sets — never platform, reseller or team', () => {
    for (const [key, scopes] of Object.entries(ADR_014_SECTION_6)) {
      expect([key, [...PERMISSION_ALLOWED_SCOPES[key as PermissionKey]]]).toEqual([key, scopes]);
      for (const forbidden of ['platform', 'reseller', 'team'] as const) {
        expect(permissionAllowedAt(key, forbidden)).toBe(false);
      }
    }
  });

  it('narrows none of the 37 existing keys: platform.* is {platform}, every other is all five scopes', () => {
    for (const key of PRE_ADR_015_KEYS) {
      const expected = key.startsWith('platform.') ? ['platform'] : [...SCOPE_TYPES];
      expect([key, [...PERMISSION_ALLOWED_SCOPES[key]]]).toEqual([key, expected]);
    }
    expect([...PERMISSION_ALLOWED_SCOPES[DELEGATE]]).toEqual(['platform']);
  });

  it('lists every scope set in canonical hierarchy order (the order the database stores)', () => {
    for (const key of ALL_PERMISSION_KEYS) {
      const scopes = [...PERMISSION_ALLOWED_SCOPES[key]];
      expect(scopes).toEqual(SCOPE_TYPES.filter((s) => scopes.includes(s)));
    }
  });

  it('isTenantContentPermission and permissionAllowedAt fail closed on unknown keys', () => {
    expect(isTenantContentPermission('contacts.read')).toBe(true);
    expect(isTenantContentPermission('users.read')).toBe(false);
    expect(isTenantContentPermission('unknown.permission')).toBe(false);
    expect(permissionAllowedAt('unknown.permission', 'organization')).toBe(false);
    expect(permissionAllowedAt('users.read', 'team')).toBe(true);
  });
});

describe('role definitions under R-5 and R-6', () => {
  it('alendei_super_admin holds the whole catalogue minus tenant content — 42 keys, delegate_tenant included', () => {
    const superAdmin = roleDefinition(PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN);
    expect(sorted(superAdmin.permissions)).toEqual(
      sorted(
        ALL_PERMISSION_KEYS.filter(
          (k) =>
            !(k in ADR_014_SECTION_6) &&
            k !== 'billing.read' &&
            !k.startsWith('campaigns.') &&
            k !== 'contacts.import' &&
            k !== 'contacts.export',
        ),
      ),
    );
    expect(superAdmin.permissions).toHaveLength(42);
    expect(superAdmin.permissions).toEqual(
      expect.arrayContaining(['billing.manage', 'pricing.read', 'pricing.manage']),
    );
    expect(superAdmin.permissions).not.toContain('billing.read');
    expect(superAdmin.permissions).toContain(DELEGATE);
    expect(superAdmin.permissions).toContain(SUPPORT_READ);
    expect(sorted(SUPER_ADMIN_PERMISSIONS)).toEqual(sorted(superAdmin.permissions));
  });

  it('no platform role definition carries a tenant-content key', () => {
    for (const role of PLATFORM_ROLE_DEFINITIONS) {
      expect([role.key, role.permissions.filter(isTenantContentPermission)]).toEqual([
        role.key,
        [],
      ]);
    }
  });

  it('org_admin carries exactly the tenant-content keys (eight §6 keys, billing.read, campaigns.read, campaigns.manage, contacts.import, contacts.export); no other tenant role carries any', () => {
    const content = (key: string) =>
      sorted(roleDefinition(key).permissions.filter(isTenantContentPermission));
    expect(content(TENANT_ROLE_KEYS.ORG_ADMIN)).toEqual(
      sorted([
        'contacts.read',
        'contacts.manage',
        'templates.read',
        'templates.manage',
        'suppressions.read',
        'suppressions.manage',
        'messages.read',
        'messages.send',
        'billing.read',
        'campaigns.read',
        'campaigns.manage',
        'contacts.import',
        'contacts.export',
      ]),
    );
    for (const role of TENANT_ROLE_DEFINITIONS.filter(
      (r) => r.key !== TENANT_ROLE_KEYS.ORG_ADMIN,
    )) {
      expect([role.key, role.permissions.filter(isTenantContentPermission)]).toEqual([
        role.key,
        [],
      ]);
    }
    expect(TENANT_READ_PERMISSIONS.filter(isTenantContentPermission)).toEqual([]);
  });

  it('every seeded role is eligible for each permission it carries (role scopes ⊆ permission scopes)', () => {
    for (const role of [...PLATFORM_ROLE_DEFINITIONS, ...TENANT_ROLE_DEFINITIONS]) {
      for (const permission of role.permissions) {
        const allowed = PERMISSION_ALLOWED_SCOPES[permission] as readonly ScopeType[];
        expect([
          role.key,
          permission,
          role.allowedScopeTypes.every((s) => allowed.includes(s)),
        ]).toEqual([role.key, permission, true]);
      }
    }
  });

  it('support gains only pricing.read (DP-2); reseller_admin is unchanged; neither holds delegate_tenant', () => {
    expect(roleDefinition(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT).permissions).not.toContain(DELEGATE);
    expect(roleDefinition(PLATFORM_ROLE_KEYS.RESELLER_ADMIN).permissions).not.toContain(DELEGATE);
    expect(sorted(roleDefinition(PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT).permissions)).toEqual(
      sorted([
        ...TENANT_READ_PERMISSIONS,
        'api_keys.read',
        'sessions.read',
        'audit.read',
        'resellers.read',
        'platform.tenants.read',
        'platform.audit.read',
        'platform.support.read',
        'pricing.read',
      ]),
    );
    expect(roleDefinition(PLATFORM_ROLE_KEYS.RESELLER_ADMIN).permissions).toHaveLength(18);
  });

  it('delegate_tenant is platform-only; the delegable set is exactly [org_admin]', () => {
    expect(PERMISSIONS.PLATFORM_ROLES_DELEGATE_TENANT).toBe(DELEGATE);
    expect(PLATFORM_ONLY_PERMISSIONS).toContain(DELEGATE);
    expect(PERMISSION_CLASS[DELEGATE]).toBe('platform');
    expect([...DELEGABLE_TENANT_SYSTEM_ROLES]).toEqual(['org_admin']);
    expect(Object.isFrozen(DELEGABLE_TENANT_SYSTEM_ROLES)).toBe(true);
  });

  it('the API surface is the catalogue minus the four inert Phase 7 keys (51 keys)', () => {
    expect(
      sorted(ALL_PERMISSION_KEYS.filter((k) => !API_SURFACE_PERMISSION_KEYS.includes(k))),
    ).toEqual(sorted(Object.keys(PHASE_7_KEYS)));
    expect(API_SURFACE_PERMISSION_KEYS).toContain(DELEGATE);
    expect(API_SURFACE_PERMISSION_KEYS).toHaveLength(51);
  });
});

describe('grantConfers: the evaluator and the API-key path apply the allowed-scope sets', () => {
  const grant = (scopeType: ScopeType, permissions: string[], scopeId: string | null = 'x') =>
    ({
      roleId: `r-${scopeType}`,
      roleKey: `k-${scopeType}`,
      scopeType,
      scopeId: scopeType === 'platform' ? null : scopeId,
      orgId: ['organization', 'workspace', 'team'].includes(scopeType) ? 'org-1' : null,
      permissions,
    }) satisfies RoleGrant;
  const principal = (roles: RoleGrant[]): AuthPrincipal =>
    ({
      actorType: 'user',
      userId: 'u',
      apiKeyId: null,
      sessionId: null,
      tenant: { orgId: 'org-1', workspaceId: null, resellerId: null, isPlatformAdmin: false },
      roles,
      permissions: [...new Set(roles.flatMap((r) => r.permissions))],
      authMethod: 'password',
      authenticatedAt: new Date(),
      authorizedOrganizationIds: ['org-1'],
      organizationStatus: 'active',
      inactiveOrganizations: {},
    }) as unknown as AuthPrincipal;
  const evaluator = new PermissionEvaluator();
  const atOrg = {
    scope: { scopeType: 'organization' as const, scopeId: 'org-1' },
    chain: { resellerId: 'res-1', orgId: 'org-1', workspaceId: null, teamId: null },
  };

  it('a content key confers nothing through a platform or reseller grant, whatever its role carries', () => {
    expect(grantConfers(grant('platform', ['contacts.read']), 'contacts.read')).toBe(false);
    expect(grantConfers(grant('reseller', ['contacts.read'], 'res-1'), 'contacts.read')).toBe(
      false,
    );
    expect(grantConfers(grant('team', ['contacts.read']), 'contacts.read')).toBe(false);
    expect(grantConfers(grant('organization', ['contacts.read']), 'contacts.read')).toBe(true);
    expect(grantConfers(grant('workspace', ['templates.read']), 'templates.read')).toBe(false);
  });

  it('the evaluator refuses a content key on a platform grant and on a reseller grant covering the target', () => {
    for (const g of [
      grant('platform', ['contacts.read', 'users.read']),
      grant('reseller', ['contacts.read', 'users.read'], 'res-1'),
    ]) {
      const p = principal([g]);
      // The grant covers the organization — the non-content key proves it.
      expect(evaluator.allows({ principal: p, permission: 'users.read', target: atOrg })).toBe(
        true,
      );
      expect(evaluator.allows({ principal: p, permission: 'contacts.read', target: atOrg })).toBe(
        false,
      );
    }
  });

  it('support selecting an organization cannot use a content key through its platform grant', () => {
    const support = principal([grant('platform', [...TENANT_READ_PERMISSIONS, 'messages.read'])]);
    expect(
      evaluator.allows({ principal: support, permission: 'organizations.read', target: atOrg }),
    ).toBe(true);
    expect(
      evaluator.allows({ principal: support, permission: 'messages.read', target: atOrg }),
    ).toBe(false);
  });

  it('an organization grant carrying a content key still confers it at the organization (positive control)', () => {
    const member = principal([grant('organization', ['contacts.read'], 'org-1')]);
    expect(
      evaluator.allows({ principal: member, permission: 'contacts.read', target: atOrg }),
    ).toBe(true);
  });

  it('a platform.* key confers nothing through a non-platform grant', () => {
    expect(grantConfers(grant('reseller', [DELEGATE], 'res-1'), DELEGATE)).toBe(false);
    expect(grantConfers(grant('organization', [DELEGATE], 'org-1'), DELEGATE)).toBe(false);
    expect(grantConfers(grant('platform', [DELEGATE]), DELEGATE)).toBe(true);
  });

  it('creatorAuthorityFromGrants ignores a content key on a platform or reseller creator grant', () => {
    const binding = { scopeType: 'organization' as const, scopeId: 'org-1' };
    const chain = { resellerId: 'res-1', orgId: 'org-1', workspaceId: null, teamId: null };
    expect(
      sorted(
        creatorAuthorityFromGrants(
          [
            grant('platform', ['contacts.read', 'users.read']),
            grant('reseller', ['messages.send', 'workspaces.read'], 'res-1'),
          ],
          binding,
          chain,
        ),
      ),
    ).toEqual(['users.read', 'workspaces.read']);
    // Positive control: an organization creator grant does confer it.
    expect(
      creatorAuthorityFromGrants(
        [grant('organization', ['contacts.read'], 'org-1')],
        binding,
        chain,
      ),
    ).toEqual(['contacts.read']);
  });
});

describe('the message keys in Phase 3.3 are referenced only by the messages module', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..');
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return path.endsWith('.ts') && !/\.spec\.ts$/.test(path) ? [path] : [];
    });

  it('apps/api/src references messages keys only within the messages module', () => {
    const pattern = new RegExp(
      ['messages\\.read', 'messages\\.send', 'PERMISSIONS\\.MESSAGES_', '\\bP\\.MESSAGES_'].join(
        '|',
      ),
    );
    const hits = sources(join(ROOT, 'apps/api/src'))
      .filter((path) => pattern.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path));
    // ACC Batch 2 (owner decision, 21-Oct-2026): messages.read is one of the
    // four tenant-content reads that admit a tenant operator to the channel
    // catalogue list — named by the route declaration and checked by
    // ProviderAccess.authorizeCatalogueRead. Read only; nothing else.
    // Usage reporting (owner-directed, 31-Oct-2026): GET /usage/messages counts
    // the messages a messages.read holder can already list, inside the messages
    // module. Read only; no new permission key.
    // Phase 7 PR 7-3 (owner approval 08-Nov-2026): the existing messages.send
    // check of POST /messages moved, unchanged, into the shared submission core's
    // authorization proof. No new permission key or check.
    expect(hits.sort()).toEqual([
      'apps/api/src/messages/messages.controller.ts',
      'apps/api/src/messages/messages.service.ts',
      'apps/api/src/messages/submission/submission-authorization.ts',
      'apps/api/src/messages/usage/message-usage.controller.ts',
      'apps/api/src/messages/usage/message-usage.service.ts',
      'apps/api/src/providers/channels.controller.ts',
      'apps/api/src/providers/provider-access.service.ts',
    ]);
  });
});
