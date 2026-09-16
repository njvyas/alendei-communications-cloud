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
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'GET /health',
  'GET /health/live',
  'GET /health/ready',
  'GET /metrics',
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
    expect(keys).toContain('GET /api/v1/auth/me/authorization');
    expect(keys).toContain('GET /health');
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
    for (const route of routes.filter((r) => r.exempt !== undefined)) {
      expect(route.exempt!.length).toBeGreaterThan(20);
      // Identity endpoints only — an exemption anywhere else is a scoped route
      // that has quietly opted out.
      expect(route.controller).toBe('AuthController');
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
    expect(scoped.length).toBe(18);
    expect(exempt.length).toBe(5);
    expect(open.length).toBe(6);
    expect(scoped.length + exempt.length + open.length).toBe(routes.length);

    // Of the scoped routes, exactly the two grant/revoke handlers defer their
    // target; every other one is statically an organization.
    expect(scoped.filter((r) => r.required!.target === 'deferred').length).toBe(2);
  });
});

// Imported late so the catalogue assertion reads plainly above.
import { PERMISSIONS as PERMISSIONS_CATALOGUE } from '@acc/contracts';
