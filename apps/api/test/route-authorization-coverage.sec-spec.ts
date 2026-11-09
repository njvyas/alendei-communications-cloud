/**
 * §6n case 30 — every scoped route performs exactly one target-scope check,
 * asserted against the registered route table rather than by review
 * (Phase 1B.5.7).
 *
 * The point of asserting against the container is that review does not scale and
 * does not run in CI. A new controller ships with a route nobody annotated,
 * every existing test still passes, and the hole stays invisible until someone
 * reads the file. Here every registered controller method is enumerated from
 * Nest's own metadata, so a route that declares nothing fails this suite the
 * moment it is registered.
 *
 * Every route must fall into exactly one of three categories, and the
 * categories are deliberately narrow:
 *
 *   `@Public()`            — no authentication at all: login, refresh, health,
 *                            metrics. Additionally allow-listed by path here, so
 *                            marking a new route public is not by itself enough
 *                            to pass unnoticed.
 *   `@RequiresPermission`  — a target-scope check is required, and the
 *                            permission is named on the route.
 *   `@AuthorizationExempt` — authenticated, but about the caller rather than a
 *                            tenant resource, with the reason recorded on the
 *                            route itself.
 *
 * A route in none of them is a defect, and a route in more than one is a
 * confusion. Both are assertions below.
 */
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { INestApplication, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { IS_PUBLIC } from '../src/auth/public.decorator';
import {
  AUTHZ_EXEMPT,
  REQUIRES_PERMISSION,
  type RequiredPermission,
} from '../src/auth/requires-permission.decorator';

interface RegisteredRoute {
  readonly method: string;
  readonly path: string;
  readonly controller: string;
  readonly handler: string;
  readonly isPublic: boolean;
  readonly required: RequiredPermission | undefined;
  readonly exempt: string | undefined;
}

/** Paths deliberately reachable without authentication, listed once, here. */
const PUBLIC_PATHS = new Set([
  'GET /api/v1/domains/resolve',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'GET /health',
  'GET /health/live',
  'GET /health/ready',
  'GET /metrics',
  // Phase 5.0 PR-C: the provider webhook ingress. Providers authenticate by the opaque
  // ingress key in the path and the adapter-owned signature over the raw body — never by a
  // session or API key. Disabled (404) unless DELIVERY_WEBHOOKS_ENABLED.
  'POST /api/v1/webhooks/providers/:providerKey',
  // Phase 5.0 PR-E (owner-approved contract correction, 07-Nov-2026): the header form of the
  // same ingress — the key in `X-Acc-Webhook-Ingress-Key` instead of the path, the same
  // pipeline; exactly one form per request. Disabled (404) unless DELIVERY_WEBHOOKS_ENABLED.
  'POST /api/v1/webhooks/providers',
]);

const PREFIXED = new Set(['metrics', 'health', 'health/live', 'health/ready']);

describe('§6n case 30 — route authorization coverage', () => {
  let app: INestApplication;
  let routes: RegisteredRoute[];

  beforeAll(async () => {
    // Its own application rather than the shared harness, with `DiscoveryModule`
    // added: enumerating the container is a test concern, and importing it into
    // the production module to satisfy a test would be the tail wagging the dog.
    // The controllers and their metadata are the real ones.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, DiscoveryModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    routes = enumerate();
  }, 90_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  function enumerate(): RegisteredRoute[] {
    const discovery = app.get(DiscoveryService);
    const scanner = new MetadataScanner();
    const reflector = app.get(Reflector);
    const found: RegisteredRoute[] = [];

    for (const wrapper of discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;

      const controllerPath = String(Reflect.getMetadata(PATH_METADATA, metatype) ?? '');
      const prototype = Object.getPrototypeOf(instance) as object;

      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = (instance as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;

        const methodPath = Reflect.getMetadata(PATH_METADATA, handler);
        if (methodPath === undefined) continue; // not a route

        const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
        const segments = [controllerPath, String(methodPath)]
          .map((s) => s.replace(/^\/|\/$/g, ''))
          .filter((s) => s.length > 0);
        const joined = segments.join('/');
        const path = PREFIXED.has(joined) ? `/${joined}` : `/api/v1/${joined}`;

        found.push({
          method: RequestMethod[verb] ?? 'GET',
          path,
          controller: metatype.name,
          handler: name,
          // Handler first, then the class — the same precedence `AuthGuard`
          // applies. `@Public()` sits on the class for health and metrics, and a
          // handler-only lookup would report those routes as silent, which is
          // the assertion failing for the wrong reason.
          isPublic: reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler, metatype]) === true,
          required: reflector.getAllAndOverride<RequiredPermission>(REQUIRES_PERMISSION, [
            handler,
            metatype,
          ]),
          exempt: reflector.getAllAndOverride<string>(AUTHZ_EXEMPT, [handler, metatype]),
        });
      }
    }
    return found;
  }

  const describeRoute = (r: RegisteredRoute) =>
    `${r.method} ${r.path} (${r.controller}.${r.handler})`;

  // ===========================================================================
  it('enumerates the registered routes — the assertion is not vacuous', () => {
    // If this ever returned nothing, every coverage assertion below would pass
    // for the wrong reason.
    expect(routes.length).toBeGreaterThanOrEqual(15);
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    expect(keys).toContain('GET /api/v1/roles');
    expect(keys).toContain('POST /api/v1/role-assignments');
    expect(keys).toContain('GET /api/v1/users');
    expect(keys).toContain('POST /api/v1/users/:id/disable');
    expect(keys).toContain('POST /api/v1/users/:id/reactivate');
    expect(keys).toContain('GET /api/v1/api-keys');
    expect(keys).toContain('POST /api/v1/api-keys');
    expect(keys).toContain('POST /api/v1/api-keys/:id/revoke');
    expect(keys).toContain('GET /api/v1/audit-logs');
    expect(keys).toContain('GET /api/v1/audit-logs/:id');
    expect(keys).toContain('POST /api/v1/ws/ticket');
    expect(keys).toContain('GET /api/v1/auth/me/authorization');
    expect(keys).toContain('GET /health');
    for (const route of [
      'GET /api/v1/organizations',
      'POST /api/v1/organizations',
      'GET /api/v1/organizations/:id',
      'PATCH /api/v1/organizations/:id',
      'POST /api/v1/organizations/:id/suspend',
      'POST /api/v1/organizations/:id/reactivate',
      'POST /api/v1/organizations/:id/close',
    ]) {
      expect(keys).toContain(route);
    }
  });

  it('every route declares its authorization posture — none is silent', () => {
    const silent = routes.filter(
      (r) => !r.isPublic && r.required === undefined && r.exempt === undefined,
    );
    // The whole of case 30. A new endpoint cannot ship unprotected by omission:
    // it must say it is public, name a permission, or record why it is exempt.
    expect(silent.map(describeRoute)).toEqual([]);
  });

  it('no route declares more than one posture', () => {
    const confused = routes.filter(
      (r) =>
        [r.isPublic, r.required !== undefined, r.exempt !== undefined].filter(Boolean).length > 1,
    );
    expect(confused.map(describeRoute)).toEqual([]);
  });

  it('the public routes are exactly the allow-listed ones', () => {
    const publicKeys = routes
      .filter((r) => r.isPublic)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(publicKeys).toEqual([...PUBLIC_PATHS].sort());
  });

  it('every exemption records a reason', () => {
    /**
     * **Self-referential routes only**, and the allow-list is named rather than
     * open so that adding a controller to it is a visible decision.
     *
     * The test is not "is this route about identity" — that is a judgement a
     * future author could talk themselves into. It is "is the *subject* of this
     * route the authenticated principal itself, such that there is no target
     * resource to check". `AuthController` qualifies because `/auth/me*` and
     * `/auth/sessions*` are about the caller. `WsTicketController` qualifies for
     * the same reason and no other: the ticket it mints carries the caller's own
     * resolved scope and confers nothing beyond it, and the authority a
     * connection exercises is enforced at subscription time against that
     * recorded scope. An exemption anywhere else is a scoped route that has
     * quietly opted out.
     */
    const selfScopedControllers = new Set(['AuthController', 'WsTicketController']);
    for (const route of routes.filter((r) => r.exempt !== undefined)) {
      expect(route.exempt!.length).toBeGreaterThan(20);
      expect(selfScopedControllers.has(route.controller)).toBe(true);
    }
  });

  it('every deferred target records why it cannot be static', () => {
    const deferred = routes.filter((r) => r.required?.target === 'deferred');
    // The two grant/revoke routes, and the reason is argued on each rather than
    // assumed: a deferral with no stated cause is indistinguishable from a
    // handler that simply did not want to be checked.
    expect(deferred.length).toBeGreaterThan(0);
    for (const route of deferred) {
      expect(route.required!.because ?? '').not.toHaveLength(0);
    }
  });

  it('every scoped route names a permission from the catalogue', () => {
    const catalogue = new Set(Object.values(PERMISSIONS_CATALOGUE));
    for (const route of routes.filter((r) => r.required !== undefined)) {
      expect(catalogue.has(String(route.required!.permission))).toBe(true);
    }
  });

  it('records the coverage table, so a change to it is visible in review', () => {
    const table = routes
      .map((r) => {
        const posture = r.isPublic
          ? 'public'
          : r.required
            ? `requires ${String(r.required.permission)} @ ${r.required.target}`
            : `exempt`;
        return `${r.method} ${r.path} — ${posture}`;
      })
      .sort();
    // Counted rather than snapshotted: a snapshot of every path turns an
    // intentional new endpoint into a failing test, which trains people to
    // update snapshots without reading them.
    expect(table.length).toBe(routes.length);

    // Counted by posture rather than snapshotted path-by-path: a full snapshot
    // turns every intentional new endpoint into a failing test, which trains
    // people to update snapshots without reading them. A count moving is a
    // question worth asking; a path changing usually is not.
    const scoped = routes.filter((r) => r.required !== undefined);
    const exempt = routes.filter((r) => r.exempt !== undefined);
    const open = routes.filter((r) => r.isPublic);
    // Phase 1C.1a added seven organization routes, all scoped and all
    // `deferred` (the organization is named in the path or the body, never
    // selected): 24 → 31 scoped, 6 → 13 deferred. Phase 1C.1b added twelve
    // workspace and team routes, all scoped: the workspace list, create,
    // archive and restore target the selected organization; the two workspace
    // `:id` routes and all six team routes target a workspace or team resolved
    // from the database: 31 → 43 scoped, 13 → 21 deferred. Phase 1C.2 added
    // the three administrator session routes under `/users/:id/sessions`, all
    // scoped at the selected organization (the per-grant F-9 coverage is an
    // additional check, not a different target): 43 → 46 scoped; and the
    // identity route `POST /auth/sessions/revoke-all`: 6 → 7 exempt. Phase 2.1
    // added the ten provider/channel catalogue routes, all scoped and all
    // `deferred` — every one authorizes at platform scope, never at the selected
    // organization (ADR-013 F-3): 46 → 56 scoped. Phase 2.2 added
    // `POST /providers/:id/test-send`, scoped and deferred the same way: 56 → 57.
    // Phase 2.3 added `POST /providers/:id/health-check`, `POST
    // /providers/:id/health` and `GET /providers/:id/health`, scoped and
    // deferred the same way: 57 → 60. The Gate D.3 remediation added `GET` and
    // `PUT /provider-circuit-policy`, scoped and deferred the same way: 60 → 62.
    // Phase 3.1 added 27 scoped routes (contacts, consent, templates, suppressions): 62 → 89.
    // Phase 3.2 added 6 scoped routes (organization provider assignments): 89 → 95.
    // Phase 3.3 added 2 scoped routes (messages send and get): 95 → 97.
    // UI readiness (20-Oct-2026) added `GET /messages`, scoped at the request
    // organization like the other message routes: 97 → 98.
    // Usage reporting (31-Oct-2026) added `GET /usage/messages`, scoped at the
    // request organization under messages.read: 98 → 99.
    // Phase 4 U12 (31-Oct-2026) added 14 scoped routes (11 domains/branding/challenge,
    // 3 customer onboarding): 99 → 113 scoped; and 1 public route (`GET /domains/resolve`): 6 → 7 open.
    // Phase 4 U13.1 (01-Nov-2026) added 7 scoped reseller routes: 113 → 120 scoped.
    // Phase 4 U13.2 (01-Nov-2026) added 1 scoped route (`GET /organizations/:id/lifecycle-history`): 120 → 121 scoped.
    // U13.3 (01-Nov-2026) added 5 read-only platform domain oversight routes: 121 → 126.
    // U13.4 (01-Nov-2026) added 4 platform operational support routes: 126 → 130.
    // Phase 5.0 PR-C added 3 platform ingress-key routes (key, enable, disable; target deferred,
    // platform catalogue): 130 → 133 scoped; and 1 public route (the webhook ingress): 7 → 8 open.
    // Phase 5.0 PR-E added the operator simulator trigger (platform providers.test_send, target
    // deferred): 133 → 134 scoped; and the ingress header form: 8 → 9 open.
    // Phase 8A added 2 scoped contact activities routes (workspace-scoped and direct; target deferred): 134 → 136 scoped.
    // Phase 8A-S added 5 scoped contact audience resolution routes (workspace-scoped resolve POST/GET, preview POST, direct resolve POST/GET; target deferred): 136 → 141 scoped.
    // Phase 7 PR 7-2 added 11 platform pricing catalogue routes (plans, versions, rules, activation,
    // provider cost rates, assignments; target deferred, platform scope): 141 → 152 scoped.
    // Phase 8B.1 added 6 scoped campaign routes (workspace-scoped CRUD and dispatch; target deferred): 152 → 158 scoped.
    // Phase 7 PR 7-6a added 3 tenant billing read routes (account, ledger, usage; billing.read at the
    // request organization, target deferred): 158 → 161 scoped.
    // Phase 7 PR 7-6b added the unknown-outcome register (platform billing.manage, target deferred): 161 → 162 scoped.
    // Phase 7 PR 7-6c added 5 operator-resolution routes (platform billing.manage, target deferred): 162 → 167 scoped.
    // Phase 8A PR 8A-1 added 6 saved segment routes (workspace-scoped CRUD and preview; target deferred): 167 → 173 scoped.
    // Phase 7 PR 7-6d-1 added 12 account-administration routes (platform billing.manage, target deferred): 173 → 185 scoped.
    // Phase 7 PR 7-6d-2 added the wallet recharge route (platform billing.manage, target deferred): 185 → 186 scoped.
    // Phase 8A PR 8A-2 added 3 contact import/export routes (workspace-scoped import and export; target deferred): 186 → 189 scoped.
    // Phase 8B.2 added 7 scoped campaign routes (preview, materialize, schedule, cancel, pause, resume, recipients): 189 → 196 scoped.
    expect(scoped.length).toBe(196);
    expect(exempt.length).toBe(7);
    expect(open.length).toBe(9);
    expect(scoped.length + exempt.length + open.length).toBe(routes.length);

    // Of the scoped routes, exactly the two grant/revoke handlers defer their
    // target; every other one is statically an organization.
    // The two grant/revoke handlers; the three API-key routes whose target is
    // the key's own stored binding scope (Phase 1B.6.2) or the binding named in
    // the body; and the audit-log detail route, whose target is the scope the
    // record was written at (Phase 1B.6.3). Phase 2.1's ten catalogue routes
    // all defer: each targets `platform`, never the selected organization
    // (ADR-013 F-3): 21 → 31; Phase 2.2's test-send: 31 → 32; Phase 2.3's
    // three health routes: 32 → 35; the two circuit-policy routes: 35 → 37.
    // Phase 3.1 added 27 scoped routes, all deferred: 37 → 64.
    // Phase 3.2 added 6 scoped routes, all deferred: 64 → 70.
    // Phase 3.3 added 2 scoped routes, all deferred: 70 → 72.
    // UI readiness added `GET /messages`, deferred like them: 72 → 73.
    // Usage reporting added `GET /usage/messages`, deferred the same way: 73 → 74.
    // Phase 4 U12 added 14 scoped routes, all deferred: 74 → 88.
    // Phase 4 U13.1 added 7 scoped reseller routes, all deferred: 88 → 95.
    // Phase 4 U13.2 added GET /organizations/:id/lifecycle-history, deferred: 95 → 96.
    // U13.3 added 5, all deferred: each targets `platform`, like the catalogue: 96 → 101.
    // U13.4 added 4 platform operational support routes, all deferred: 101 → 105.
    // Phase 5.0 PR-C added 3 ingress-key routes, each targeting `platform`: 105 → 108.
    // Phase 5.0 PR-E added the operator simulator trigger (deferred, platform catalogue): 108 → 109.
    // Phase 8A added 2 contact activities routes, each targeting deferred workspace context: 109 → 111.
    // Phase 8A-S added 5 contact audience resolution routes, each targeting deferred workspace context: 111 → 116.
    // Phase 7 PR 7-2 added 11 pricing catalogue routes, each targeting `platform`: 116 → 127.
    // Phase 8B.1 added 6 campaign routes, each targeting deferred workspace context: 127 → 133.
    // Phase 7 PR 7-6a added 3 tenant billing read routes, each targeting the deferred request organization: 133 → 136.
    // Phase 7 PR 7-6b added the unknown-outcome register, targeting the deferred platform scope: 136 → 137.
    // Phase 7 PR 7-6c added 5 operator-resolution routes, targeting the deferred platform scope: 137 → 142.
    // Phase 8A PR 8A-1 added 6 saved segment routes, targeting the deferred workspace: 142 → 148.
    // Phase 7 PR 7-6d-1 added 12 account-administration routes, targeting the deferred platform scope: 148 → 160.
    // Phase 7 PR 7-6d-2 added the wallet recharge route, targeting the deferred platform scope: 160 → 161.
    // Phase 8A PR 8A-2 added 3 contact import/export routes, targeting the deferred workspace: 161 → 164.
    // Phase 8B.2 added 7 campaign routes, each targeting deferred workspace context: 164 → 171.
    expect(scoped.filter((r) => r.required!.target === 'deferred').length).toBe(171);
  });
});

// Imported late so the catalogue assertion reads plainly above.
import { PERMISSIONS as PERMISSIONS_CATALOGUE } from '@acc/contracts';
